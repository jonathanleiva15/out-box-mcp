/**
 * Gate de la pasada de seguridad 3 (2026-10-01): errores nuevos del worker.
 *  - 403 comment_scope_required (auth-visitor.ts): comentar, sugerir, reaccionar o
 *    agregar datos en una página de OTRA cuenta exige publish:<propio> amplio. Una key
 *    de solo lectura o acotada nunca va a poder: no reintentable y sin pedir "más scope".
 *  - 400 invalid_expiresInDays (issued-expiry.ts): una key agent no emite share links ni
 *    grants sin vencimiento.
 *  - 403 expiry_escalation ahora también sale de share y grants.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { OutboxApiError, describeError, formatError } from "../dist/services/client.js";

test("comment_scope_required: no reintentable, explica que no escribe en otra cuenta", () => {
  const e = new OutboxApiError(
    403,
    { error: "comment_scope_required", message: "This key cannot write on another account's pages…", missingScope: "publish:victima" },
    "/api/u/mallory/inbox/comments",
  );
  const d = describeError(e);
  assert.equal(d.code, "comment_scope_required");
  assert.equal(d.retryable, false);
  assert.equal(d.missingScope, "publish:victima");
  assert.match(d.fix, /páginas de otra cuenta/);
  assert.match(d.fix, /No reintentes/);
  assert.match(formatError(e), /comment_scope_required/);
});

test("invalid_expiresInDays: pide un número de días, no reintentar con null", () => {
  const e = new OutboxApiError(
    400,
    { error: "invalid_expiresInDays", message: "Agent keys must set expiresInDays between 1 and 365 (null is not allowed)" },
    "/api/share",
  );
  const d = describeError(e);
  assert.equal(d.retryable, false);
  assert.match(d.fix, /expiresInDays/);
  assert.match(d.fix, /No reintentes con null/);
});

test("expiry_escalation desde share/grants menciona links y grants", () => {
  const e = new OutboxApiError(
    403,
    { error: "expiry_escalation", message: "…", maxExpiresAt: "2026-10-01T10:00:00.000Z" },
    "/api/grants",
  );
  const d = describeError(e);
  assert.equal(d.retryable, false);
  assert.match(d.fix, /share links y grants/);
  assert.match(d.fix, /venzan antes/);
});
