/**
 * Drafts anónimos (0.4.0): outbox_publish_anonymous. Solo se registra SIN credencial,
 * pega a POST /api/anon/publish sin Bearer y traduce 429 / 503 / 403 / 413 a mensajes
 * claros. El worker de la tanda 1 todavía no está desplegado: el back es el harness,
 * con las respuestas del contrato (spec drafts-anonimos-2026-10-11).
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { startHarness } from "./harness.mjs";
import { anonPublishResult } from "../dist/tools.js";
import { OutboxApiError, describeError, formatError } from "../dist/services/client.js";

const TOOL = "outbox_publish_anonymous";
const EXPIRES = "2026-10-14T12:00:00.000Z";
const CREATED = {
  id: "a1b2c3d4e5",
  url: "https://out-box.dev/p/a1b2c3d4e5",
  expiresAt: EXPIRES,
  ttlSeconds: 259200,
  claimToken: "anc_0123456789abcdef0123456789abcdef",
  claimUrl: "https://out-box.dev/claim/page#a1b2c3d4e5.anc_0123456789abcdef0123456789abcdef",
};

describe("con credencial", () => {
  let h;
  before(async () => {
    h = await startHarness({ env: { OUTBOX_TOOLSETS: "all" } });
  });
  after(async () => h?.close());

  test("outbox_publish_anonymous NO está en tools/list", async () => {
    const { tools } = await h.client.listTools();
    assert.ok(tools.length > 0);
    assert.equal(tools.find((t) => t.name === TOOL), undefined);
  });

  test("las instructions no hablan del modo sin cuenta", () => {
    assert.doesNotMatch(h.client.getInstructions() ?? "", /SIN CUENTA/);
  });
});

describe("sin credencial", () => {
  let h;
  before(async () => {
    h = await startHarness({ withKey: false });
  });
  after(async () => h?.close());

  test("outbox_publish_anonymous está en tools/list, no destructiva, y las instructions la explican", async () => {
    const { tools } = await h.client.listTools();
    const t = tools.find((x) => x.name === TOOL);
    assert.ok(t, "outbox_publish_anonymous no está registrada");
    assert.equal(t.annotations?.destructiveHint, false);
    assert.equal(t.annotations?.readOnlyHint, false);
    assert.match(t.description, /72 h/);
    assert.match(t.description, /claimUrl/);
    assert.match(t.description, /datos privados/);
    assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ["html", "markdown", "model", "title"]);
    assert.match(h.client.getInstructions() ?? "", /SIN CUENTA/);
    // Las tools de la biblioteca siguen listadas (y piden la key al llamarlas).
    assert.ok(tools.find((x) => x.name === "outbox_publish"));
  });

  test("publica por POST /api/anon/publish sin Bearer y devuelve url, expiresAt, claimUrl y el mensaje para el humano", async () => {
    h.reset();
    h.respond = (req) => (req.method === "POST" && req.path === "/api/anon/publish" ? { status: 201, json: CREATED } : undefined);
    const r = await h.call(TOOL, { markdown: "# Hola", title: "Notas" });
    assert.equal(r.isError, false, r.text);
    assert.equal(h.calls.length, 1);
    const sent = h.calls[0];
    assert.equal(sent.headers.authorization, undefined);
    assert.deepEqual(sent.body, { markdown: "# Hola", title: "Notas" });
    const out = JSON.parse(r.text);
    assert.equal(out.url, CREATED.url);
    assert.equal(out.expiresAt, EXPIRES);
    assert.equal(out.claimUrl, CREATED.claimUrl);
    assert.equal(out.ttlSeconds, 259200);
    // El token suelto no se devuelve: ya viaja en el fragmento del claimUrl.
    assert.equal(out.claimToken, undefined);
    assert.match(out.message, /Abrí este link para guardarla en tu cuenta antes del 2026-10-14 12:00 UTC/);
    assert.ok(out.message.includes(CREATED.claimUrl));
  });

  test("html y markdown juntos o ninguno → error local, sin pegarle al back", async () => {
    h.reset();
    const both = await h.call(TOOL, { html: "<p>a</p>", markdown: "a" });
    assert.equal(both.isError, true);
    assert.equal(both.structured.error.code, "conflicting_content");
    const none = await h.call(TOOL, { title: "x" });
    assert.equal(none.isError, true);
    assert.equal(none.structured.error.code, "missing_content");
    assert.equal(h.calls.length, 0);
  });

  test("429 → mensaje claro con los límites, Retry-After y la sugerencia de cuenta", async () => {
    h.reset();
    h.respond = () => ({
      status: 429,
      headers: { "retry-after": "1800" },
      json: { error: "rate_limited", message: "Demasiadas publicaciones sin cuenta desde esta IP", retryAfter: 1800 },
    });
    const r = await h.call(TOOL, { html: "<p>hola</p>" });
    assert.equal(r.isError, true);
    assert.match(r.text, /^Error 429 \(sin cuenta\)/);
    assert.match(r.text, /2 por hora y 3 por día por IP, 5 por día por red/);
    assert.match(r.text, /~1800s/);
    assert.match(r.text, /OUTBOX_API_KEY/);
    assert.doesNotMatch(r.text, /plan/);
    const err = r.structured.error;
    assert.equal(err.code, "rate_limited");
    assert.equal(err.status, 429);
    assert.equal(err.retryable, true);
    assert.equal(err.retryAfter, 1800);
    assert.equal(err.upgradeCta, undefined);
  });

  test("503 anon_paused → pausa temporal, reintentable más tarde", async () => {
    h.reset();
    h.respond = () => ({ status: 503, json: { error: "anon_paused", message: "paused" } });
    const r = await h.call(TOOL, { html: "<p>hola</p>" });
    assert.equal(r.isError, true);
    assert.match(r.text, /^Error 503 \(anon_paused\)/);
    assert.match(r.text, /pausada temporalmente/);
    assert.equal(r.structured.error.code, "anon_paused");
    assert.equal(r.structured.error.retryable, true);
  });

  test("403 anon_publish_disabled → no habilitada, no reintentable", async () => {
    h.reset();
    h.respond = () => ({ status: 403, json: { error: "anon_publish_disabled", message: "off" } });
    const r = await h.call(TOOL, { html: "<p>hola</p>" });
    assert.equal(r.isError, true);
    assert.match(r.text, /no está habilitada/);
    assert.doesNotMatch(r.text, /scope/);
    assert.equal(r.structured.error.retryable, false);
  });

  test("413 sin cuenta no se informa como límite de plan", async () => {
    h.reset();
    h.respond = () => ({ status: 413, json: { error: "html_too_large", message: "Sin cuenta, el límite es 2 MiB de HTML." } });
    const r = await h.call(TOOL, { html: "<p>hola</p>" });
    assert.equal(r.isError, true);
    assert.match(r.text, /2 MiB de HTML o 256 KiB de markdown/);
    assert.doesNotMatch(r.text, /límite del plan/);
  });
});

test("sin OUTBOX_LANG la tool y el mensaje para el humano salen en inglés", async () => {
  const h = await startHarness({ withKey: false, env: { OUTBOX_LANG: "" } });
  try {
    const { tools } = await h.client.listTools();
    assert.equal(tools.find((t) => t.name === TOOL)?.title, "Outbox: publish without an account (72 h)");
    h.respond = () => ({ status: 201, json: CREATED });
    const r = await h.call(TOOL, { html: "<p>hi</p>" });
    assert.equal(r.isError, false, r.text);
    assert.match(JSON.parse(r.text).message, /Open this link to save it to your Outbox account before 2026-10-14 12:00 UTC/);
  } finally {
    await h.close();
  }
});

test("anonPublishResult tolera un back sin claimUrl (sin mensaje de reclamo)", () => {
  const out = anonPublishResult({ id: "x", url: "https://out-box.dev/p/x", expiresAt: "no-es-fecha" }, "es");
  assert.equal(out.claimUrl, undefined);
  assert.match(out.message, /^Publicada sin cuenta: https:\/\/out-box\.dev\/p\/x \(la ve cualquiera con el link\)\.$/);
});

test("el mapeo de 429 solo aplica al publish sin cuenta", () => {
  const other = new OutboxApiError(429, { error: "rate_limited", retryIn: 30 }, "/api/u/jonathan/x/comments");
  assert.doesNotMatch(formatError(other), /sin cuenta/);
  assert.equal(describeError(other).retryAfter, 30);
});
