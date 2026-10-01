/**
 * Gate pasada 5 (2026-09-30): PUT /api/u/:user/:slug/draft puede devolver
 * `previewSkipped: 'missing_share_scope'` sin previewUrl (key publish-only o
 * connector OAuth con solo outbox:write). outbox_go_live tiene que describir ese
 * estado (ES y EN) y devolver la respuesta tal cual, sin inventar un link.
 * Corren contra dist/ (lo que se shipea).
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { startHarness } from "./harness.mjs";
import { TOOL_TEXT_EN } from "../dist/tools-en.js";

let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});
beforeEach(() => h.reset());

test("outbox_go_live (ES): la descripción explica previewSkipped:'missing_share_scope'", async () => {
  const { tools } = await h.client.listTools();
  const d = tools.find((t) => t.name === "outbox_go_live").description;
  assert.match(d, /previewSkipped:'missing_share_scope'/);
  assert.match(d, /share\|template/);
});

test("outbox_go_live (EN, connector remoto): mismo contrato", () => {
  const d = TOOL_TEXT_EN.outbox_go_live.description;
  assert.match(d, /previewSkipped:'missing_share_scope'/);
  assert.match(d, /share\|template/);
});

test("outbox_go_live draft:true sin scope share: devuelve previewSkipped sin previewUrl y no manda previewExpiresInDays", async () => {
  h.respond = () => ({ json: { ok: true, slug: "informe", draft: true, visibility: "public", previewSkipped: "missing_share_scope" } });
  const r = await h.call("outbox_go_live", { slug: "informe", draft: true });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(h.calls[0].body, { draft: true }, "nunca previewExpiresInDays:null (400 para keys agent)");
  assert.match(r.text, /missing_share_scope/);
  assert.doesNotMatch(r.text, /previewUrl/);
});
