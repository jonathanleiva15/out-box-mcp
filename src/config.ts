/**
 * Resolución de credenciales del Outbox MCP server.
 *
 * Decisión de arquitectura (decisiones-jonathan.md §14.4): auth LOCAL por KEY.
 * Precedencia:
 *   1. env OUTBOX_API_KEY  (recomendado para entornos cloud/headless — dropear una
 *      agent key folder-scoped para acotar el blast radius).
 *   2. ~/.outboxrc         (el mismo archivo que escribe el CLI con `outbox login`).
 *
 * NUNCA se loguea la key. El server no escribe ~/.outboxrc (eso lo hace el CLI).
 *
 * Formato EXACTO de ~/.outboxrc (fuente: out-box/cli/src/lib/config.ts +
 * out-box/cli/src/types.ts → interface OutboxConfig): JSON serializado con
 * `JSON.stringify(cfg, null, 2)`. Las claves son:
 *   {
 *     "apiBase":   "https://api.out-box.dev",
 *     "apiKey":    "outbox_...",
 *     "username":  "jonathan",
 *     "vaultPath": "..."        // opcional
 *   }
 * El CLI lo escribe con permisos 0600 (unix) / ACL owner-only (win32, icacls).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OutboxConfig {
  apiKey: string;
  /** Username del owner, si está disponible (para defaultear `user` en las tools). */
  user?: string;
  /** apiBase del rc, si está presente (el CLI lo persiste). Informativo. */
  apiBase?: string;
  source: "env" | "rc";
}

/** Forma EXACTA del ~/.outboxrc que escribe el CLI (out-box/cli/src/types.ts). */
interface OutboxRcFile {
  apiBase?: unknown;
  apiKey?: unknown;
  username?: unknown;
  /**
   * Reservado: lo escribe el CLI (`outbox login`) para la integración con el vault.
   * El MCP server NO lo usa hoy; se declara para documentar el shape real del rc y
   * que el parse no sorprenda a quien lo lea. No remover del parse.
   */
  vaultPath?: unknown;
}

/**
 * Parsea ~/.outboxrc según el formato REAL del CLI: JSON con `apiKey` + `username`.
 * No es best-effort ni adivina formatos alternativos — matchea el escritor real.
 * Si el archivo no es JSON válido o le falta `apiKey`, devuelve `{}` (sin key).
 */
function parseRc(raw: string): { apiKey?: string; user?: string; apiBase?: string } {
  let parsed: OutboxRcFile;
  try {
    parsed = JSON.parse(raw) as OutboxRcFile;
  } catch {
    // El CLI SIEMPRE escribe JSON. Si no parsea, el archivo está corrupto/foráneo.
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};

  const apiKey = typeof parsed.apiKey === "string" && parsed.apiKey ? parsed.apiKey : undefined;
  const user =
    typeof parsed.username === "string" && parsed.username ? parsed.username : undefined;
  const apiBase = typeof parsed.apiBase === "string" && parsed.apiBase ? parsed.apiBase : undefined;
  return { apiKey, user, apiBase };
}

/**
 * Resuelve la credencial. Devuelve `null` si no hay ninguna (AX-10): el server
 * arranca igual y cada tool responde un error accionable ("configurá
 * OUTBOX_API_KEY…") en lugar de morir antes de conectar ("server disconnected"
 * sin mensaje en el host).
 */
export function loadConfig(): OutboxConfig | null {
  const envKey = process.env.OUTBOX_API_KEY?.trim();
  const envUser = process.env.OUTBOX_USER?.trim();
  if (envKey) return { apiKey: envKey, user: envUser || undefined, source: "env" };

  const rcPath = process.env.OUTBOX_RC?.trim() || join(homedir(), ".outboxrc");
  try {
    const parsed = parseRc(readFileSync(rcPath, "utf8"));
    if (parsed.apiKey) {
      return {
        apiKey: parsed.apiKey,
        user: parsed.user ?? envUser ?? undefined,
        apiBase: parsed.apiBase,
        source: "rc",
      };
    }
  } catch {
    /* no existe ~/.outboxrc o no se pudo leer */
  }

  return null;
}
