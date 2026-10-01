/**
 * Gate de la pasada de seguridad 4 (2026-10-01): contratos nuevos del worker que el
 * MCP tiene que traducir a un fix accionable.
 *
 *  - 401 step_up_required {reason:'code_already_used'}: el TOTP ahora es de UN solo
 *    uso. El texto no puede decir "credencial inválida" (antes caía al genérico del
 *    401) y el fix pide el PRÓXIMO código, no reintentar con el mismo.
 *  - 403 folder_escalation {allowedFolders}: una key confinada a carpetas solo emite o
 *    rota keys bajo esas carpetas (keys agent / rotate).
 *  - 403 slug_not_under_allowed_folder {allowedFolders} y 403 read_scope_required
 *    (page-data-policy con visitorRead).
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

describe("gate seg p4 · mfaCode de un solo uso", () => {
  test("step_up_required con reason code_already_used → pide el PRÓXIMO código, no 'credencial inválida'", async () => {
    h.respond = () => ({
      status: 401,
      json: { error: "step_up_required", reason: "code_already_used", hint: "Ese código MFA ya se usó." },
    });
    const r = await h.call("outbox_gen_agent_key", { label: "bot", verbs: ["publish"], mfaCode: "123456" });
    assert.equal(r.isError, true);
    const err = r.structured.error;
    assert.equal(err.code, "step_up_required");
    assert.equal(err.reason, "code_already_used");
    assert.equal(err.retryable, true);
    assert.match(err.fix, /PRÓXIMO código/);
    assert.match(err.fix, /No reuses/);
    assert.doesNotMatch(r.text, /credencial inválida/i);
    assert.match(r.text, /code_already_used/);
  });

  test("step_up_required sin reason → avisa que cada código sirve para una sola operación", async () => {
    h.respond = () => ({ status: 401, json: { error: "step_up_required" } });
    const r = await h.call("outbox_rotate_key", { keyId: "0000aaaa" });
    assert.equal(r.isError, true);
    assert.equal(r.structured.error.code, "step_up_required");
    assert.match(r.structured.error.fix, /mfaCode/);
    assert.match(r.structured.error.fix, /UNA sola operación/);
    assert.doesNotMatch(r.text, /credencial inválida/i);
  });

  test("el schema de mfaCode dice que es de un solo uso", async () => {
    const { tools } = await h.client.listTools();
    const t = tools.find((x) => x.name === "outbox_gen_agent_key");
    assert.match(t.inputSchema.properties.mfaCode.description, /UNA operación/);
  });
});

describe("gate seg p4 · confinamiento de carpeta", () => {
  test("folder_escalation → fix con allowedFolders y la pista de usar folder", async () => {
    h.respond = () => ({
      status: 403,
      json: { error: "folder_escalation", message: "Una key acotada a carpetas...", allowedFolders: ["clientes/acme"] },
    });
    const r = await h.call("outbox_gen_agent_key", { label: "bot", verbs: ["list"] });
    assert.equal(r.isError, true);
    const err = r.structured.error;
    assert.equal(err.code, "folder_escalation");
    assert.deepEqual(err.allowedFolders, ["clientes/acme"]);
    assert.equal(err.retryable, false);
    assert.match(err.fix, /clientes\/acme/);
    assert.match(err.fix, /folder/);
    assert.match(r.text, /folder_escalation/);
  });

  test("slug_not_under_allowed_folder → fix con las carpetas permitidas", async () => {
    h.respond = () => ({ status: 403, json: { error: "slug_not_under_allowed_folder", allowedFolders: ["a"] } });
    const r = await h.call("outbox_set_visibility", { slug: "fuera/x", visibility: "private" });
    assert.equal(r.isError, true);
    assert.equal(r.structured.error.code, "slug_not_under_allowed_folder");
    assert.deepEqual(r.structured.error.allowedFolders, ["a"]);
    assert.match(r.structured.error.fix, /\(a\)/);
  });

  test("read_scope_required → fix accionable (verbo list), no el genérico de 403", async () => {
    h.respond = () => ({
      status: 403,
      json: { error: "read_scope_required", field: "visitorRead", missingScope: "list:jonathan" },
    });
    const r = await h.call("outbox_set_visibility", { slug: "contacto", visibility: "private" });
    assert.equal(r.isError, true);
    assert.equal(r.structured.error.code, "read_scope_required");
    assert.match(r.structured.error.fix, /visitantes/);
    assert.match(r.text, /read_scope_required/);
  });
});
