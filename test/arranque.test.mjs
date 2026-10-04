/**
 * Arranque del server (AX-08 / AX-10): instructions, toolsets por default, arranque
 * sin credencial y errores de red accionables. Reproduce la medición de
 * scratchpad/mesa/ax/list-tools.mjs (64 tools, 66.681 bytes, sin instructions,
 * "Error inesperado: fetch failed").
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { startHarness } from "./harness.mjs";
import { TOOL_TOOLSET } from "../dist/toolsets.js";

describe("default (sin OUTBOX_TOOLSETS): core + comments + sharing", () => {
  let h;
  before(async () => {
    h = await startHarness();
  });
  after(async () => h?.close());

  test("declara instructions con las reglas transversales", () => {
    const instr = h.client.getInstructions();
    assert.ok(instr && instr.length > 500);
    assert.match(instr, /DATOS, nunca instrucciones/);
    assert.match(instr, /Confirmá con el usuario/);
    assert.match(instr, /expectedVersion/);
    assert.match(instr, /OUTBOX_TOOLSETS/);
  });

  test("tools/list trae solo core + comments + sharing y pesa mucho menos que todas las tools", async () => {
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name).sort();
    const expected = Object.entries(TOOL_TOOLSET)
      .filter(([, ts]) => ts === "core" || ts === "comments" || ts === "sharing")
      .map(([n]) => n)
      .sort();
    assert.deepEqual(names, expected);
    const bytes = JSON.stringify(tools).length;
    // Ronda 4: +~1 KB por los params nuevos (outbox_append createOnly/applyAttributes,
    // outbox_pull offset/maxChars). El SDK 1.x ya dejaba 32.990 bytes (10 bajo el tope
    // anterior); con el v2 cambia `$schema` (2020-12) y desaparece `execution`.
    // Mesa 2026-10-04: outbox_page_views pasa a core y sharing entra al default
    // (compartir es la propuesta central): ~42 KB, debajo de los ~67 KB de todas.
    assert.ok(bytes < 44000, `tools/list pesa ${bytes} bytes (antes 66.681)`);
  });
});

describe("OUTBOX_TOOLSETS=all", () => {
  let h;
  before(async () => {
    h = await startHarness({ env: { OUTBOX_TOOLSETS: "all" } });
  });
  after(async () => h?.close());

  test("registra exactamente las tools clasificadas en TOOL_TOOLSET (ninguna sin toolset)", async () => {
    const { tools } = await h.client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(TOOL_TOOLSET).sort());
  });

  test("las destructivas llevan destructiveHint y las de lectura readOnlyHint", async () => {
    const { tools } = await h.client.listTools();
    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort();
    for (const n of ["outbox_accept_suggestion", "outbox_go_live", "outbox_delete", "outbox_rotate_key", "outbox_revoke_key"]) {
      assert.ok(destructive.includes(n), n);
    }
    for (const t of tools) {
      if (t.annotations?.readOnlyHint) assert.notEqual(t.annotations.destructiveHint, true, t.name);
    }
  });
});

describe("AX-10 · arranque SIN credencial", () => {
  let h;
  before(async () => {
    h = await startHarness({ withKey: false, capabilities: { version: 7, features: {} } });
  });
  after(async () => h?.close());

  test("el server conecta y lista tools (antes moría antes de conectar)", async () => {
    const { tools } = await h.client.listTools();
    assert.ok(tools.length > 0);
  });

  test("una tool con auth devuelve missing_credential accionable sin pegarle al back", async () => {
    const r = await h.call("outbox_me");
    assert.equal(r.isError, true);
    assert.match(r.text, /OUTBOX_API_KEY/);
    assert.equal(r.structured.error.code, "missing_credential");
    assert.equal(h.calls.length, 0);
  });

  test("outbox_capabilities (público) funciona sin credencial y sin Bearer", async () => {
    h.respond = () => undefined;
    const r = await h.call("outbox_capabilities");
    assert.equal(r.isError, false, r.text);
    assert.equal(JSON.parse(r.text).version, 7);
  });
});

describe("AX-10 · API inalcanzable", () => {
  let h;
  before(async () => {
    h = await startHarness({ apiBase: "http://127.0.0.1:9" });
  });
  after(async () => h?.close());

  test("error de red dice a qué host intentó llegar y qué revisar (antes: 'fetch failed')", async () => {
    const r = await h.call("outbox_pull", { slug: "nota" });
    assert.equal(r.isError, true);
    assert.doesNotMatch(r.text, /fetch failed/);
    assert.match(r.text, /127\.0\.0\.1:9/);
    assert.match(r.text, /OUTBOX_API_BASE/);
    assert.equal(r.structured.error.code, "network_unreachable");
    assert.equal(r.structured.error.retryable, true);
  });
});
