/**
 * Esquemas Zod compartidos del Outbox MCP server.
 *
 * Constraints reusadas verbatim por muchas tools (slug/path, prefix de carpeta,
 * recurso a compartir, username del owner, ids/tokens hex). Antes vivían inline en
 * cada tool (ej. `z.string().min(1).max(200)` repetido decenas de veces), lo que
 * abría la puerta a que una tool quedara con un límite distinto por accidente
 * (el conteo real de tools se deriva del código: `grep -c registerTool src/index.ts`,
 * no se hardcodea acá). Centralizar
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
 * recurso). Se usa para el `q` de búsqueda full-text. Mantiene el shape laxo previo
 * para no romper búsquedas con espacios, acentos, etc.
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
export const USERNAME_RE = /^[a-z0-9-]{2,32}$/;

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

/**
 * IDs/tokens hexadecimales que el backend genera y que el MCP recibe de vuelta
 * (de un list/create) para revocar/borrar un recurso. Se validan con el MISMO
 * formato exacto que emite el worker, así el cliente rechaza de entrada cualquier
 * valor que no pueda existir; y para los que viajan en la URL, el charset hex
 * (sin '/', '.', '%') cierra path-traversal de raíz igual que SLUG_SCHEMA.
 *
 * Formato copiado VERBATIM del backend:
 *   - share token → `out-box/worker/src/lib/share.ts` (16 bytes random → 32 hex).
 *   - grant id    → `out-box/worker/src/handlers/grants.ts` (regex `^[a-f0-9]{16}$`,
 *                   8 bytes random).
 *   - key id      → `shortKeyId(hash) = hash.slice(0, 8)`
 *                   (`out-box/worker/src/lib/hash.ts`) → 8 hex (prefijo del hash).
 * Si el backend cambia estos formatos, re-copiar acá (misma disciplina que las
 * regex de slug/username).
 */
function hexIdSchema(hexLen: number, label: string): z.ZodString {
  return z
    .string()
    .regex(
      new RegExp(`^[a-f0-9]{${hexLen}}$`),
      `${label} inválido: debe ser ${hexLen} caracteres hex [a-f0-9]. / Invalid ${label}.`,
    );
}

/** Share token (link público anónimo): 32 chars hex. */
export const SHARE_TOKEN_SCHEMA = hexIdSchema(32, "share token");

/** Grant id user-to-user: 16 chars hex. */
export const GRANT_ID_SCHEMA = hexIdSchema(16, "grant id");

/** shortKeyId de una API key: 8 chars hex (prefijo del hash de la key). */
export const KEY_ID_SCHEMA = hexIdSchema(8, "key id");

/**
 * PEN-03 · código MFA para el step-up (TOTP de 6 dígitos o recovery code). El
 * back lo exige al emitir/rotar keys e instanciar agentes si la cuenta tiene MFA
 * (por Bearer, siempre). Lo da el USUARIO en el momento: nunca inventarlo ni
 * guardarlo.
 */
export const MFA_CODE_SCHEMA = z
  .string()
  .regex(/^[0-9A-Za-z-]{6,20}$/, "mfaCode inválido: TOTP de 6 dígitos o recovery code. / Invalid mfaCode.")
  .describe("Código MFA del usuario (TOTP o recovery), solo si la op respondió step_up_required. Pedíselo al usuario; nunca lo inventes ni lo guardes. Cada código sirve para UNA operación: no lo reuses en otra tool ni en un reintento (si responde code_already_used, pedí el próximo)");

/**
 * AX-04 · clave de idempotencia (header `Idempotency-Key`). La elige el agente para
 * poder REUSARLA si reintenta la misma operación; si no la pasa, el MCP genera un
 * UUID por invocación. Charset acotado: viaja en un header HTTP.
 */
export const IDEMPOTENCY_KEY_SCHEMA = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/, "idempotencyKey: 8-128 chars [A-Za-z0-9_.:-]. / Invalid idempotencyKey.");

/**
 * Path de un archivo local (AX P4). La validación de seguridad real (confinamiento a
 * OUTBOX_FILES_DIR, symlinks, extensiones) vive en src/files.ts; acá solo se acota
 * el largo y se rechazan bytes nulos.
 */
export const FILE_PATH_SCHEMA = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => !v.includes("\0"), "file_path inválido. / Invalid file_path.");
