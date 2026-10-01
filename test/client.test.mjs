/**
 * Tests unitarios del cliente HTTP y de los helpers de filtros (node:test).
 * `fetch` se mockea en globalThis: se testea exactamente dist/ (lo que se shipea).
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { OutboxClient, OutboxApiError, formatError, extractUpgradeCta } from "../dist/services/client.js";
import { normalizeSince, slugUnderPrefix } from "../dist/filters.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(body, { status = 200, contentType = "application/json" } = {}) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(body, { status, headers: { "content-type": contentType } });
  };
  return seen;
}

test("reqText devuelve el HTML crudo (req() hacía JSON.parse y tiraba '<')", async () => {
  const seen = mockFetch("<!doctype html><p>hola</p>", { contentType: "text/html" });
  const c = new OutboxClient("outbox_k");
  const html = await c.reqText("/api/u/jonathan/a/export", { query: { format: "html" } });
  assert.equal(html, "<!doctype html><p>hola</p>");
  assert.match(seen[0].url, /\/api\/u\/jonathan\/a\/export\?format=html$/);
  assert.equal(seen[0].init.headers.authorization, "Bearer outbox_k");
  assert.match(seen[0].init.headers.accept, /text\/html/);
});

test("reqText acepta el export servido como text/plain + attachment (worker PEN3, gate pasada 3)", async () => {
  // El worker ahora sirve el export html como text/plain; charset=utf-8 + attachment +
  // nosniff: el body sigue siendo el HTML. No hay que validar un content-type html.
  mockFetch("<!doctype html><p>hola</p>", { contentType: "text/plain; charset=utf-8" });
  const c = new OutboxClient("outbox_k");
  const html = await c.reqText("/api/u/jonathan/a/export", { query: { format: "html" } });
  assert.equal(html, "<!doctype html><p>hola</p>");
});

test("reqText con !ok tira OutboxApiError con el body JSON del back", async () => {
  mockFetch(JSON.stringify({ error: "cross_user_export_forbidden" }), { status: 403 });
  const c = new OutboxClient("outbox_k");
  await assert.rejects(
    () => c.reqText("/api/u/otro/a/export"),
    (e) => e instanceof OutboxApiError && e.status === 403 && e.body.error === "cross_user_export_forbidden",
  );
});

test("req() sigue parseando JSON y manda x-requested-with en mutaciones", async () => {
  const seen = mockFetch(JSON.stringify({ ok: true }));
  const c = new OutboxClient("outbox_k");
  assert.deepEqual(await c.req("/api/x", { method: "DELETE" }), { ok: true });
  assert.equal(seen[0].init.headers["x-requested-with"], "XMLHttpRequest");
  assert.equal(seen[0].init.headers.accept, "application/json");
});

test("extractUpgradeCta solo arma el CTA si el body trae el bloque (upgradeTo + tier)", () => {
  const body = { error: "daily_docs_limit", limit: 5, used: 5, tier: "free", upgradeTo: "pro", ctaUrl: "https://out-box.dev/pricing" };
  assert.deepEqual(extractUpgradeCta(body), body);
  assert.equal(extractUpgradeCta({ error: "forbidden", missingScope: "publish" }), null);
  assert.equal(extractUpgradeCta(null), null);
  // Código nuevo del back pero con el bloque CTA → también es límite de plan.
  assert.equal(extractUpgradeCta({ error: "foo_limit", tier: "free", upgradeTo: "pro", ctaUrl: "u" }).error, "foo_limit");
  // Regresión: código de plan SIN bloque (publish.ts 413, comments.ts 429) → NO es CTA.
  assert.equal(extractUpgradeCta({ error: "html_too_large", message: "pasá a un plan mayor" }), null);
  assert.equal(extractUpgradeCta({ error: "rate_limited", message: "demasiados comentarios", retryIn: 5 }), null);
});

test("formatError: 413 html_too_large sin bloque → límite del plan + message, sin 'no hay upgrade'", () => {
  const msg = formatError(new OutboxApiError(413, { error: "html_too_large", message: "tu plan (free) permite hasta 5 MB; pasá a un plan mayor" }, "/publish"));
  assert.match(msg, /límite del plan alcanzado \(html_too_large\)/);
  assert.match(msg, /pasá a un plan mayor/);
  assert.doesNotMatch(msg, /no hay upgrade/);
  assert.doesNotMatch(msg, /upgradeCta/);
});

test("formatError: 429 rate_limited sin bloque (anti-spam comments) → 429 genérico con retryIn", () => {
  const msg = formatError(new OutboxApiError(429, { error: "rate_limited", message: "demasiados comentarios; probá en un momento", retryIn: 17 }, "/api/u/a/b/comments"));
  assert.match(msg, /reintentá en ~17s/);
  assert.match(msg, /demasiados comentarios/);
  assert.doesNotMatch(msg, /plan/);
});

test("formatError: 403 daily_docs_limit NO es 'falta scope' y trae el CTA", () => {
  const e = new OutboxApiError(403, { error: "daily_docs_limit", limit: 5, used: 5, tier: "free", upgradeTo: "pro", ctaUrl: "https://out-box.dev/pricing" }, "/publish");
  const msg = formatError(e);
  assert.doesNotMatch(msg, /falta scope/);
  assert.match(msg, /daily_docs_limit/);
  assert.match(msg, /subir a pro: https:\/\/out-box\.dev\/pricing/);
});

test("formatError: 429 rate_limited conserva retryAfter y suma el CTA", () => {
  const e = new OutboxApiError(429, { error: "rate_limited", retryAfter: 30, used: { hour: 10, day: 20 }, limit: 10, tier: "free", upgradeTo: "pro", ctaUrl: "https://out-box.dev/pricing" }, "/publish");
  const msg = formatError(e);
  assert.match(msg, /reintentá en ~30s/);
  assert.deepEqual(JSON.parse(msg.split("upgradeCta: ")[1]).used, { hour: 10, day: 20 });
});

test("formatError: 403 sin CTA sigue siendo de permisos", () => {
  const msg = formatError(new OutboxApiError(403, { error: "forbidden", missingAnyOf: ["list", "admin:self"] }, "/api/list"));
  assert.match(msg, /falta scope: list o admin:self/);
});

test("formatError: 400 suma el message del back (ej. valores aceptados)", () => {
  const msg = formatError(new OutboxApiError(400, { error: "invalid_events", message: "events must be a non-empty subset of a, b" }, "/api/webhooks"));
  assert.match(msg, /invalid_events \(events must be a non-empty subset of a, b\)/);
});

test("normalizeSince: epoch ms, epoch s, ISO con offset y fecha sola → ISO UTC", () => {
  assert.equal(normalizeSince("1719878400000"), "2024-07-02T00:00:00.000Z");
  assert.equal(normalizeSince("1719878400"), "2024-07-02T00:00:00.000Z");
  assert.equal(normalizeSince("2026-06-01T10:00:00-03:00"), "2026-06-01T13:00:00.000Z");
  assert.equal(normalizeSince("2026-06-01"), "2026-06-01T00:00:00.000Z");
  assert.equal(normalizeSince(" 2026-06-01T00:00:00Z "), "2026-06-01T00:00:00.000Z");
});

test("normalizeSince tira ante algo que no es fecha", () => {
  assert.throws(() => normalizeSince("ayer"), /since/);
  assert.throws(() => normalizeSince("99999999999999999999"), /since/);
});

test("normalizeSince rechaza entradas ambiguas (regresión: caían en 1970 o en la TZ del host)", () => {
  // Números que no son epoch de 10 (s) ni 13 (ms) dígitos: '2026' (el año) daba 1970-01-01T00:33:46Z.
  assert.throws(() => normalizeSince("2026"), /since/);
  assert.throws(() => normalizeSince("20260601"), /since/);
  assert.throws(() => normalizeSince("171987840000"), /since/);
  // Date.parse('-5') es 2001-05-01: no es una fecha que alguien quiera.
  assert.throws(() => normalizeSince("-5"), /since/);
  // ISO con hora pero sin zona: dependía de la TZ del host del MCP.
  assert.throws(() => normalizeSince("2026-06-01T10:00"), /since/);
  assert.throws(() => normalizeSince("2026-06-01T10:00:00"), /since/);
  // Fecha inexistente: Date.parse la desbordaba a marzo.
  assert.throws(() => normalizeSince("2026-02-30"), /since/);
  assert.throws(() => normalizeSince("June 1, 2026"), /since/);
  // Siguen valiendo: con Z, con offset (con y sin ':'), fracción de segundo.
  assert.equal(normalizeSince("2026-06-01T10:00Z"), "2026-06-01T10:00:00.000Z");
  assert.equal(normalizeSince("2026-06-01T10:00:00-0300"), "2026-06-01T13:00:00.000Z");
  assert.equal(normalizeSince("2026-06-01T10:00:00.250+00:00"), "2026-06-01T10:00:00.250Z");
});

test("slugUnderPrefix respeta el borde de carpeta", () => {
  assert.equal(slugUnderPrefix("clientes", "clientes"), true);
  assert.equal(slugUnderPrefix("clientes/solera", "clientes"), true);
  assert.equal(slugUnderPrefix("clientes/solera/q3", "clientes/solera"), true);
  assert.equal(slugUnderPrefix("clientes-blog/x", "clientes"), false);
  assert.equal(slugUnderPrefix("clientesxyz", "clientes"), false);
  assert.equal(slugUnderPrefix("clientes/a", "clientes/"), true);
});
