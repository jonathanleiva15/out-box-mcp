/**
 * Mesa de revisión 2026-10-04: el stdio habla inglés por default (mercado EE.UU.);
 * OUTBOX_LANG=es vuelve al español. Y outbox_create_share manda la contraseña.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./harness.mjs";

test("sin OUTBOX_LANG las tools salen en inglés; con es, en español", async () => {
  const en = await startHarness({ env: { OUTBOX_LANG: "", OUTBOX_TOOLSETS: "all" } });
  try {
    const { tools } = await en.client.listTools();
    const views = tools.find((t) => t.name === "outbox_page_views");
    assert.equal(views?.title, "Outbox: who opened a page");
    const share = tools.find((t) => t.name === "outbox_create_share");
    assert.match(share?.inputSchema?.properties?.passphrase?.description ?? "", /password/i);
    assert.match(share?.inputSchema?.properties?.remindIfUnopenedHours?.description ?? "", /hours/i);
    const unopened = tools.find((t) => t.name === "outbox_unopened_links");
    assert.equal(unopened?.title, "Outbox: links nobody has opened");
    assert.match(unopened?.description ?? "", /per-recipient/);
  } finally {
    await en.close();
  }
  const es = await startHarness();
  try {
    const { tools } = await es.client.listTools();
    assert.equal(tools.find((t) => t.name === "outbox_page_views")?.title, "Outbox: quién abrió una página");
  } finally {
    await es.close();
  }
});

test("outbox_create_share pasa la passphrase al back", async () => {
  const h = await startHarness({ env: { OUTBOX_TOOLSETS: "all" } });
  try {
    h.respond = (req) => (req.path === "/api/share" ? { status: 200, json: { token: "a".repeat(32), passphraseProtected: true } } : undefined);
    const r = await h.call("outbox_create_share", { resource: "propuesta", passphrase: "blue-river-42" });
    assert.equal(r.isError, false, r.text);
    const sent = h.calls.find((c) => c.path === "/api/share");
    assert.equal(sent?.body?.passphrase, "blue-river-42");
  } finally {
    await h.close();
  }
});
