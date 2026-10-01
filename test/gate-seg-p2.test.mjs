/**
 * Gate de la pasada de seguridad 2 (2026-10-01): errores nuevos del worker.
 *  - 403 expiry_escalation / slug_whitelist_escalation (keys.ts, agents.ts): una key
 *    con vencimiento o slugWhitelist no emite ni rota keys sin esos límites. Antes caían
 *    al genérico del 403 ("falta permiso"), que invita a pedir más scopes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { OutboxApiError, describeError, formatError } from "../dist/services/client.js";

test("expiry_escalation: no reintentable, con maxExpiresAt y remedio propio", () => {
  const e = new OutboxApiError(
    403,
    { error: "expiry_escalation", message: "Una key con vencimiento no puede…", maxExpiresAt: "2026-10-01T10:00:00.000Z" },
    "/api/keys",
  );
  const d = describeError(e);
  assert.equal(d.code, "expiry_escalation");
  assert.equal(d.retryable, false);
  assert.equal(d.maxExpiresAt, "2026-10-01T10:00:00.000Z");
  assert.match(d.fix, /venzan antes/);
  assert.match(formatError(e), /expiry_escalation\): no reintentable/);
});

test("slug_whitelist_escalation: no reintentable, con allowedSlugs", () => {
  const e = new OutboxApiError(
    403,
    { error: "slug_whitelist_escalation", message: "…", allowedSlugs: ["today"] },
    "/api/agents/instantiate",
  );
  const d = describeError(e);
  assert.equal(d.retryable, false);
  assert.deepEqual(d.allowedSlugs, ["today"]);
  assert.match(d.fix, /slugWhitelist dentro de la suya/);
});

test("invalid_agent (400 con hint del back): el hint es el remedio", () => {
  const e = new OutboxApiError(
    400,
    { error: "invalid_agent", index: 0, field: "slugTarget", hint: "slugTarget es obligatorio: un slug o una carpeta con comodín." },
    "/api/u/joni/agents",
  );
  assert.match(describeError(e).fix, /slugTarget es obligatorio/);
});
