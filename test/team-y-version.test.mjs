/**
 * 2026-10-11 (hilo "skill y MCP al día"): `409 seat_limit` del Team (out-box #42) llega
 * con un fix accionable, y outbox_me / outbox_capabilities avisan cuando el back anuncia
 * un @out-box/mcp más nuevo (clients.mcp.latest) que el paquete instalado.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OutboxApiError, describeError } from "../dist/services/client.js";
import { cmpSemver, mcpUpdateFrom } from "../dist/tools.js";

test("seat_limit: fix con el tope, sin reintento, y contacto solo de out-box.dev", () => {
  const body = { error: "seat_limit", limit: 10, used: 10, message: "x", contact: "hello@out-box.dev" };
  const e = describeError(new OutboxApiError(409, body, "/api/teams/acme/invites"));
  assert.equal(e.code, "seat_limit");
  assert.equal(e.retryable, false);
  assert.match(e.fix, /10 publishers/);
  assert.match(e.fix, /hello@out-box\.dev/);
  assert.equal(e.upgradeCta, undefined);
  const evil = describeError(new OutboxApiError(409, { ...body, contact: "attacker@evil.example" }, "/x"));
  assert.doesNotMatch(evil.fix, /evil/);
});

test("cmpSemver compara X.Y.Z numéricamente", () => {
  assert.ok(cmpSemver("0.4.0", "0.3.1") > 0);
  assert.ok(cmpSemver("0.10.0", "0.9.9") > 0);
  assert.equal(cmpSemver("1.2.3", "1.2.3"), 0);
  assert.ok(cmpSemver("0.3.1", "0.4.0") < 0);
});

test("mcpUpdateFrom: solo avisa si latest es mayor y válido", () => {
  const caps = (latest) => ({ clients: { mcp: { latest, install: "npx -y @out-box/mcp" } } });
  const u = mcpUpdateFrom(caps("0.4.0"), "0.3.1");
  assert.equal(u.latest, "0.4.0");
  assert.equal(u.current, "0.3.1");
  assert.match(u.notice, /0\.3\.1 → 0\.4\.0/);
  assert.equal(mcpUpdateFrom(caps("0.3.1"), "0.3.1"), undefined);
  assert.equal(mcpUpdateFrom(caps("0.2.0"), "0.3.1"), undefined);
  assert.equal(mcpUpdateFrom(caps("1.0.0; rm -rf"), "0.3.1"), undefined);
  assert.equal(mcpUpdateFrom(null, "0.3.1"), undefined);
  assert.equal(mcpUpdateFrom(caps("0.4.0"), undefined), undefined);
});
