/**
 * 2026-10-11 (informe de conversión): el back suma `upgradeUrl` (link al plan que
 * levanta el límite) y un `fix` con el reset y lo que desbloquea. El MCP los pasa
 * al agente tal cual; un link que no es https de out-box.dev se descarta.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OutboxApiError, describeError, extractUpgradeCta } from "../dist/services/client.js";

const body = {
  error: "rate_limited",
  tier: "free",
  limit: 10,
  used: { hour: 0, day: 10 },
  upgradeTo: "pro",
  ctaUrl: "https://out-box.dev/pricing",
  upgradeUrl: "https://out-box.dev/pricing?from=limit&plan=pro",
  retryAfter: 60,
  fix: "Daily publish limit reached (10/10 on Free). Resets at 00:00 UTC. Pro unlocks 100 publishes/day: https://out-box.dev/pricing?from=limit&plan=pro",
};

test("describeError usa el fix del back y el upgradeUrl", () => {
  const e = describeError(new OutboxApiError(429, body, "/api/publish"));
  assert.equal(e.fix, body.fix);
  assert.equal(e.upgradeCta.upgradeUrl, body.upgradeUrl);
  assert.equal(e.retryable, true);
});

test("sin fix del back, el genérico incluye el link al plan", () => {
  const { fix, ...rest } = body;
  void fix;
  const e = describeError(new OutboxApiError(403, { ...rest, error: "keys_limit" }, "/api/keys"));
  assert.match(e.fix, /pricing\?from=limit&plan=pro/);
});

test("un upgradeUrl que no es de out-box.dev se descarta", () => {
  assert.equal(extractUpgradeCta({ ...body, upgradeUrl: "https://evil.example/x" }).upgradeUrl, undefined);
  assert.equal(extractUpgradeCta({ ...body, upgradeUrl: "http://out-box.dev/pricing" }).upgradeUrl, undefined);
  assert.equal(extractUpgradeCta({ ...body, upgradeUrl: 42 }).upgradeUrl, undefined);
});

test("fixSource marca el fix que vino del back (lo usa el remoto)", () => {
  assert.equal(describeError(new OutboxApiError(429, body, "/api/publish")).fixSource, "backend");
  const { fix, ...rest } = body;
  void fix;
  assert.equal(describeError(new OutboxApiError(403, { ...rest, error: "keys_limit" }, "/api/keys")).fixSource, undefined);
});
