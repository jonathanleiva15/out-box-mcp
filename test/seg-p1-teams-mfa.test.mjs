/**
 * Seguridad pasada 1 (2026-10-01): el worker pide step-up MFA para sumar un miembro
 * a un org (una sesión robada se sumaba a sí misma con canManageKeys y emitía company
 * keys sin 2º factor). outbox_add_team_member tiene que aceptar mfaCode y mandarlo.
 * Corre contra dist/.
 */
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startHarness } from "./harness.mjs";

let h;
before(async () => {
  h = await startHarness({ env: { OUTBOX_TOOLSETS: "all" } });
});
after(async () => {
  await h.close();
});
beforeEach(() => h.reset());

describe("seg p1 · outbox_add_team_member + step-up MFA", () => {
  test("step_up_required → fix pide mfaCode; con mfaCode llega al body del POST", async () => {
    h.respond = () => ({ status: 401, json: { error: "step_up_required" } });
    const r = await h.call("outbox_add_team_member", { handle: "acme", user: "sol" });
    assert.equal(r.isError, true);
    assert.equal(r.structured.error.code, "step_up_required");
    assert.match(r.structured.error.fix, /mfaCode/);

    h.reset();
    h.respond = (c) =>
      c.body?.mfaCode === "123456" ? { json: { ok: true, user: "sol", role: "member" } } : { status: 401, json: { error: "step_up_required" } };
    const ok = await h.call("outbox_add_team_member", { handle: "acme", user: "sol", mfaCode: "123456" });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(h.calls[0].method, "POST");
    assert.equal(h.calls[0].path, "/api/teams/acme/members");
    assert.deepEqual(h.calls[0].body, { user: "sol", mfaCode: "123456" });
  });

  test("sin mfaCode no manda el campo; mfaCode inválido no llama al back", async () => {
    h.respond = () => ({ json: { ok: true, user: "sol", role: "member" } });
    await h.call("outbox_add_team_member", { handle: "acme", user: "sol" });
    assert.deepEqual(h.calls[0].body, { user: "sol" });
    h.reset();
    const bad = await h.call("outbox_add_team_member", { handle: "acme", user: "sol", mfaCode: "x" });
    assert.equal(bad.isError, true);
    assert.equal(h.calls.length, 0);
  });
});
