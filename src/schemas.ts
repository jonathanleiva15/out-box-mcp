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

/**
 * Regex username/handle. Copiado VERBATIM del backend
 * (`out-box/worker/src/lib/users.ts` → `USERNAME_RE`; los handles de org se
 * validan con la MISMA regla en `handlers/teams.ts` → isValidUsername).
 *
 * SEGURIDAD: el charset excluye el punto y el slash, así que los dot-segments
 * (`.`/`..`) — que sobreviven a `encodeURIComponent` y podrían reescribir
 * segmentos de URL como `/api/teams/:handle/members/:user` — quedan bloqueados
 * de raíz, igual que hace SLUG_SCHEMA para los paths.
 */
const USERNAME_RE = /^[a-z0-9-]{2,32}$/;

const USERNAME_ERROR =
  "Username/handle inválido: debe matchear [a-z0-9-]{2,32} (sin '.', '..' ni '/'). / Invalid username/handle.";

/** Username del owner (para defaultear/acotar `user` en las tools). */
export const USER_SCHEMA = z
  .string()
  .min(2)
  .max(32)
  .regex(USERNAME_RE, USERNAME_ERROR);

/**
 * Handle de un org/equipo. Misma regla canónica que un username: el backend
 * valida el handle con `isValidUsername` (ver `handlers/teams.ts`, FIX 4).
 * Cada tool le agrega su `.describe(...)` encima.
 */
export const TEAM_HANDLE_SCHEMA = USER_SCHEMA;
