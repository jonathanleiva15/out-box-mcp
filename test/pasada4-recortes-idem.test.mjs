/**
 * Pasada 4 (2026-09-30), fixer del repo mcp:
 *  - outbox_get_blocks / outbox_read_comments recortaban por tamaño quedándose con los
 *    ítems MÁS VIEJOS (el back los devuelve en orden ascendente). Justo el bloque o
 *    comentario recién escrito, el que hay que verificar tras un timeout, desaparecía y
 *    el agente lo duplicaba. Ahora se conservan los más nuevos (`_truncated.dropped:
 *    'oldest'`), get_blocks omite el HTML si no entra (con `blockId` para pedir uno) y
 *    el hint nombra el remedio real de cada tool (no un `cursor` que no existe).
 *  - Si el agente no pasaba idempotencyKey, el MCP generaba una que nunca devolvía; el
 *    error de red le pedía reintentar "con el MISMO idempotencyKey". Ahora el error
 *    estructurado y el texto traen la clave que viajó en el header.
 *  - Invariantes cross-repo: helper que en CI (OUTBOX_REQUIRE_SIBLINGS=1) falla en vez
 *    de saltearse, y el workflow hace checkout de out-box como carpeta hermana.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { registerOutboxTools } from "../dist/tools.js";
import { OutboxApiError, OutboxClient, OutboxNetworkError, describeError, formatError } from "../dist/services/client.js";
import { TOOLSETS } from "../dist/toolsets.js";
import { fitJson } from "../dist/output.js";
import { buildInstructions } from "../dist/instructions.js";
import { requireSibling, siblingsRequired } from "./siblings.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

const LIMIT = 25000;

function blocks(n, htmlSize) {
  return Array.from({ length: n }, (_, i) => ({
    id: `blk_${i}`,
    ts: `2026-09-30T10:0${i % 10}:00.000Z`,
    label: `b${i}`,
    size: htmlSize,
    html: `<p>${"x".repeat(htmlSize)}</p>`,
  }));
}

function manifest(list) {
  return { user: "joni", slug: "journal", date: "2026-09-30", version: list.length, visibility: "private", blocks: list };
}

function setup({ routes = {}, fetchImpl, lang } = {}) {
  const sent = [];
  const fetch =
    fetchImpl ??
    (async (input, init) => {
      const url = new URL(String(input));
      sent.push({ url, init });
      if (url.pathname === "/api/me") return Response.json({ user: "joni" });
      if (url.pathname === "/api/capabilities") return Response.json({ features: {} });
      const r = routes[url.pathname];
      if (r) return r(url, init);
      return Response.json({ error: "not_found" }, { status: 404 });
    });
  const client = new OutboxClient("outbox_test", { apiBase: "https://api.test", siteBase: "https://site.test", fetch, sleep: async () => {} });
  const tools = new Map();
  registerOutboxTools({ registerTool: (n, c, h) => tools.set(n, { c, h }) }, client, {
    toolsets: new Set(TOOLSETS),
    user: "joni",
    ...(lang ? { lang } : {}),
  });
  const call = async (name, args) => {
    const t = tools.get(name);
    assert.ok(t, `tool ${name} no registrada`);
    return t.h(z.object(t.c.inputSchema).parse(args));
  };
  return { call, sent, tools };
}

// ── fitJson: arrays cronológicos ─────────────────────────────────────────────

describe("fitJson keep:'newest'", () => {
  test("8 bloques de 5 KB → se conserva el último, no el primero", () => {
    const data = manifest(blocks(8, 5000));
    const parsed = JSON.parse(fitJson(data, LIMIT, { keep: "newest" }));
    const ids = parsed.blocks.map((b) => b.id);
    assert.ok(ids.includes("blk_7"), `el bloque más nuevo tiene que quedar (quedaron ${ids})`);
    assert.ok(!ids.includes("blk_0"));
    assert.equal(parsed._truncated.dropped, "oldest");
    assert.equal(parsed._truncated.total, 8);
    assert.equal(parsed.blocks.length, parsed._truncated.shown);
  });

  test("hint propio en vez del de cursor", () => {
    const data = { comments: Array.from({ length: 300 }, (_, i) => ({ id: `c${i}`, body: "y".repeat(200) })) };
    const parsed = JSON.parse(fitJson(data, 5000, { keep: "newest", hint: "usá status" }));
    assert.equal(parsed._truncated.hint, "usá status");
    assert.equal(parsed.comments.at(-1).id, "c299");
  });

  test("sin opciones sigue conservando el prefijo (listados paginados con cursor)", () => {
    const data = { posts: Array.from({ length: 100 }, (_, i) => ({ i, s: "x".repeat(50) })) };
    const parsed = JSON.parse(fitJson(data, 2000));
    assert.equal(parsed.posts[0].i, 0);
    assert.equal(parsed._truncated.dropped, undefined);
  });
});

// ── outbox_get_blocks ────────────────────────────────────────────────────────

describe("outbox_get_blocks: recorte por tamaño", () => {
  const route = (list) => ({ "/api/u/joni/journal/blocks": () => Response.json(manifest(list)) });

  test("8 bloques de 5 KB → el último blockId aparece y el JSON es válido", async () => {
    const { call } = setup({ routes: route(blocks(8, 5000)) });
    const r = await call("outbox_get_blocks", { slug: "journal" });
    assert.equal(r.isError, undefined);
    assert.ok(r.content[0].text.length <= LIMIT);
    const out = JSON.parse(r.content[0].text);
    const ids = out.blocks.map((b) => b.id);
    assert.ok(ids.includes("blk_7"), `falta el bloque más nuevo: ${ids}`);
    assert.equal(ids.length, 8, "sin HTML entran todos los bloques");
    assert.equal(out.htmlOmitted, true);
    assert.ok(out.blocks.every((b) => !("html" in b)));
    assert.match(out.note, /blockId/);
    assert.doesNotMatch(r.content[0].text, /cursor/);
  });

  test("un solo bloque de 30 KB ya no devuelve JSON roto", async () => {
    const { call } = setup({ routes: route(blocks(1, 30000)) });
    const r = await call("outbox_get_blocks", { slug: "journal" });
    const out = JSON.parse(r.content[0].text);
    assert.equal(out.blocks[0].id, "blk_0");
    assert.equal(out.blocks[0].size, 30000);
  });

  test("si entra completo, sale igual que antes (con html)", async () => {
    const { call } = setup({ routes: route(blocks(2, 100)) });
    const out = JSON.parse((await call("outbox_get_blocks", { slug: "journal" })).content[0].text);
    assert.equal(out.blocks.length, 2);
    assert.ok(out.blocks[1].html.includes("x"));
    assert.equal(out.htmlOmitted, undefined);
  });

  test("blockId → ese bloque con su HTML completo aunque pase el límite", async () => {
    const { call } = setup({ routes: route(blocks(3, 40000)) });
    const r = await call("outbox_get_blocks", { slug: "journal", blockId: "blk_2" });
    assert.equal(r.isError, undefined);
    const out = JSON.parse(r.content[0].text);
    assert.equal(out.block.id, "blk_2");
    assert.equal(out.block.html.length, 40007);
    assert.equal(out.blocks, undefined);
    assert.equal(out.totalBlocks, 3);
  });

  test("blockId inexistente → error block_not_found", async () => {
    const { call } = setup({ routes: route(blocks(2, 10)) });
    const r = await call("outbox_get_blocks", { slug: "journal", blockId: "blk_9" });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.error.code, "block_not_found");
  });

  test("includeHtml:false → solo metadata aunque entre", async () => {
    const { call } = setup({ routes: route(blocks(2, 10)) });
    const out = JSON.parse((await call("outbox_get_blocks", { slug: "journal", includeHtml: false })).content[0].text);
    assert.ok(out.blocks.every((b) => !("html" in b) && typeof b.size === "number"));
  });

  test("miles de bloques sin HTML que igual no entran → se conservan los más nuevos", async () => {
    const list = blocks(2000, 1).map((b) => ({ ...b, label: "l".repeat(60) }));
    const { call } = setup({ routes: route(list) });
    const r = await call("outbox_get_blocks", { slug: "journal" });
    assert.ok(r.content[0].text.length <= LIMIT);
    const out = JSON.parse(r.content[0].text);
    assert.equal(out.blocks.at(-1).id, "blk_1999");
    assert.equal(out._truncated.dropped, "oldest");
    assert.doesNotMatch(out._truncated.hint, /cursor/);
  });
});

// ── outbox_read_comments ─────────────────────────────────────────────────────

describe("outbox_read_comments: recorte por tamaño", () => {
  test("el comentario más nuevo queda en la respuesta", async () => {
    const comments = Array.from({ length: 200 }, (_, i) => ({
      id: `cmt_${i}`,
      kind: "comment",
      commenter: "joni",
      commenterType: "agent",
      body: "z".repeat(300),
      status: "open",
      createdAt: `2026-09-30T00:00:${String(i % 60).padStart(2, "0")}Z`,
    }));
    const { call } = setup({
      routes: {
        "/api/u/joni/nota/comments": () => Response.json({ postOwner: "joni", slug: "nota", visibility: "private", comments }),
      },
    });
    const r = await call("outbox_read_comments", { slug: "nota" });
    assert.ok(r.content[0].text.length <= LIMIT);
    const out = JSON.parse(r.content[0].text);
    assert.equal(out.comments.at(-1).id, "cmt_199");
    assert.equal(out._truncated.dropped, "oldest");
    assert.match(out._truncated.hint, /status/);
    assert.doesNotMatch(out._truncated.hint, /cursor/);
  });
});

// ── idempotencyKey generada por el MCP ───────────────────────────────────────

function timeoutError() {
  const e = new Error("The operation was aborted due to timeout");
  e.name = "TimeoutError";
  return e;
}

describe("idempotencyKey generada: viaja en el error de escritura", () => {
  test("outbox_append con fetch que siempre aborta → el error trae la clave del header", async () => {
    const keys = [];
    const fetchImpl = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/me") return Response.json({ user: "joni" });
      if (url.pathname === "/api/capabilities") {
        return Response.json({ features: { idempotency: true, idempotencyEndpoints: ["dailyAppend"] } });
      }
      keys.push(init.headers["idempotency-key"]);
      throw timeoutError();
    };
    const { call } = setup({ fetchImpl });
    const r = await call("outbox_append", { slug: "journal", html: "<p>hola</p>" });
    assert.equal(r.isError, true);
    assert.equal(keys.length, 2, "un reintento interno con la misma clave");
    assert.ok(keys[0] && keys[0] === keys[1]);
    const err = r.structuredContent.error;
    assert.equal(err.code, "network_timeout");
    assert.equal(err.idempotencyKey, keys[0]);
    assert.ok(r.content[0].text.includes(`idempotencyKey=${keys[0]}`), r.content[0].text);
    assert.ok(err.fix.includes(keys[0]));
  });

  test("outbox_create_comment sin dedupe del back: la clave igual se informa", async () => {
    let key;
    const fetchImpl = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/me") return Response.json({ user: "joni" });
      if (url.pathname === "/api/capabilities") return Response.json({ features: {} });
      key = init.headers["idempotency-key"];
      throw timeoutError();
    };
    const { call } = setup({ fetchImpl });
    const r = await call("outbox_create_comment", { slug: "nota", body: "hola" });
    assert.equal(r.structuredContent.error.idempotencyKey, key);
  });

  test("la clave del agente también se devuelve (y una lectura no trae ninguna)", async () => {
    const fetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/me") return Response.json({ user: "joni" });
      if (url.pathname === "/api/capabilities") return Response.json({ features: {} });
      throw timeoutError();
    };
    const { call } = setup({ fetchImpl });
    const w = await call("outbox_append", { slug: "journal", html: "<p>x</p>", idempotencyKey: "mi-clave-123" });
    assert.equal(w.structuredContent.error.idempotencyKey, "mi-clave-123");
    const rd = await call("outbox_get_blocks", { slug: "journal" });
    assert.equal(rd.structuredContent.error.idempotencyKey, undefined);
  });

  test("las instructions dicen dónde está la clave", () => {
    assert.match(buildInstructions(new Set(TOOLSETS), "https://site.test"), /el error de la escritura la trae en `idempotencyKey`/);
  });

  test("describeError/formatError: network error e idempotency_in_progress con clave", () => {
    const net = new OutboxNetworkError("timeout", "api.test", "/x", 1000, true, undefined, "k-1");
    assert.equal(describeError(net).idempotencyKey, "k-1");
    assert.match(formatError(net), /idempotencyKey=k-1/);
    const busy = new OutboxApiError(409, { error: "idempotency_in_progress" }, "/x", 3, "k-2");
    assert.equal(describeError(busy).idempotencyKey, "k-2");
    assert.match(describeError(busy).fix, /idempotencyKey=k-2/);
    // Sin clave, nada cambia.
    const plain = describeError(new OutboxNetworkError("timeout", "api.test", "/x", 1000, true));
    assert.equal(plain.idempotencyKey, undefined);
  });
});

// ── Invariantes cross-repo en CI ─────────────────────────────────────────────

describe("invariantes cross-repo: no se saltean en CI", () => {
  test("requireSibling: presente → true; ausente sin CI → skip; ausente con OUTBOX_REQUIRE_SIBLINGS=1 → falla", () => {
    const skipped = [];
    const t = { skip: (m) => skipped.push(m) };
    assert.equal(requireSibling(t, join(ROOT, "package.json"), "x", {}), true);
    assert.equal(requireSibling(t, join(ROOT, "no-existe.ts"), "worker", {}), false);
    assert.equal(skipped.length, 1);
    assert.throws(() => requireSibling(t, join(ROOT, "no-existe.ts"), "worker", { OUTBOX_REQUIRE_SIBLINGS: "1" }), /worker/);
    assert.equal(siblingsRequired({ OUTBOX_REQUIRE_SIBLINGS: "1" }), true);
    assert.equal(siblingsRequired({}), false);
  });

  test("los tests de invariantes usan requireSibling (sin skip ni if silencioso)", () => {
    for (const f of ["contract.test.mjs", "pasada2-contratos.test.mjs"]) {
      const src = readFileSync(join(here, f), "utf8");
      assert.match(src, /requireSibling\(/, `${f} tiene que usar requireSibling`);
      assert.doesNotMatch(src, /if \(existsSync\(workerIdem\)\)/, `${f}: if silencioso`);
      assert.doesNotMatch(src, /t\.skip\("worker no disponible/, `${f}: skip directo`);
    }
  });

  test("ci.yml: el job test hace checkout de out-box como hermano y exige los hermanos", () => {
    const yml = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const job = yml.slice(yml.indexOf("\n  test:"), yml.indexOf("\n  changes:"));
    assert.match(job, /repository: jonathanleiva15\/out-box\n/);
    assert.match(job, /path: out-box\n/);
    assert.match(job, /path: out-box-mcp\n/);
    assert.match(job, /OUTBOX_REQUIRE_SIBLINGS: "1"/);
    assert.match(job, /working-directory: out-box-mcp/);
  });
});
