/**
 * Ronda 4 (2026-10-01): lectura de `outbox_pull` por TROZOS explícitos en el stdio,
 * con la misma semántica que el MCP remoto (out-box-mcp-remote/src/pull-chunks.ts).
 *
 * Helper PURO (sin I/O). El registro lo usa solo si el host lo activa
 * (`RegisterOutboxToolsOptions.pullChunks`, el stdio); el remoto parte el contenido en
 * su propio adaptador y no lo activa (si no, partiría un trozo dos veces).
 *
 * Diferencia deliberada con el remoto: en el stdio el trozo es OPT-IN. Sin `offset` ni
 * `maxChars`, outbox_pull devuelve el contenido completo como siempre (contrato
 * aditivo; para páginas grandes sigue estando `file_path`). Con cualquiera de los dos,
 * cada respuesta dice qué rango trae, el total, el sha256 del contenido completo (para
 * detectar que la página cambió entre trozos) y `nextOffset`.
 */
import { createHash } from "node:crypto";

/** Trozo por defecto: ~15k tokens (igual que el remoto). */
export const PULL_CHUNK_DEFAULT = 60_000;
export const PULL_CHUNK_MIN = 1_000;
export const PULL_CHUNK_MAX = 200_000;

export interface PullChunk {
  /** Offset de este trozo, en caracteres (UTF-16, como `String.prototype.length`). */
  offset: number;
  /** Caracteres de este trozo. */
  length: number;
  /** Caracteres del contenido completo. */
  totalChars: number;
  /** Offset del próximo trozo; null si este llega al final. */
  nextOffset: number | null;
  /** true = el trozo es el contenido ENTERO (offset 0 hasta el final). */
  complete: boolean;
  /** sha256 (hex) del contenido completo: igual en todos los trozos de una misma versión. */
  contentSha256: string;
  /** El texto del trozo. */
  chunk: string;
}

/** Fin del trozo sin partir un par sustituto UTF-16 (emoji, CJK extendido). */
export function chunkEnd(content: string, offset: number, maxChars: number): number {
  let end = Math.min(content.length, offset + maxChars);
  if (end < content.length && end > offset) {
    const c = content.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  }
  return end;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** ¿`offset` cae fuera del contenido? (un offset == total solo vale si el contenido está vacío). */
export function offsetOutOfRange(offset: number, total: number): boolean {
  return offset > total || (offset === total && total > 0);
}

/**
 * Parte `content` en el trozo pedido. El llamador valida antes el rango con
 * `offsetOutOfRange` (acá se asume válido).
 */
export function sliceContent(content: string, offset: number, maxChars: number): PullChunk {
  const total = content.length;
  const end = chunkEnd(content, offset, maxChars);
  const chunk = content.slice(offset, end);
  return {
    offset,
    length: chunk.length,
    totalChars: total,
    nextOffset: end < total ? end : null,
    complete: offset === 0 && end === total,
    contentSha256: sha256Hex(content),
    chunk,
  };
}
