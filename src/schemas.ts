/**
 * Esquemas Zod compartidos del Outbox MCP server.
 *
 * Constraints reusadas verbatim por muchas tools (slug/path, prefix de carpeta,
 * recurso a compartir, username del owner). Antes vivían inline en cada una de las
 * 54 tools (ej. `z.string().min(1).max(200)` repetido 28 veces), lo que abría la
 * puerta a que una tool quedara con un límite distinto por accidente. Centralizar
 * acá fija una sola fuente de verdad; cada tool sigue agregando su `.describe(...)`
 * (y `.optional()` cuando corresponda) sobre la base, así el shape de `inputSchema`
 * no cambia.
 */
import { z } from "zod";

/**
 * Regex path-slug jerárquico. Copiado VERBATIM del backend
 * (`out-box/worker/src/lib/slug.ts` → `PATH_SLUG_RE`) para que el MCP rechace en
 * el cliente exactamente lo mismo que rechaza el worker, sin round-trip.
 *
 * SEGURIDAD: rechaza explícitamente
 *   - leading / trailing `/`
 *   - `//` (slash doble)
 *   - segmentos vacíos
 *   - segmentos `.` o `..` (path traversal — el vector que este fix cierra)
 *   - cualquier char fuera de [A-Za-z0-9_-]
 * Max 6 niveles de profundidad, max 64 chars por segmento.
 */
const PATH_SLUG_RE = /^[A-Za-z0-9_-]{1,64}(\/[A-Za-z0-9_-]{1,64}){0,5}$/;

/**
 * Valida un slug/path jerárquico igual que `isValidSlug` del backend: además del
 * regex, doble-check de que ningún segmento sea `.`, `..` o vacío (defensa en
 * profundidad — el regex ya lo bloquea, pero mantenemos el mismo contrato).
 */
function isValidSlugPath(value: string): boolean {
  if (value.length === 0 || value.length > 200) return false;
  if (!PATH_SLUG_RE.test(value)) return false;
  return !value.split("/").some((seg) => seg === "." || seg === ".." || seg === "");
}

const SLUG_PATH_ERROR =
  "Slug/path inválido: solo [A-Za-z0-9_-] por segmento, separados por '/', máx. 6 niveles, sin '.'/'..' (path traversal). / Invalid slug/path.";

/** Slug/path jerárquico de una página o recurso (ej. 'briefings/hoy'). */
export const SLUG_SCHEMA = z
  .string()
  .min(1)
  .max(200)
  .refine(isValidSlugPath, SLUG_PATH_ERROR);

/** Prefix de una carpeta (ej. 'clientes/solera'). Misma forma que un slug. */
export const PREFIX_SCHEMA = z
  .string()
  .min(1)
  .max(200)
  .refine(isValidSlugPath, SLUG_PATH_ERROR);

/**
 * Texto libre acotado (NO es un slug/path — no se concatena a ninguna URL de
 * recurso). Se usa para el `q` de búsqueda full-text y el `filename` informativo
 * del upload. Mantiene el shape laxo previo para no romper búsquedas con espacios,
 * acentos, etc.
 */
export const FREE_TEXT_SCHEMA = z.string().min(1).max(200);

/** Username del owner (para defaultear/acotar `user` en las tools). */
export const USER_SCHEMA = z.string().min(1).max(64);
