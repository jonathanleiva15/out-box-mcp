/**
 * Helpers PUROS de serialización de respuestas para el contexto del agente
 * (AX-06 / AX-12). Sin I/O ni config: testeables contra dist/.
 *
 * Reglas:
 * - JSON COMPACTO (el pretty-print sumaba ~30% de tokens).
 * - Si no entra en el límite, se recorta por ÍTEMS del array más grande y se marca
 *   `_truncated` con el total: el JSON sigue siendo válido. Antes se cortaba el
 *   string a mitad de un ítem y el agente recibía JSON roto sin saber cuánto faltaba.
 * - El contenido autoritativo (HTML de pull/export) NO pasa por acá: nunca se trunca.
 * - Arrays CRONOLÓGICOS ascendentes (bloques del daily, comentarios): `keep: "newest"`
 *   conserva la COLA. Con el prefijo, el ítem recién escrito (el que el agente verifica
 *   tras un timeout) era justo el recortado y el agente lo duplicaba (pasada 4).
 */

const TRUNC_NOTE_RESERVE = 400;

/** Recorte de un texto plano con nota bilingüe (último recurso). */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const original = text.length;
  return (
    text.slice(0, max) +
    `\n…(response truncated at ${max} of ${original} chars — narrow with filters or paginate with cursor. ` +
    `respuesta truncada en ${max} de ${original} caracteres; acotá con filtros o paginá con cursor.)`
  );
}

/**
 * Cuántos ítems de `items` entran en `max` caracteres al serializar
 * `build(items.slice(0, n))`. Búsqueda binaria; 0 si ni uno entra.
 */
export function fitCount<T>(items: T[], max: number, build: (slice: T[]) => unknown): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const len = JSON.stringify(build(items.slice(0, mid))).length;
    if (len <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Clave del array top-level más pesado de un objeto (o null si no hay arrays). */
function largestArrayKey(obj: Record<string, unknown>): string | null {
  let best: string | null = null;
  let bestLen = -1;
  for (const [k, v] of Object.entries(obj)) {
    if (!Array.isArray(v)) continue;
    const len = JSON.stringify(v).length;
    if (len > bestLen) {
      best = k;
      bestLen = len;
    }
  }
  return best;
}

/** Opciones de fitJson para arrays que no se paginan con cursor. */
export interface FitJsonOptions {
  /**
   * "oldest" (default): conserva el prefijo (listados paginados: el resto viene con
   * cursor). "newest": conserva la cola de un array cronológico ascendente y marca
   * `_truncated.dropped: "oldest"`.
   */
  keep?: "oldest" | "newest";
  /** Remedio real de la tool (filtros que acepta); default: el genérico con cursor. */
  hint?: string;
}

const DEFAULT_HINT =
  "Respuesta recortada por tamaño: acotá con filtros (prefix/limit/tag) o paginá con cursor. / Truncated: narrow with filters or paginate.";

/**
 * Serializa `data` para el contexto del agente sin pasarse de `max` caracteres y
 * sin romper el JSON: recorta ítems del array top-level más pesado y agrega
 * `_truncated: { field, shown, total, hint, dropped? }`.
 */
export function fitJson(data: unknown, max: number, opts: FitJsonOptions = {}): string {
  if (typeof data === "string") return truncateText(data, max);
  const text = JSON.stringify(data);
  if (text === undefined) return String(data);
  if (text.length <= max) return text;

  const budget = Math.max(0, max - TRUNC_NOTE_RESERVE);
  const hint = opts.hint ?? DEFAULT_HINT;
  const newest = opts.keep === "newest";
  // fitCount mide prefijos: para conservar la cola se le pasa el array invertido y se
  // re-invierte el recorte (el orden original se mantiene en la salida).
  const pick = <T>(arr: T[], n: number): T[] => (newest ? arr.slice(arr.length - n) : arr.slice(0, n));
  const order = <T>(arr: T[]): T[] => (newest ? [...arr].reverse() : arr);
  const note = (field: string, shown: number, total: number) => ({
    field,
    shown,
    total,
    ...(newest ? { dropped: "oldest" } : {}),
    hint,
  });

  if (Array.isArray(data)) {
    const build = (slice: unknown[]) => ({ items: slice, _truncated: note("items", slice.length, data.length) });
    const n = fitCount(order(data), budget, (s) => build(order(s)));
    if (n > 0) return JSON.stringify(build(pick(data, n)));
    return truncateText(text, max);
  }

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const key = largestArrayKey(obj);
    if (key) {
      const arr = obj[key] as unknown[];
      const build = (slice: unknown[]) => ({
        ...obj,
        [key]: slice,
        _truncated: note(key, slice.length, arr.length),
      });
      const n = fitCount(order(arr), budget, (s) => build(order(s)));
      const out = JSON.stringify(build(pick(arr, n)));
      if (out.length <= max) return out;
    }
  }
  return truncateText(text, max);
}

/** Campos que devuelve `outbox_list` con `fields: "compact"` (AX-06). */
export interface CompactPost {
  slug: string;
  title: string | null;
  visibility: string | null;
  updatedAt: string | null;
  version: number | null;
  tags: string[];
  draft?: true;
  sourceFormat?: string;
  openComments?: number;
}

/** Proyección compacta de un ítem de /api/list (sin owner, url, model, publishedBy y contentSize). */
export function projectPost(p: Record<string, unknown>): CompactPost {
  const out: CompactPost = {
    slug: String(p.slug ?? ""),
    title: typeof p.title === "string" ? p.title : null,
    visibility: typeof p.visibility === "string" ? p.visibility : null,
    updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : null,
    version: typeof p.version === "number" ? p.version : null,
    tags: Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === "string") : [],
  };
  if (p.draft === true) out.draft = true;
  if (typeof p.sourceFormat === "string" && p.sourceFormat !== "html") out.sourceFormat = p.sourceFormat;
  if (typeof p.openComments === "number" && p.openComments > 0) out.openComments = p.openComments;
  return out;
}
