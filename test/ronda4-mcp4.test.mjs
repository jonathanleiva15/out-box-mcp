/**
 * Ronda 4 (2026-10-01), unidad mcp4 del repo out-box-mcp:
 *   1. El binario stdio corre sobre el SDK v2 de MCP (`@modelcontextprotocol/server`,
 *      zod 4) y el harness usa `@modelcontextprotocol/client`. Sin el SDK 1.x.
 *   2. `offset`/`maxChars` en outbox_pull del stdio (paridad con el remoto, opt-in).
 *   3. `idempotencyKey` en las respuestas EXITOSAS de las escrituras con dedupe.
 *   4. `createOnly` / `applyAttributes` en outbox_append (contrato del worker,
 *      handlers/daily.ts), 409 `daily_exists` e `ignoredAttributes`.
 *   5. Reglas de slug: JSON canónico del worker con fallback al port (slug-rules.mjs).
 * Corren contra dist/ (lo que se shipea).
 */
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { startHarness } from "./harness.mjs";
import { PORT, loadSlugRules, makeSlugRejectionReason, parseSlugRules, slugRulesCandidates } from "./slug-rules.mjs";
import { ignoredAttributesNotice, registerOutboxTools, withIdempotencyKey } from "../dist/tools.js";
import { OutboxApiError, OutboxClient, describeError, formatError } from "../dist/services/client.js";
import { ignoredAttributesNoticeEn, TOOL_TEXT_EN } from "../dist/tools-en.js";
import { PULL_CHUNK_DEFAULT, chunkEnd, sliceContent } from "../dist/pull-chunks.js";
import { SLUG_SCHEMA } from "../dist/schemas.js";
import { TOOLSETS } from "../dist/toolsets.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** Registro con un back falso (fetch inyectado). `routes[path](url, init)` → Response. */
function setup({ lang, routes = {}, pullChunks = true } = {}) {
  const calls = [];
  const fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ path: url.pathname, method: init?.method ?? "GET", body, headers });
    if (url.pathname === "/api/capabilities") {
      return Response.json({ features: { expectedVersion: true, idempotency: true, idempotencyEndpoints: ["publish", "dailyAppend"] } });
    }
    if (url.pathname === "/api/me") return Response.json({ user: "joni" });
    const r = routes[url.pathname];
    if (r) return r(url, init, body);
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  const client = new OutboxClient("outbox_test", { apiBase: "https://api.test", siteBase: "https://site.test", fetch });
  const tools = new Map();
  registerOutboxTools({ registerTool: (n, c, h) => tools.set(n, { c, h }) }, client, {
    toolsets: new Set(TOOLSETS),
    user: "joni",
    pullChunks,
    ...(lang ? { lang } : {}),
  });
  const call = async (name, args = {}) => {
    const t = tools.get(name);
    assert.ok(t, `tool ${name} no registrada`);
    return t.h(z.object(t.c.inputSchema).parse(args));
  };
  return { call, calls, tools };
}

const exportOf = (content, version = 4) => () =>
  new Response(content, { headers: { "content-type": "text/plain; charset=utf-8", "x-outbox-shell": "off", "x-outbox-version": String(version) } });

// ── 1. SDK v2 ────────────────────────────────────────────────────────────────

describe("SDK v2 de MCP (stdio)", () => {
  test("package.json: @modelcontextprotocol/server ^2 + client ^2 (dev), sin el SDK 1.x; Node >= 20", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    assert.match(pkg.dependencies["@modelcontextprotocol/server"], /^\^2\./);
    assert.match(pkg.devDependencies["@modelcontextprotocol/client"], /^\^2\./);
    assert.equal(pkg.dependencies["@modelcontextprotocol/sdk"], undefined, "el SDK 1.x no tiene que quedar como dependencia");
    assert.match(pkg.dependencies.zod, /^\^4\./);
    assert.equal(pkg.engines.node, ">=20", "el SDK v2 exige Node 20+");
    assert.equal(pkg.bin["outbox-mcp"], "dist/index.js", "el binario no cambia");
  });

  test("ningún fuente ni test importa el SDK 1.x", () => {
    const files = ["src/index.ts", "test/harness.mjs", "test/contract.test.mjs"];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), "utf8");
      assert.doesNotMatch(src, /@modelcontextprotocol\/sdk/, f);
    }
    const dist = readFileSync(join(ROOT, "dist", "index.js"), "utf8");
    assert.match(dist, /from "@modelcontextprotocol\/server"/);
    assert.match(dist, /from "@modelcontextprotocol\/server\/stdio"/);
  });

  describe("binario real por stdio", () => {
    let h;
    before(async () => {
      h = await startHarness();
    });
    after(async () => {
      await h.close();
    });
    beforeEach(() => h.reset());

    test("handshake era 2025 (initialize) con nombre y versión del server", () => {
      const v = h.client.getServerVersion();
      assert.equal(v.name, "outbox-mcp-server");
      assert.match(h.client.getNegotiatedProtocolVersion(), /^2025-/);
      assert.ok(h.client.getInstructions().length > 0, "las instructions siguen viajando");
    });

    test("argumentos inválidos → resultado isError (no error de protocolo), como con el SDK 1.x", async () => {
      const r = await h.call("outbox_pull", { slug: "../etc" });
      assert.equal(r.isError, true);
      assert.match(r.text, /Input validation error/);
      assert.equal(h.calls.length, 0, "no llega a la API");
    });

    test("tools/list: outbox_pull publica offset/maxChars con sus límites; outbox_append createOnly/applyAttributes", async () => {
      const { tools } = await h.client.listTools();
      const pull = tools.find((t) => t.name === "outbox_pull").inputSchema.properties;
      assert.equal(pull.offset.type, "integer");
      assert.equal(pull.offset.minimum, 0);
      assert.equal(pull.maxChars.minimum, 1000);
      assert.equal(pull.maxChars.maximum, 200000);
      const append = tools.find((t) => t.name === "outbox_append").inputSchema.properties;
      assert.equal(append.createOnly.type, "boolean");
      assert.equal(append.applyAttributes.type, "boolean");
    });

    test("outbox_pull por trozos de punta a punta por stdio", async () => {
      const doc = "a".repeat(2500);
      h.respond = (c) => (c.path === "/api/u/jonathan/nota/export" ? { text: doc, contentType: "text/plain" } : undefined);
      const r = await h.call("outbox_pull", { slug: "nota", maxChars: 1000 });
      assert.equal(r.isError, false);
      assert.equal(r.structured.offset, 0);
      assert.equal(r.structured.nextOffset, 1000);
      assert.equal(r.structured.complete, false);
      assert.equal(r.content.at(-1).text.length, 1000);
    });
  });
});

// ── 2. outbox_pull por trozos ───────────────────────────────────────────────────

describe("outbox_pull · offset/maxChars (stdio)", () => {
  const DOC = "<p>" + "x".repeat(2494) + "</p>"; // 2501 chars

  test("sin offset ni maxChars: contenido COMPLETO como siempre (contrato aditivo)", async () => {
    const { call } = setup({ routes: { "/api/u/joni/nota/export": exportOf(DOC) } });
    const r = await call("outbox_pull", { slug: "nota" });
    assert.equal(r.content.at(-1).text, DOC);
    assert.equal("offset" in r.structuredContent, false);
    assert.equal("contentSha256" in r.structuredContent, false);
  });

  test("maxChars: trozos explícitos que juntos reconstruyen el contenido, mismo sha y versión", async () => {
    const { call } = setup({ routes: { "/api/u/joni/nota/export": exportOf(DOC, 9) } });
    const parts = [];
    let offset = 0;
    let guard = 0;
    for (;;) {
      const r = await call("outbox_pull", { slug: "nota", offset, maxChars: 1000 });
      assert.equal(r.isError, undefined);
      const s = r.structuredContent;
      assert.equal(s.offset, offset);
      assert.equal(s.totalChars, DOC.length);
      assert.equal(s.contentSha256, sha(DOC));
      assert.equal(s.version, 9);
      assert.equal(s.complete, false);
      const chunk = r.content.at(-1).text;
      assert.equal(chunk.length, s.length);
      assert.match(r.content.at(-2).text, /^LECTURA PARCIAL de joni\/nota: caracteres \d+-\d+ de 2501/);
      assert.match(r.content.at(-2).text, /NO re-publiques una lectura parcial/);
      assert.match(r.content.at(-2).text, /versión 9/);
      parts.push(chunk);
      if (s.nextOffset === null) {
        assert.match(r.content.at(-2).text, /Este es el último trozo/);
        break;
      }
      assert.match(r.content.at(-2).text, new RegExp(`offset=${s.nextOffset}`));
      offset = s.nextOffset;
      assert.ok(++guard < 10);
    }
    assert.equal(parts.length, 3);
    assert.equal(parts.join(""), DOC);
  });

  test("trozo que cubre todo: texto IDÉNTICO al de siempre y complete:true", async () => {
    const { call } = setup({ routes: { "/api/u/joni/nota/export": exportOf(DOC) } });
    const plain = await call("outbox_pull", { slug: "nota" });
    const r = await call("outbox_pull", { slug: "nota", maxChars: 5000 });
    assert.deepEqual(r.content, plain.content);
    assert.equal(r.structuredContent.complete, true);
    assert.equal(r.structuredContent.nextOffset, null);
    assert.equal(r.structuredContent.contentSha256, sha(DOC));
  });

  test("solo offset: maxChars default (60000)", async () => {
    const big = "y".repeat(PULL_CHUNK_DEFAULT + 10);
    const { call } = setup({ routes: { "/api/u/joni/nota/export": exportOf(big) } });
    const r = await call("outbox_pull", { slug: "nota", offset: 0 });
    assert.equal(r.structuredContent.length, PULL_CHUNK_DEFAULT);
    assert.equal(r.structuredContent.nextOffset, PULL_CHUNK_DEFAULT);
  });

  test("offset fuera del contenido → invalid_offset accionable", async () => {
    const { call } = setup({ routes: { "/api/u/joni/nota/export": exportOf(DOC) } });
    const r = await call("outbox_pull", { slug: "nota", offset: DOC.length });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.error.code, "invalid_offset");
    assert.equal(r.structuredContent.error.totalChars, DOC.length);
    assert.match(r.structuredContent.error.fix, /offset=0/);
  });

  test("file_path + offset/maxChars → conflicting_args sin leer la página", async () => {
    const calls = [];
    const client = new OutboxClient("outbox_test", {
      apiBase: "https://api.test",
      fetch: async (input) => {
        calls.push(String(input));
        return Response.json({ user: "joni" });
      },
    });
    const tools = new Map();
    registerOutboxTools({ registerTool: (n, c, h) => tools.set(n, { c, h }) }, client, {
      toolsets: new Set(["core"]),
      user: "joni",
      pullChunks: true,
      files: { read: async () => ({ path: "x", data: new Uint8Array() }), write: async () => ({ path: "x", bytes: 0 }) },
    });
    const t = tools.get("outbox_pull");
    const r = await t.h(z.object(t.c.inputSchema).parse({ slug: "nota", file_path: "nota.html", maxChars: 1000 }));
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.error.code, "conflicting_args");
    assert.equal(calls.length, 0);
  });

  test("página ajena: el aviso de terceros sigue ANTES del trozo", async () => {
    const { call } = setup({ routes: { "/api/u/otra/nota/export": exportOf(DOC) } });
    const r = await call("outbox_pull", { slug: "nota", user: "otra", maxChars: 1000 });
    assert.match(r.content[0].text, /Contenido de terceros/);
    assert.equal(r.structuredContent.thirdParty, true);
  });

  test("lang en: cabecera PARTIAL READ (como el remoto)", async () => {
    const { call } = setup({ lang: "en", routes: { "/api/u/joni/nota/export": exportOf(DOC) } });
    const r = await call("outbox_pull", { slug: "nota", maxChars: 1000 });
    assert.match(r.content.at(-2).text, /^PARTIAL READ of joni\/nota: characters 0-1000 of 2501/);
    assert.match(r.content.at(-2).text, /offset=1000/);
  });

  test("no parte un par sustituto UTF-16", () => {
    const s = "a".repeat(999) + "😀" + "b";
    assert.equal(chunkEnd(s, 0, 1000), 999);
    const part = sliceContent(s, 0, 1000);
    assert.equal(part.length, 999);
    assert.equal(part.nextOffset, 999);
  });

  test("host sin pullChunks (el remoto): outbox_pull NO publica offset/maxChars (los suma su adaptador)", () => {
    const { tools } = setup({ pullChunks: false });
    const shape = tools.get("outbox_pull").c.inputSchema;
    assert.equal("offset" in shape, false);
    assert.equal("maxChars" in shape, false);
    assert.doesNotMatch(tools.get("outbox_pull").c.description, /Por trozos/);
  });

  test("EN: los params nuevos tienen texto en inglés", () => {
    assert.ok(TOOL_TEXT_EN.outbox_pull.params.offset);
    assert.ok(TOOL_TEXT_EN.outbox_pull.params.maxChars);
  });
});

// ── 3. idempotencyKey en respuestas exitosas ────────────────────────────────────

describe("idempotencyKey en las respuestas exitosas de escrituras", () => {
  const ok = (json) => () => Response.json(json);

  test("outbox_publish: devuelve la key del agente, la misma que viajó en el header", async () => {
    const { call, calls } = setup({ routes: { "/publish": ok({ ok: true, url: "https://site.test/joni/x", version: 2 }) } });
    const r = await call("outbox_publish", { slug: "x", html: "<p>x</p>", model: "m", idempotencyKey: "pub-key-123" });
    const data = JSON.parse(r.content[0].text);
    assert.equal(data.idempotencyKey, "pub-key-123");
    assert.equal(data.version, 2, "el resto del JSON no cambia");
    assert.equal(calls.find((c) => c.path === "/publish").headers["idempotency-key"], "pub-key-123");
    assert.equal(Object.keys(data).at(-1), "idempotencyKey", "va AL FINAL del JSON (aditivo)");
  });

  test("outbox_publish sin key: devuelve la que generó el MCP (= header)", async () => {
    const { call, calls } = setup({ routes: { "/publish": ok({ ok: true }) } });
    const r = await call("outbox_publish", { slug: "x", html: "<p>x</p>", model: "m" });
    const data = JSON.parse(r.content[0].text);
    assert.match(data.idempotencyKey, /^[0-9a-f-]{36}$/);
    assert.equal(calls.find((c) => c.path === "/publish").headers["idempotency-key"], data.idempotencyKey);
  });

  test("outbox_append, outbox_publish_from_template, outbox_create_comment y outbox_create_suggestion", async () => {
    const { call, calls } = setup({
      routes: {
        "/api/u/joni/journal/append": ok({ blockId: "blk_1", version: 3 }),
        "/api/publish-from-template": ok({ ok: true }),
        "/api/u/joni/nota/comments": ok({ id: "c1", status: "open" }),
      },
    });
    const cases = [
      ["outbox_append", { slug: "journal", html: "<p>x</p>" }, "/api/u/joni/journal/append"],
      ["outbox_publish_from_template", { template: "t", data: {}, slug: "r", model: "m" }, "/api/publish-from-template"],
      ["outbox_create_comment", { slug: "nota", body: "hola" }, "/api/u/joni/nota/comments"],
      ["outbox_create_suggestion", { slug: "nota", exact: "a", replacement: "b" }, "/api/u/joni/nota/comments"],
    ];
    for (const [name, args, path] of cases) {
      const before = calls.length;
      const r = await call(name, args);
      assert.equal(r.isError, undefined, name);
      const data = JSON.parse(r.content[0].text);
      const sent = calls.slice(before).find((c) => c.path === path);
      assert.ok(data.idempotencyKey, `${name}: falta idempotencyKey`);
      assert.equal(data.idempotencyKey, sent.headers["idempotency-key"], name);
    }
  });

  test("withIdempotencyKey: no pisa una key del back ni toca arrays/strings", () => {
    assert.deepEqual(withIdempotencyKey({ idempotencyKey: "del-back" }, "mia"), { idempotencyKey: "del-back" });
    assert.deepEqual(withIdempotencyKey([1], "k"), [1]);
    assert.equal(withIdempotencyKey("ok", "k"), "ok");
    assert.equal(withIdempotencyKey(null, "k"), null);
  });

  test("escrituras SIN dedupe (set_visibility) no inventan una idempotencyKey", async () => {
    const { call } = setup({ routes: { "/api/u/joni/x/visibility": ok({ ok: true }) } });
    const r = await call("outbox_set_visibility", { slug: "x", visibility: "private" });
    assert.equal(JSON.parse(r.content[0].text).idempotencyKey, undefined);
  });
});

// ── 4. createOnly / applyAttributes / daily_exists / ignoredAttributes ──────────

describe("outbox_append · createOnly y applyAttributes (contrato worker ronda 4)", () => {
  const APPEND = "/api/u/joni/journal/append";

  test("los flags viajan solo si son true", async () => {
    const { call, calls } = setup({ routes: { [APPEND]: () => Response.json({ blockId: "b" }) } });
    await call("outbox_append", { slug: "journal", html: "<p>a</p>" });
    await call("outbox_append", { slug: "journal", html: "<p>b</p>", createOnly: true, applyAttributes: true, title: "T" });
    await call("outbox_append", { slug: "journal", html: "<p>c</p>", createOnly: false, applyAttributes: false });
    const bodies = calls.filter((c) => c.path === APPEND).map((c) => c.body);
    assert.equal("createOnly" in bodies[0], false);
    assert.equal("applyAttributes" in bodies[0], false);
    assert.equal(bodies[1].createOnly, true);
    assert.equal(bodies[1].applyAttributes, true);
    assert.equal("createOnly" in bodies[2], false, "false = default del worker: no se manda");
    assert.equal("applyAttributes" in bodies[2], false);
  });

  test("409 daily_exists → error estructurado no reintentable con existingDate y remedio", async () => {
    const { call } = setup({
      routes: {
        [APPEND]: () =>
          Response.json(
            { error: "daily_exists", message: "Ya existe un daily en journal.", user: "joni", slug: "journal", existingDate: "2026-09-30" },
            { status: 409 },
          ),
      },
    });
    const r = await call("outbox_append", { slug: "journal", html: "<p>x</p>", createOnly: true });
    assert.equal(r.isError, true);
    const err = r.structuredContent.error;
    assert.equal(err.code, "daily_exists");
    assert.equal(err.status, 409);
    assert.equal(err.retryable, false);
    assert.equal(err.existingDate, "2026-09-30");
    assert.match(err.fix, /SIN createOnly/);
    assert.match(err.fix, /otro slug/);
    assert.match(r.content[0].text, /^Error 409 \(daily_exists, último día 2026-09-30\): no reintentable\./);
  });

  test("describeError/formatError de daily_exists sin existingDate", () => {
    const e = new OutboxApiError(409, { error: "daily_exists" }, "/api/u/j/d/append");
    assert.equal(describeError(e).existingDate, undefined);
    assert.match(formatError(e), /^Error 409 \(daily_exists\): no reintentable/);
  });

  test("200 con ignoredAttributes → aviso aparte (ES) que pide NO repetir el append", async () => {
    const { call } = setup({
      routes: { [APPEND]: () => Response.json({ blockId: "b", version: 4, ignoredAttributes: ["visibility", "title"] }) },
    });
    const r = await call("outbox_append", { slug: "journal", html: "<p>x</p>", visibility: "public", title: "Nuevo" });
    assert.equal(r.content.length, 2);
    const notice = r.content[1].text;
    assert.match(notice, /NO aplicó visibility ni title/);
    assert.match(notice, /No repitas este append/);
    assert.match(notice, /outbox_set_visibility/);
    assert.match(notice, /applyAttributes:true/);
    assert.deepEqual(JSON.parse(r.content[0].text).ignoredAttributes, ["visibility", "title"]);
  });

  test("ignoredAttributes: solo nombres conocidos; vacío o basura → sin aviso; EN", () => {
    assert.equal(ignoredAttributesNotice({ ignoredAttributes: [] }), null);
    assert.equal(ignoredAttributesNotice({ ignoredAttributes: ["<script>", 3] }), null);
    assert.equal(ignoredAttributesNotice({}), null);
    const es = ignoredAttributesNotice({ ignoredAttributes: ["title", "x"] });
    assert.match(es, /NO aplicó title/);
    assert.doesNotMatch(es, /outbox_set_visibility/);
    const en = ignoredAttributesNotice({ ignoredAttributes: ["visibility"] }, "en");
    assert.equal(en, ignoredAttributesNoticeEn(["visibility"]));
    assert.match(en, /did NOT apply visibility/);
    assert.match(en, /Do not repeat this append/);
  });

  test("contrato con el handler del worker (si el monorepo está al lado): flags y 409", (t) => {
    const handler = join(ROOT, "..", "out-box", "worker", "src", "handlers", "daily.ts");
    let src;
    try {
      src = readFileSync(handler, "utf8");
    } catch {
      if (process.env.OUTBOX_REQUIRE_SIBLINGS === "1") throw new Error(`falta ${handler} y OUTBOX_REQUIRE_SIBLINGS=1`);
      t.skip("worker (out-box) no disponible junto al paquete");
      return;
    }
    assert.match(src, /readBoolFlag\(body\.createOnly\)/, "el worker dejó de leer createOnly del body");
    assert.match(src, /readBoolFlag\(body\.applyAttributes\)/, "el worker dejó de leer applyAttributes del body");
    assert.match(src, /jsonError\('daily_exists', 409/, "cambió el 409 de createOnly: actualizar client.ts");
    assert.match(src, /existingDate/, "el 409 daily_exists dejó de traer existingDate");
    assert.match(src, /ignoredAttributes/, "el 200 dejó de traer ignoredAttributes");
  });
});

// ── 5. Reglas de slug: JSON canónico con fallback ─────────────────────────────────

describe("reglas de slug · JSON canónico del worker con fallback al port", () => {
  const valid = (s) => SLUG_SCHEMA.safeParse(s).success;

  test("sin JSON: usa el port (que pasada2-contratos compara con lib/slug.ts)", () => {
    const dir = mkdtempSync(join(tmpdir(), "outbox-slug-"));
    try {
      const rules = loadSlugRules({}, join(dir, "mcp"));
      assert.equal(rules.source, "port");
      assert.equal(rules.suffixes, PORT.suffixes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("con JSON en la ruta del worker: lo consume (el port no se usa)", () => {
    const dir = mkdtempSync(join(tmpdir(), "outbox-slug-"));
    try {
      const lib = join(dir, "out-box", "worker", "src", "lib");
      const mcp = join(dir, "out-box-mcp");
      mkdirSync(lib, { recursive: true });
      mkdirSync(mcp, { recursive: true });
      writeFileSync(
        join(lib, "slug-rules.json"),
        JSON.stringify({
          reservedSlugSuffixes: ["Versions", "nuevo-sufijo"],
          reservedFirstSegments: ["daily"],
          reservedTails: [{ name: "DAILY_BLOCK_TAIL_RE", source: "(^|\\/)blocks\\/blk_[^/]*$", flags: "ig" }],
        }),
      );
      const rules = loadSlugRules({}, mcp);
      assert.equal(rules.source, "json");
      assert.equal(rules.file, slugRulesCandidates({}, mcp)[0]);
      const reason = makeSlugRejectionReason(rules, valid);
      assert.equal(reason("informe/nuevo-sufijo"), "reserved_slug", "una regla nueva del JSON se aplica sin tocar el port");
      assert.equal(reason("informe/versions"), "reserved_slug", "case-insensitive");
      assert.equal(reason("informe/stats"), null, "lo que el JSON no reserva, no se reserva");
      // flags sin g: el mismo slug da lo mismo en llamadas seguidas.
      assert.equal(reason("j/blocks/blk_1"), "reserved_slug");
      assert.equal(reason("j/blocks/blk_1"), "reserved_slug");
      assert.equal(reason("daily/hoy"), "reserved_slug");
      assert.equal(reason("_x/y"), "reserved_slug");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("alias de nombres y colas como objeto/strings", () => {
    const rules = parseSlugRules({
      RESERVED_SLUG_SUFFIXES: ["export"],
      RESERVED_SLUG_FIRST_SEGMENTS: ["daily"],
      tailPatterns: { COMMENT_ACTION_TAIL_RE: "(^|\\/)comments\\/[a-f0-9]+\\/(accept|discard|resolve)$" },
    });
    const reason = makeSlugRejectionReason(rules, valid);
    assert.equal(reason("a/comments/abc/accept"), "reserved_slug");
    assert.equal(reason("a/export"), "reserved_slug");
  });

  test("JSON con forma desconocida → error explícito (nunca reglas vacías que aceptan todo)", () => {
    assert.throws(() => parseSlugRules({ suffixes: [] }), /reservedSlugSuffixes/);
    assert.throws(() => parseSlugRules({ reservedSlugSuffixes: ["x"] }), /reservedFirstSegments/);
    assert.throws(() => parseSlugRules([]), /objeto JSON/);
  });

  test("OUTBOX_SLUG_RULES_JSON apuntando a un archivo inexistente → error", () => {
    assert.throws(() => loadSlugRules({ OUTBOX_SLUG_RULES_JSON: "/no/existe/slug-rules.json" }), /no existe/);
  });

  test("el port vigente coincide con el comportamiento de referencia (fallback)", () => {
    const reason = makeSlugRejectionReason(PORT, valid);
    assert.equal(reason("daily/2026-09-30"), "reserved_slug");
    assert.equal(reason("journal"), null);
    assert.equal(reason("reportes/stats", { folder: true }), null);
  });
});
