/**
 * Regresiones de la pasada 5 (2026-09-30) del repo out-box-mcp:
 *   - outbox_append describía `title` y `visibility` como "solo si se crea la página",
 *     pero el worker (lib/daily.ts → dailyAppendRMW) los aplica en CADA append al
 *     documento del día (last-write-wins) y el primer append de cada día UTC sin
 *     visibility lo crea private (no hereda el día anterior). Un agente que seguía la
 *     descripción podía exponer los bloques de hoy (visibility:'public' en un append
 *     "que se ignora") o perder la URL pública al día siguiente (omitirla "porque ya
 *     se creó"). Texto ES (stdio) y EN (connector remoto) alineados.
 *   - Gate pasada 5: el worker pasó a heredar visibility/title/project del día anterior
 *     al nacer un día nuevo (son de la página). Las descripciones dicen "hereda" y el
 *     contrato con el worker chequea `req.visibility ?? prev?.visibility ?? 'private'`.
 *   - Ronda 4 (2026-10-01): el worker dejó de aplicar title/visibility en CADA append.
 *     Ahora solo el append que CREA el día los aplica (o los hereda); uno de
 *     continuación los ignora salvo `applyAttributes:true` y los devuelve en
 *     `ignoredAttributes`. Las descripciones y el contrato con el worker siguen eso.
 * Corren contra dist/ (lo que se shipea).
 */
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startHarness } from "./harness.mjs";
import { requireSibling } from "./siblings.mjs";
import { TOOL_TEXT_EN } from "../dist/tools-en.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});
beforeEach(() => h.reset());

async function appendParams() {
  const { tools } = await h.client.listTools();
  const t = tools.find((x) => x.name === "outbox_append");
  assert.ok(t, "outbox_append registrada");
  return t.inputSchema.properties;
}

describe("outbox_append · title/visibility se aplican al crear el día (ronda 4: no en cada append)", () => {
  test("ES (stdio): la descripción dice que se aplican al crear el día, heredan y se ignoran después salvo applyAttributes", async () => {
    const p = await appendParams();
    for (const param of ["title", "visibility"]) {
      const d = p[param].description;
      assert.doesNotMatch(d, /CADA append/, `${param}: el worker ya no los aplica en cada append`);
      assert.doesNotMatch(d, /last-write-wins/, param);
      assert.match(d, /al CREAR el día/, `${param}: tiene que decir que se aplica al crear el día`);
      assert.match(d, /hereda (el|la) del día anterior/, `${param}: tiene que avisar que el día nuevo hereda`);
      assert.match(d, /se ignora salvo applyAttributes:true/, `${param}: tiene que avisar que la continuación lo ignora`);
    }
    assert.match(p.visibility.description, /private si no hay día anterior/);
    assert.match(p.visibility.description, /solo si el usuario la pidió/);
    assert.match(p.visibility.description, /'public' expone los bloques de hoy/);
    assert.match(p.visibility.description, /outbox_set_visibility/);
    assert.match(p.createOnly.description, /409 daily_exists sin escribir nada/);
    assert.match(p.applyAttributes.description, /Solo si el usuario pidió cambiarlos/);
  });

  test("EN (texto del connector remoto): mismo contrato", () => {
    const en = TOOL_TEXT_EN.outbox_append.params;
    for (const param of ["title", "visibility"]) {
      assert.doesNotMatch(en[param], /EVERY append/, param);
      assert.doesNotMatch(en[param], /last-write-wins/, param);
      assert.match(en[param], /CREATES the day/, param);
      assert.match(en[param], /inherits the previous day's/, param);
      assert.match(en[param], /ignore it \(returned in ignoredAttributes\) unless applyAttributes:true/, param);
    }
    assert.match(en.visibility, /private when there is no previous day/);
    assert.match(en.visibility, /only if the user asked for it/);
    assert.match(en.createOnly, /409 daily_exists and nothing is written/);
    assert.match(en.applyAttributes, /Only if the user asked to change them/);
  });

  test("el MCP solo manda title/visibility si el agente los pasó (no pisa el día con un default)", async () => {
    h.respond = () => ({ json: { ok: true, version: 2 } });
    await h.call("outbox_append", { slug: "journal", html: "<p>x</p>" });
    await h.call("outbox_append", { slug: "journal", html: "<p>y</p>", title: "Bitácora", visibility: "public" });
    assert.equal(h.calls.length, 2);
    assert.equal("visibility" in h.calls[0].body, false, "sin visibility explícita no se manda");
    assert.equal("title" in h.calls[0].body, false, "sin title explícito no se manda");
    assert.equal(h.calls[1].body.visibility, "public");
    assert.equal(h.calls[1].body.title, "Bitácora");
  });

  test("contrato con el worker: la descripción refleja dailyAppendRMW (si el monorepo está al lado)", (t) => {
    const workerDaily = join(ROOT, "..", "out-box", "worker", "src", "lib", "daily.ts");
    // En CI (OUTBOX_REQUIRE_SIBLINGS=1) un hermano faltante falla en vez de saltearse.
    if (!requireSibling(t, workerDaily, "worker (out-box)")) return;
    const src = readFileSync(workerDaily, "utf8");
    const fn = src.slice(src.indexOf("export async function dailyAppendRMW"));
    assert.ok(fn.length > 0, "no se encontró dailyAppendRMW en el worker");
    // Title también se hereda del día anterior.
    assert.match(
      fn,
      /const title = req\.title \?\? prev\?\.title;/,
      "el worker dejó de heredar title del día anterior: actualizar las descripciones de outbox_append (tools.ts + tools-en.ts)",
    );
    // Ronda 4: en un append de continuación, visibility/title solo con applyAttributes.
    assert.match(
      fn,
      /const applyAttrs = !existing \|\| req\.applyAttributes === true;/,
      "el worker cambió cuándo aplica visibility/title: actualizar las descripciones de outbox_append (tools.ts + tools-en.ts)",
    );
    assert.match(
      fn,
      /\.\.\.\(applyAttrs && req\.visibility \? \{ visibility: req\.visibility \} : \{\}\)/,
      "el worker cambió cómo aplica visibility en un append de continuación: actualizar las descripciones de outbox_append",
    );
    // Manifest nuevo del día: hereda del día anterior; private solo sin día anterior.
    assert.match(
      fn,
      /visibility: req\.visibility \?\? prev\?\.visibility \?\? 'private'/,
      "el worker cambió el default/herencia de visibility del día nuevo: actualizar las descripciones de outbox_append (tools.ts + tools-en.ts)",
    );
    // createOnly: 409 sin escribir si el slug ya tiene daily (cualquier fecha).
    assert.match(fn, /if \(req\.createOnly\) \{/, "el worker dejó de soportar createOnly: actualizar outbox_append");
    assert.match(fn, /conflict: 'daily_exists'/, "el worker cambió el conflicto de createOnly: actualizar outbox_append y client.ts");
  });
});
