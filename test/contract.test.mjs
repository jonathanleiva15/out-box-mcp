/**
 * Tests de CONTRATO de las tools contra un back simulado (node:test, sin deps extra).
 *
 * Levanta un servidor HTTP local que hace de worker (API_BASE y SITE_BASE apuntan a
 * él), arranca el server MCP real (dist/index.js) por stdio con el Client del SDK y
 * llama a las tools como lo haría un agente. Cada test fija la respuesta del "back"
 * y verifica lo que el MCP MANDA (verbo, path, query, body, headers) y lo que
 * DEVUELVE. Es el fetch del server contra un mock: detecta drift de contrato
 * (nombres de params, formato de `since`, content-type de export html, CTA de límite).
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { requireSibling } from "./siblings.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(here, "..", "dist", "index.js");

/** Lo que devuelve GET /api/me: la key activa del MCP es `feedbeef`. */
const ME = { user: "jonathan", keyId: "feedbeef", type: "agent", scopes: ["publish:jonathan", "list:jonathan"], authSource: "key" };

/** Requests que recibió el back simulado en el test actual. */
let calls = [];
/** Handler del test actual: (req) => { status?, json?, text?, contentType? }. */
let respond = () => ({ status: 404, json: { error: "not_found" } });

let http;
let client;

before(async () => {
  http = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://mock");
      const call = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: body ? JSON.parse(body) : undefined,
      };
      // Identidad fija del caller (GET /api/me): el MCP la cachea por proceso (keyId
      // activo para las guardas de auto-bloqueo DEVC-03, user por default). Se atiende
      // acá y NO se registra en `calls`, así el orden de los tests no cambia qué ven.
      if (call.method === "GET" && call.path === "/api/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(ME));
        return;
      }
      calls.push(call);
      const r = respond(call) ?? { status: 404, json: { error: "not_found" } };
      if (r.headers) {
        for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
      }
      const status = r.status ?? 200;
      if (r.text !== undefined) {
        res.writeHead(status, { "content-type": r.contentType ?? "text/html; charset=utf-8" });
        res.end(r.text);
      } else {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.json ?? {}));
      }
    });
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${http.address().port}`;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      OUTBOX_API_KEY: "outbox_test_contract_key",
      OUTBOX_USER: "jonathan",
      OUTBOX_API_BASE: base,
      OUTBOX_SITE_BASE: base,
      OUTBOX_RC: join(here, "no-existe.outboxrc"),
      OUTBOX_TOOLSETS: "all",
    },
    stderr: "pipe",
  });
  client = new Client({ name: "contract-test", version: "0.0.0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  await new Promise((resolve) => http.close(resolve));
});

beforeEach(() => {
  calls = [];
  respond = () => ({ status: 404, json: { error: "not_found" } });
});

/** Llama una tool; si el SDK tira por input inválido lo normaliza a isError. */
async function call(name, args = {}) {
  try {
    const r = await client.callTool({ name, arguments: args });
    return {
      isError: Boolean(r.isError),
      text: r.content?.[0]?.text ?? "",
      content: r.content ?? [],
      structured: r.structuredContent,
    };
  } catch (e) {
    return { isError: true, text: String(e?.message ?? e), content: [], structured: undefined };
  }
}

// ── outbox_export ─────────────────────────────────────────────────────────────

test("outbox_export format=html: lee text/html crudo (sin JSON.parse) y no trunca", async () => {
  const html = "<!doctype html><html><body>" + "x".repeat(40_000) + "</body></html>";
  respond = () => ({ text: html });
  const r = await call("outbox_export", { slug: "notas/hoy", format: "html" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.text, html);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].path, "/api/u/jonathan/notas/hoy/export");
  assert.equal(calls[0].query.format, "html");
  assert.equal(calls[0].headers.authorization, "Bearer outbox_test_contract_key");
});

test("outbox_export format=json: devuelve `contenido` completo aunque supere 25k chars", async () => {
  const contenido = "<p>" + "y".repeat(40_000) + "</p>";
  respond = () => ({ json: { user: "jonathan", slug: "notas/hoy", version: 3, contenido } });
  const r = await call("outbox_export", { slug: "notas/hoy" });
  assert.equal(r.isError, false, r.text);
  const parsed = JSON.parse(r.text); // si se truncara, no sería JSON válido
  assert.equal(parsed.contenido, contenido);
  assert.equal(calls[0].query.format, "json");
});

// ── outbox_search ─────────────────────────────────────────────────────────────

test("outbox_search manda q/limit/prefix con los nombres del worker y respeta prefix + limit", async () => {
  // El back simulado IGNORA prefix/limit (como el worker viejo): el MCP igual acota.
  respond = () => ({
    json: {
      user: "jonathan",
      query: "q3",
      count: 4,
      results: [
        { slug: "clientes/solera/q3" },
        { slug: "clientes-blog/q3" },
        { slug: "clientes/acme/q3" },
        { slug: "clientes" },
      ],
    },
  });
  const r = await call("outbox_search", { q: "q3", limit: 2, prefix: "clientes" });
  assert.equal(r.isError, false, r.text);
  assert.equal(calls[0].path, "/api/u/jonathan/search");
  assert.deepEqual(calls[0].query, { q: "q3", limit: "2", prefix: "clientes" });
  const out = JSON.parse(r.text);
  assert.deepEqual(
    out.results.map((x) => x.slug),
    ["clientes/solera/q3", "clientes/acme/q3"],
  );
  assert.equal(out.count, 2);
});

// ── outbox_export_library ─────────────────────────────────────────────────────

test("outbox_export_library manda prefix a /api/list y solo exporta posts de esa carpeta", async () => {
  respond = (c) => {
    if (c.path === "/api/list") {
      return {
        json: {
          posts: [{ slug: "clientes/solera" }, { slug: "otra/cosa" }, { slug: "clientes-blog/x" }, { slug: "clientes/a/b" }],
          cursor: null,
        },
      };
    }
    if (c.path.endsWith("/export")) return { json: { slug: c.path, contenido: "<p>ok</p>" } };
    return undefined;
  };
  const r = await call("outbox_export_library", { prefix: "clientes", limit: 10 });
  assert.equal(r.isError, false, r.text);
  const list = calls.find((c) => c.path === "/api/list");
  assert.equal(list.query.prefix, "clientes");
  const exported = calls.filter((c) => c.path.endsWith("/export")).map((c) => c.path).sort();
  assert.deepEqual(exported, [
    "/api/u/jonathan/clientes/a/b/export",
    "/api/u/jonathan/clientes/solera/export",
  ]);
  const out = JSON.parse(r.text);
  assert.equal(out.count, 2);
  assert.equal(out.complete, true);
});

test("outbox_export_library marca truncated si quedan posts de la carpeta fuera de limit", async () => {
  respond = (c) => {
    if (c.path === "/api/list") {
      return { json: { posts: [{ slug: "c/a" }, { slug: "c/b" }, { slug: "c/c" }], cursor: null } };
    }
    if (c.path.endsWith("/export")) return { json: { contenido: "" } };
    return undefined;
  };
  const r = await call("outbox_export_library", { prefix: "c", limit: 2 });
  const out = JSON.parse(r.text);
  assert.equal(out.count, 2);
  assert.equal(out.truncated, true);
  assert.equal(out.complete, false);
});

// ── since (recent / audit) ────────────────────────────────────────────────────

test("outbox_recent normaliza `since` epoch ms a ISO antes de mandarlo", async () => {
  respond = () => ({ json: { posts: [] } });
  const r = await call("outbox_recent", { since: "1719878400000" });
  assert.equal(r.isError, false, r.text);
  assert.equal(calls[0].path, "/api/u/jonathan/recent");
  assert.equal(calls[0].query.since, "2024-07-02T00:00:00.000Z");
});

test("outbox_recent normaliza un ISO con offset a UTC (el back compara strings)", async () => {
  respond = () => ({ json: { posts: [] } });
  await call("outbox_recent", { since: "2026-06-01T10:00:00-03:00" });
  assert.equal(calls[0].query.since, "2026-06-01T13:00:00.000Z");
});

test("outbox_audit normaliza `since` epoch a ISO (el back da 400 invalid_since con epoch)", async () => {
  respond = () => ({ json: { events: [] } });
  const r = await call("outbox_audit", { since: "1719878400000", limit: 5 });
  assert.equal(r.isError, false, r.text);
  assert.equal(calls[0].path, "/api/audit");
  assert.deepEqual(calls[0].query, { limit: "5", since: "2024-07-02T00:00:00.000Z" });
});

test("`since` inválido: error accionable y NO se llama al back", async () => {
  const r = await call("outbox_audit", { since: "ayer" });
  assert.equal(r.isError, true);
  assert.match(r.text, /since/i);
  assert.equal(calls.length, 0);
});

// ── CTA de límite de plan ─────────────────────────────────────────────────────

test("403 de límite de plan (keys_limit) devuelve el CTA estructurado, no 'falta scope'", async () => {
  const cta = { limit: 3, used: 3, tier: "free", upgradeTo: "pro", ctaUrl: "https://out-box.dev/pricing" };
  respond = () => ({ status: 403, json: { error: "keys_limit", message: "max keys", ...cta } });
  const r = await call("outbox_gen_agent_key", { label: "bot" });
  assert.equal(r.isError, true);
  assert.doesNotMatch(r.text, /falta scope/);
  assert.match(r.text, /límite del plan/);
  assert.match(r.text, /https:\/\/out-box\.dev\/pricing/);
  const json = JSON.parse(r.text.split("upgradeCta: ")[1]);
  assert.deepEqual(json, { error: "keys_limit", ...cta });
});

test("413 storage_limit en el techo del plan: CTA con upgradeTo null", async () => {
  respond = () => ({
    status: 413,
    json: { error: "storage_limit", limit: 100, used: 101, tier: "unlimited", upgradeTo: null, ctaUrl: null },
  });
  const r = await call("outbox_gen_agent_key", { label: "bot" });
  assert.equal(r.isError, true);
  assert.match(r.text, /no hay upgrade/);
  assert.equal(JSON.parse(r.text.split("upgradeCta: ")[1]).upgradeTo, null);
});

test("403 de scope real sigue diciendo 'falta scope'", async () => {
  respond = () => ({ status: 403, json: { error: "forbidden", missingScope: "genkey" } });
  const r = await call("outbox_gen_agent_key", { label: "bot" });
  assert.equal(r.isError, true);
  assert.match(r.text, /falta scope: genkey/);
  assert.doesNotMatch(r.text, /upgradeCta/);
});

// Regresión: shapes REALES del worker con código de límite pero SIN bloque CTA.
// Antes el MCP inventaba `upgradeTo: null` y decía "no hay upgrade" (falso) y perdía message/retryIn.

test("413 html_too_large sin bloque CTA (jsonError de publish.ts): límite del plan, sin afirmar 'no hay upgrade'", async () => {
  const message = "Esta página pesa 6.0 MB; tu plan (free) permite hasta 5 MB por página. Reducí imágenes (usá uploads) o pasá a un plan mayor.";
  respond = () => ({ status: 413, json: { error: "html_too_large", message } });
  const r = await call("outbox_publish", { slug: "notas/grande", html: "<p>x</p>", model: "claude-opus-5-5" });
  assert.equal(r.isError, true);
  assert.equal(calls[0].path, "/publish");
  assert.match(r.text, /límite del plan alcanzado \(html_too_large\)/);
  assert.doesNotMatch(r.text, /no hay upgrade/);
  assert.doesNotMatch(r.text, /upgradeCta/);
  assert.ok(r.text.includes(message), r.text);
});

test("429 rate_limited anti-spam de comments (sin bloque CTA): 429 genérico con retryIn y message", async () => {
  respond = () => ({
    status: 429,
    json: { error: "rate_limited", message: "demasiados comentarios; probá en un momento", retryIn: 42 },
  });
  const r = await call("outbox_create_comment", { slug: "notas/hoy", body: "hola", user: "otro" });
  assert.equal(r.isError, true);
  assert.equal(calls[0].path, "/api/u/otro/notas/hoy/comments");
  assert.match(r.text, /reintentá en ~42s/);
  assert.match(r.text, /demasiados comentarios/);
  assert.doesNotMatch(r.text, /plan/);
  assert.doesNotMatch(r.text, /upgradeCta/);
});

// ── Webhooks ──────────────────────────────────────────────────────────────────

const EXPECTED_EVENTS = ["comment.created", "version.created", "page.published", "daily.appended", "page.viewed"];

test("outbox_create_webhook acepta los 5 eventos del worker", async () => {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "outbox_create_webhook");
  assert.deepEqual([...tool.inputSchema.properties.events.items.enum].sort(), [...EXPECTED_EVENTS].sort());

  respond = () => ({ json: { id: "wh1", secret: "s" } });
  const r = await call("outbox_create_webhook", {
    url: "https://example.com/hook",
    events: ["daily.appended", "page.viewed"],
  });
  assert.equal(r.isError, false, r.text);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/api/webhooks");
  assert.deepEqual(calls[0].body.events, ["daily.appended", "page.viewed"]);
});

test("el enum de eventos coincide con WEBHOOK_EVENTS del worker (si el monorepo está al lado)", (t) => {
  const workerFile = join(here, "..", "..", "out-box", "worker", "src", "lib", "webhooks.ts");
  // En CI (OUTBOX_REQUIRE_SIBLINGS=1) un hermano faltante falla en vez de saltearse.
  if (!requireSibling(t, workerFile, "worker (out-box)")) return;
  const src = readFileSync(workerFile, "utf8");
  const block = src.match(/WEBHOOK_EVENTS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  assert.ok(block, "no se encontró WEBHOOK_EVENTS en el worker");
  const events = [...block[1].matchAll(/'([a-z]+\.[a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...events].sort(), [...EXPECTED_EVENTS].sort());
});

test("outbox_webhook_events lee el catálogo del back (GET /api/webhooks/events)", async () => {
  respond = () => ({ json: { events: EXPECTED_EVENTS } });
  const r = await call("outbox_webhook_events");
  assert.equal(r.isError, false, r.text);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].path, "/api/webhooks/events");
  assert.deepEqual(JSON.parse(r.text).events, EXPECTED_EVENTS);
});

// ── Teams: revocar company key ────────────────────────────────────────────────

test("outbox_revoke_team_key: DELETE /api/teams/:handle/keys/:keyId con CSRF header", async () => {
  respond = () => ({ json: { ok: true, keyId: "abcd1234", revokedAt: "2026-09-29T00:00:00.000Z" } });
  const r = await call("outbox_revoke_team_key", { handle: "acme", keyId: "abcd1234" });
  assert.equal(r.isError, false, r.text);
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].path, "/api/teams/acme/keys/abcd1234");
  assert.equal(calls[0].headers["x-requested-with"], "XMLHttpRequest");
});

test("outbox_revoke_team_key rechaza un keyId que no es shortKeyId (sin llamar al back)", async () => {
  const r = await call("outbox_revoke_team_key", { handle: "acme", keyId: "../../admin" });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);
});

// ── Grants: permiso comment ───────────────────────────────────────────────────

test("outbox_create_grant manda permissions ['comment'] cuando se pide", async () => {
  respond = () => ({ json: { id: "0123456789abcdef" } });
  const r = await call("outbox_create_grant", {
    recipientUser: "ana",
    resource: "clientes/solera",
    resourceType: "folder",
    permissions: ["comment"],
  });
  assert.equal(r.isError, false, r.text);
  assert.equal(calls[0].path, "/api/grants");
  assert.deepEqual(calls[0].body.permissions, ["comment"]);
});

test("outbox_create_grant sin permissions sigue mandando ['view'] (default)", async () => {
  respond = () => ({ json: { id: "0123456789abcdef" } });
  await call("outbox_create_grant", { recipientUser: "ana", resource: "notas" });
  assert.deepEqual(calls[0].body.permissions, ["view"]);
});
