/**
 * Helpers PUROS de normalización de filtros que viajan en query strings al worker
 * (sin I/O, sin config, sin zod). Igual que paths.ts: una sola implementación y
 * testeable unitariamente contra dist/ (ver test/client.test.mjs).
 */

/** Formas de `since` aceptadas por normalizeSince (ver abajo). */
const EPOCH_RE = /^(\d{10}|\d{13})$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Normaliza un `since` a ISO-8601 UTC (`Date#toISOString`, ej. '2026-06-01T00:00:00.000Z').
 *
 * Por qué: el back NO acepta epoch y compara distinto según el endpoint:
 *  - GET /api/audit parsea ISO (audit.ts → parseISO): `since=1719878400000` → 400 invalid_since.
 *  - GET /api/u/:u/recent compara STRINGS (`p.updatedAt > since`, feed.ts): un epoch
 *    ('1719…') es siempre "menor" que '2026-…' → devolvía TODO sin avisar. Por el mismo
 *    motivo un ISO con offset ('…T10:00:00-03:00') o sin hora ('2026-06-01') comparaba
 *    mal; al normalizar a UTC `toISOString` la comparación lexicográfica es correcta.
 *
 * Acepta SOLO formas no ambiguas (todo lo demás tira Error accionable, mejor que
 * mandarlo y que el back lo ignore o lo compare mal):
 *  - epoch de 13 dígitos (ms) o de 10 dígitos (segundos). Otro largo se rechaza:
 *    '2026' o '20260601' parecían epoch en segundos y caían en 1970 → devolvía TODO.
 *  - fecha sola `YYYY-MM-DD` (se toma como 00:00 UTC, igual que Date.parse).
 *  - ISO con hora `YYYY-MM-DDTHH:mm[:ss[.sss]]` + `Z` u offset (`-03:00`). Sin zona se
 *    rechaza: Date.parse lo tomaría en la hora LOCAL del host del MCP (no determinista).
 */

export function normalizeSince(since: string): string {
  const value = since.trim();
  let ms = Number.NaN;
  if (EPOCH_RE.test(value)) {
    const n = Number(value);
    ms = value.length === 10 ? n * 1000 : n;
  } else if (ISO_DATE_RE.test(value) || ISO_DATETIME_TZ_RE.test(value)) {
    ms = Date.parse(value);
    // Fecha sola fuera de rango ('2026-02-30'): Date.parse la desborda a marzo sin avisar.
    if (ISO_DATE_RE.test(value) && Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) !== value) {
      ms = Number.NaN;
    }
  }
  const d = new Date(ms);
  if (!Number.isFinite(ms) || Number.isNaN(d.getTime())) {
    throw new Error(
      `Invalid since '${since}': use YYYY-MM-DD, ISO-8601 with Z/offset (e.g. 2026-06-01T00:00:00Z), ` +
        `or epoch (13 digits ms / 10 digits s). / since inválido: usá YYYY-MM-DD, ISO-8601 con Z u offset ` +
        `(ej. 2026-06-01T00:00:00Z o 2026-06-01T10:00:00-03:00) o epoch (13 dígitos ms / 10 dígitos s).`,
    );
  }
  return d.toISOString();
}

/**
 * ¿El slug cae bajo la carpeta `prefix`? Borde de CARPETA, mismo criterio que el
 * back (feed.ts / lib/webhooks.ts): `clientes` matchea `clientes` (índice) y
 * `clientes/foo`, pero NO `clientes-blog/foo`. Se usa como filtro defensivo en el
 * cliente para que `prefix` se respete aunque el worker desplegado lo ignore.
 */
export function slugUnderPrefix(slug: string, prefix: string): boolean {
  const p = prefix.replace(/\/+$/, "");
  return slug === p || slug.startsWith(`${p}/`);
}
