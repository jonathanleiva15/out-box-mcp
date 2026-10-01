/**
 * Invariantes cross-repo (pasada 4): algunos tests comparan contra un repo hermano
 * (out-box/worker) con el layout de la carpeta local. Fuera de esa carpeta se
 * saltean, pero en CI eso las dejaba sin correr nunca: el workflow hace checkout del
 * hermano y define OUTBOX_REQUIRE_SIBLINGS=1, y con esa variable un hermano faltante
 * FALLA en vez de saltearse. No es un test (no matchea *.test.mjs).
 */
import { existsSync } from "node:fs";

/** ¿El entorno exige los repos hermanos? (CI del MCP: OUTBOX_REQUIRE_SIBLINGS=1). */
export function siblingsRequired(env = process.env) {
  return env.OUTBOX_REQUIRE_SIBLINGS === "1";
}

/**
 * true si `file` existe. Si no existe: con OUTBOX_REQUIRE_SIBLINGS=1 tira (el test
 * falla); sin ella saltea el test (`t.skip`) y devuelve false.
 */
export function requireSibling(t, file, label, env = process.env) {
  if (existsSync(file)) return true;
  if (siblingsRequired(env)) {
    throw new Error(`${label}: falta ${file} y OUTBOX_REQUIRE_SIBLINGS=1 (hacé checkout del repo hermano)`);
  }
  t.skip(`${label} no disponible junto al paquete`);
  return false;
}
