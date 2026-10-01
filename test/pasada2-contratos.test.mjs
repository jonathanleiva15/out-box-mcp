/**
 * Regresiones de la pasada 2 (2026-09-30) del repo out-box-mcp:
 *   - outbox_gen_team_key sin mfaCode (loop step_up_required → "reintentá con mfaCode").
 *   - 409 idempotency_in_progress / concurrent_update clasificados como no reintentables,
 *     reintento automático que no esperaba Retry-After y timeout de escritura = TTL del
 *     marcador `pending` del worker.
 *   - ejemplo de slug de outbox_append en el namespace reservado `daily/…`.
 *   - 413 de límites fijos con el fix "pasá a un plan mayor" y sin maxBytes.
 *   - server.json sin el toolset `apps`.
 * Corren contra dist/ (lo que se shipea).
 */
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startHarness } from "./harness.mjs";
import { requireSibling } from "./siblings.mjs";
import { PORT, loadSlugRules, makeSlugRejectionReason } from "./slug-rules.mjs";
import {
  OutboxClient,
  OutboxApiError,
  describeError,
  formatError,
  IDEMPOTENCY_IN_PROGRESS_MAX_WAITS,
  IDEMPOTENCY_IN_PROGRESS_MAX_WAIT_S,
} from "../dist/services/client.js";
import { IDEMPOTENT_WRITE_TIMEOUT_MS, IDEMPOTENCY_PENDING_TTL_MS } from "../dist/constants.js";
import { TOOL_TEXT_EN, PARAM_EN } from "../dist/tools-en.js";
import { SLUG_SCHEMA } from "../dist/schemas.js";
import { TOOLSETS } from "../dist/toolsets.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const TOOLS_SRC = readFileSync(join(ROOT, "src", "tools.ts"), "utf8");

/** Bloques `registerTool("<name>", …)` de src/tools.ts, por nombre. */
function toolBlocks() {
  const out = new Map();
  const re = /registerTool\(\s*"([a-z_]+)"/g;
  const hits = [...TOOLS_SRC.matchAll(re)];
  hits.forEach((m, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : TOOLS_SRC.length;
    out.set(m[1], TOOLS_SRC.slice(m.index, end));
  });
  return out;
}

let h;
before(async () => {
  h = await startHarness({ env: { OUTBOX_TOOLSETS: "all" } });
});
after(async () => {
  await h.close();
});
beforeEach(() => h.reset());

// ── gen_team_key + step-up MFA ────────────────────────────────────────────────

describe("PEN-03 · outbox_gen_team_key acepta mfaCode", () => {
  test("step_up_required → reintento con mfaCode llega al body del POST /api/teams/:h/keys", async () => {
    h.respond = () => ({ status: 401, json: { error: "step_up_required" } });
    const r = await h.call("outbox_gen_team_key", { handle: "acme", label: "bot" });
    assert.equal(r.isError, true);
    assert.equal(r.structured.error.code, "step_up_required");
    assert.match(r.structured.error.fix, /mfaCode/);

    h.reset();
    h.respond = (c) =>
      c.body?.mfaCode === "123456"
        ? { json: { plaintext: "outbox_team", keyId: "0000bbbb" } }
        : { status: 401, json: { error: "step_up_required" } };
    const ok = await h.call("outbox_gen_team_key", { handle: "acme", label: "bot", mfaCode: "123456" });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(h.calls[0].method, "POST");
    assert.equal(h.calls[0].path, "/api/teams/acme/keys");
    assert.equal(h.calls[0].body.mfaCode, "123456");
    assert.equal(h.calls[0].body.label, "bot");
  });

  test("mfaCode con formato inválido se rechaza sin llamar al back", async () => {
    const bad = await h.call("outbox_gen_team_key", { handle: "acme", label: "bot", mfaCode: "x" });
    assert.equal(bad.isError, true);
    assert.equal(h.calls.length, 0);
  });

  test("contrato: toda tool que pega a un endpoint con requireRecentMfa declara mfaCode", async () => {
    // Endpoints del worker que pasan por requireRecentMfa (handlers/keys.ts gen/rotate/agent,
    // handlers/teams.ts → genAgentKeyHandler, handlers/agents.ts instantiate, me-delete).
    const STEP_UP = [
      /"\/api\/keys\/agent"/,
      /"\/api\/keys\/rotate"/,
      /"\/api\/agents\/instantiate"/,
      /"\/api\/me\/delete"/,
      /"\/api\/keys",\s*\{\s*method:\s*"POST"/,
      /\/keys`,\s*\{\s*method:\s*"POST"/,
      // Seguridad pasada 1 (2026-10-01): POST /api/teams/:h/members también pide step-up.
      /\/members`,\s*\{\s*method:\s*"POST"/,
    ];
    const gated = [...toolBlocks()].filter(([, src]) => STEP_UP.some((re) => re.test(src))).map(([n]) => n);
    for (const must of ["outbox_gen_agent_key", "outbox_rotate_key", "outbox_instantiate_agent", "outbox_gen_team_key", "outbox_add_team_member"]) {
      assert.ok(gated.includes(must), `el scan tiene que detectar ${must} (encontró: ${gated.join(", ")})`);
    }
    const { tools } = await h.client.listTools();
    for (const name of gated) {
      const t = tools.find((x) => x.name === name);
      assert.ok(t, `${name} registrada con OUTBOX_TOOLSETS=all`);
      assert.ok(t.inputSchema.properties?.mfaCode, `${name} tiene que aceptar mfaCode (step_up_required pide reintentar con él)`);
      assert.match(toolBlocks().get(name), /mfaCode\s*\}/, `${name} tiene que mandar mfaCode en el body`);
    }
  });
});

// ── AX-04 · 409 reintentables del worker ───────────────────────────────────────

function idemBack({ inProgressTimes, failFirstWithTimeout = true }) {
  const calls = [];
  let inProgressLeft = inProgressTimes;
  const fetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.pathname === "/api/capabilities") {
      return Response.json({ features: { idempotency: true, idempotencyEndpoints: ["publish"] } });
    }
    calls.push({ path: u.pathname, key: init.headers["idempotency-key"] });
    if (failFirstWithTimeout && calls.length === 1) {
      const err = new Error("timeout");
      err.name = "TimeoutError";
      throw err;
    }
    if (inProgressLeft > 0) {
      inProgressLeft--;
      return Response.json(
        { error: "idempotency_in_progress", message: "en curso", retryable: true },
        { status: 409, headers: { "Retry-After": "2" } },
      );
    }
    return Response.json({ version: 3, url: "https://site.test/j/a" });
  };
  return { fetch, calls };
}

describe("AX-04 · idempotency_in_progress y concurrent_update", () => {
  test("el reintento tras timeout que cae en idempotency_in_progress espera Retry-After y reintenta con la MISMA key", async () => {
    const back = idemBack({ inProgressTimes: 2 });
    const sleeps = [];
    const c = new OutboxClient("outbox_k", { apiBase: "https://api.test", fetch: back.fetch, sleep: async (ms) => void sleeps.push(ms) });
    const out = await c.req("/api/publish", {
      method: "POST",
      body: {},
      idempotencyKey: "k-12345678",
      retryOnNetworkError: true,
      idempotencyOp: "publish",
    });
    assert.deepEqual(out, { version: 3, url: "https://site.test/j/a" });
    assert.equal(back.calls.length, 4, "timeout + 2 × in_progress + replay");
    assert.deepEqual(new Set(back.calls.map((x) => x.key)), new Set(["k-12345678"]));
    assert.deepEqual(sleeps, [2000, 2000]);
  });

  test("con tope: si sigue en curso devuelve el 409 con retryAfter, retryable y fix de misma key", async () => {
    const back = idemBack({ inProgressTimes: 99, failFirstWithTimeout: false });
    const sleeps = [];
    const c = new OutboxClient("outbox_k", { apiBase: "https://api.test", fetch: back.fetch, sleep: async (ms) => void sleeps.push(ms) });
    let err;
    await assert.rejects(
      () => c.req("/api/publish", { method: "POST", body: {}, idempotencyKey: "k-12345678", idempotencyOp: "publish" }),
      (e) => ((err = e), e instanceof OutboxApiError && e.status === 409),
    );
    assert.equal(sleeps.length, IDEMPOTENCY_IN_PROGRESS_MAX_WAITS);
    assert.equal(back.calls.length, IDEMPOTENCY_IN_PROGRESS_MAX_WAITS + 1);
    const d = describeError(err);
    assert.equal(d.code, "idempotency_in_progress");
    assert.equal(d.retryable, true);
    assert.equal(d.retryAfter, 2);
    assert.match(d.fix, /MISMO idempotencyKey/);
    assert.match(formatError(err), /reintentable/);
  });

  test("sin Idempotency-Key no hay espera ni reintento", async () => {
    const back = idemBack({ inProgressTimes: 1, failFirstWithTimeout: false });
    const sleeps = [];
    const c = new OutboxClient("outbox_k", { apiBase: "https://api.test", fetch: back.fetch, sleep: async (ms) => void sleeps.push(ms) });
    await assert.rejects(() => c.req("/api/x", { method: "POST", body: {} }), (e) => e instanceof OutboxApiError && e.status === 409);
    assert.equal(back.calls.length, 1);
    assert.equal(sleeps.length, 0);
  });

  test("describeError: concurrent_update y cualquier body con retryable:true son reintentables", () => {
    const cu = describeError(new OutboxApiError(409, { error: "concurrent_update", retryable: true }, "/x"));
    assert.equal(cu.retryable, true);
    assert.match(cu.fix, /Reintentá la misma operación una vez/);
    assert.doesNotMatch(cu.fix, /releé el recurso antes de reintentar/);
    const other = describeError(new OutboxApiError(409, { error: "algo_transitorio", retryable: true }, "/x"));
    assert.equal(other.retryable, true);
    const plain = describeError(new OutboxApiError(409, { error: "anchor_not_found" }, "/x"));
    assert.equal(plain.retryable, false);
  });

  test("invariante: timeout de escritura idempotente + esperas < TTL del marcador pending del worker", (t) => {
    const worst = IDEMPOTENT_WRITE_TIMEOUT_MS + IDEMPOTENCY_IN_PROGRESS_MAX_WAITS * IDEMPOTENCY_IN_PROGRESS_MAX_WAIT_S * 1000;
    assert.ok(worst < IDEMPOTENCY_PENDING_TTL_MS, `${worst} ms tiene que quedar por debajo de ${IDEMPOTENCY_PENDING_TTL_MS} ms`);
    // publish y publish-from-template usan el timeout acotado (no WRITE_TIMEOUT_MS = TTL).
    for (const [name, src] of toolBlocks()) {
      if (/idempotencyOp:\s*"publish(FromTemplate)?"/.test(src)) {
        assert.match(src, /timeoutMs:\s*IDEMPOTENT_WRITE_TIMEOUT_MS/, `${name} tiene que usar IDEMPOTENT_WRITE_TIMEOUT_MS`);
      }
    }
    // Espejo del worker (repo hermano): el TTL real no puede ser menor. Antes era un
    // `if (existsSync)` sin else que pasaba en verde sin verificar nada; ahora se
    // saltea visible y, en CI (OUTBOX_REQUIRE_SIBLINGS=1), falla si falta el hermano.
    const workerIdem = join(ROOT, "..", "out-box", "worker", "src", "lib", "idempotency.ts");
    if (!requireSibling(t, workerIdem, "worker (out-box)")) return;
    const m = readFileSync(workerIdem, "utf8").match(/IDEMPOTENCY_PENDING_TTL_SECONDS\s*=\s*([\d_]+)/);
    assert.ok(m, "constante IDEMPOTENCY_PENDING_TTL_SECONDS en el worker");
    assert.ok(Number(m[1].replace(/_/g, "")) * 1000 >= IDEMPOTENCY_PENDING_TTL_MS, "el TTL del worker bajó: actualizar constants.ts");
  });
});

// ── Ejemplos de slug válidos ──────────────────────────────────────────────────

/**
 * Reservas de namespace del worker (lib/slug.ts → slugRejectionReason /
 * isShareableFolder). La forma la valida SLUG_SCHEMA del MCP.
 *
 * Ronda 4: las reglas salen del JSON canónico del worker si existe (test/slug-rules.mjs
 * lo busca); mientras no exista, del port a mano (`PORT`), que el test "el port
 * coincide con lib/slug.ts del worker" compara contra el archivo hermano (pasada 5).
 */
const SLUG_RULES = loadSlugRules();
const RESERVED_SLUG_SUFFIXES = PORT.suffixes;
const RESERVED_SLUG_FIRST_SEGMENTS = PORT.firstSegments;
const [COMMENT_ACTION_TAIL_RE, DAILY_BLOCK_TAIL_RE] = PORT.tails;
const slugRejectionReason = makeSlugRejectionReason(SLUG_RULES, (slug) => SLUG_SCHEMA.safeParse(slug).success);

/** Strings `'x'` de `export const <name> … = new Set([ … ])` en el fuente TS del worker. */
function workerSetLiteral(src, name) {
  const m = src.match(new RegExp(`export const ${name}\\b[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  assert.ok(m, `no se encontró ${name} en lib/slug.ts del worker`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

/** Regex literal de `const <name> = /…/flags;` en el fuente TS del worker. */
function workerRegexLiteral(src, name) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*/(.+)/([a-z]*);`));
  assert.ok(m, `no se encontró ${name} en lib/slug.ts del worker`);
  return { source: m[1], flags: m[2] };
}

/** Ejemplos `'x'` dentro de "(ej. …)" / "(e.g. …)" de una descripción. */
function examplesIn(desc) {
  const out = [];
  for (const m of String(desc ?? "").matchAll(/\((?:ej\.|e\.g\.)([^)]*)\)/g)) {
    for (const q of m[1].matchAll(/'([^']+)'/g)) out.push(q[1]);
  }
  return out;
}

describe("ejemplos de slug en las descripciones", () => {
  test("el port rechaza el ejemplo viejo de outbox_append", () => {
    assert.equal(slugRejectionReason("daily/2026-09-30"), "reserved_slug");
  });

  test("el port coincide con lib/slug.ts del worker (sets reservados y colas)", (t) => {
    // Con el JSON canónico el port no se usa: no hay nada que mantener sincronizado.
    if (SLUG_RULES.source === "json") {
      t.skip(`reglas desde el JSON canónico (${SLUG_RULES.file})`);
      return;
    }
    const workerSlug = join(ROOT, "..", "out-box", "worker", "src", "lib", "slug.ts");
    // En CI (OUTBOX_REQUIRE_SIBLINGS=1) un hermano faltante falla en vez de saltearse.
    if (!requireSibling(t, workerSlug, "worker (out-box)")) return;
    const src = readFileSync(workerSlug, "utf8");
    assert.deepEqual(
      workerSetLiteral(src, "RESERVED_SLUG_SUFFIXES").sort(),
      [...RESERVED_SLUG_SUFFIXES].sort(),
      "RESERVED_SLUG_SUFFIXES cambió en el worker: actualizar el port de este test",
    );
    assert.deepEqual(
      workerSetLiteral(src, "RESERVED_SLUG_FIRST_SEGMENTS").sort(),
      [...RESERVED_SLUG_FIRST_SEGMENTS].sort(),
      "RESERVED_SLUG_FIRST_SEGMENTS cambió en el worker: actualizar el port de este test",
    );
    for (const [name, re] of [
      ["COMMENT_ACTION_TAIL_RE", COMMENT_ACTION_TAIL_RE],
      ["DAILY_BLOCK_TAIL_RE", DAILY_BLOCK_TAIL_RE],
    ]) {
      assert.deepEqual(workerRegexLiteral(src, name), { source: re.source, flags: re.flags }, `${name} cambió en el worker`);
    }
  });

  test("el port rechaza las colas comments/<id>/accept y blocks/blk_* (como el worker)", () => {
    assert.equal(slugRejectionReason("informe/comments/abc123/accept"), "reserved_slug");
    assert.equal(slugRejectionReason("journal/blocks/blk_x1"), "reserved_slug");
    assert.equal(slugRejectionReason("journal/blocks/notas"), null);
    assert.equal(slugRejectionReason("reportes/stats", { folder: true }), null);
  });

  test("todo ejemplo de slug/folder (stdio en español y textos EN del remoto) es publicable", async () => {
    const { tools } = await h.client.listTools();
    const checked = [];
    const check = (where, param, desc) => {
      const isSlug = /slug/i.test(param);
      const isFolder = /^(prefix|folder)$/i.test(param);
      if (!isSlug && !isFolder) return;
      for (const ex of examplesIn(desc)) {
        checked.push(ex);
        assert.equal(slugRejectionReason(ex, { folder: isFolder }), null, `${where}.${param}: el ejemplo '${ex}' lo rechaza el worker`);
      }
    };
    for (const t of tools) {
      for (const [param, schema] of Object.entries(t.inputSchema.properties ?? {})) check(t.name, param, schema.description);
    }
    for (const [name, en] of Object.entries(TOOL_TEXT_EN)) {
      for (const [param, desc] of Object.entries(en.params ?? {})) check(`${name}(en)`, param, desc);
    }
    for (const [param, desc] of Object.entries(PARAM_EN)) check("PARAM_EN", param, desc);
    assert.ok(checked.includes("journal"), "el ejemplo nuevo de outbox_append se revisó");
  });
});

// ── 413 de límites fijos ──────────────────────────────────────────────────────

describe("413 · límite fijo vs límite de plan", () => {
  test("block_too_large: sin consejo de upgrade y con maxBytes en el error estructurado", () => {
    const e = new OutboxApiError(413, { error: "block_too_large", maxBytes: 51200 }, "/api/u/j/d/append");
    const d = describeError(e);
    assert.equal(d.maxBytes, 51200);
    assert.doesNotMatch(d.fix, /plan mayor/);
    assert.match(d.fix, /51200/);
    assert.match(d.fix, /subir de plan no lo resuelve/);
    assert.match(formatError(e), /block_too_large/);
    assert.doesNotMatch(formatError(e), /plan mayor/);
  });

  test("upload/anchor/replacement_too_large tampoco sugieren upgrade", () => {
    for (const code of ["upload_too_large", "anchor_too_large", "replacement_too_large"]) {
      const d = describeError(new OutboxApiError(413, { error: code }, "/x"));
      assert.doesNotMatch(d.fix, /plan mayor/, code);
    }
  });

  test("html_too_large (plan, sin bloque CTA) conserva el consejo de plan", () => {
    const d = describeError(new OutboxApiError(413, { error: "html_too_large", message: "5 MB" }, "/publish"));
    assert.match(d.fix, /plan mayor/);
  });
});

// ── server.json ───────────────────────────────────────────────────────────────

test("server.json: OUTBOX_TOOLSETS lista todos los toolsets de src/toolsets.ts", () => {
  const server = JSON.parse(readFileSync(join(ROOT, "server.json"), "utf8"));
  const envs = server.packages.flatMap((p) => p.environmentVariables ?? []);
  const desc = envs.find((v) => v.name === "OUTBOX_TOOLSETS")?.description;
  assert.ok(desc, "OUTBOX_TOOLSETS documentada en server.json");
  const m = desc.match(/registrar:\s*([^.]+?)\s+o all/);
  assert.ok(m, `formato inesperado: ${desc}`);
  const listed = m[1].split(/,\s*/);
  assert.deepEqual([...listed].sort(), [...TOOLSETS].sort());
});
