/**
 * Constantes compartidas del Outbox MCP server.
 *
 * - API_BASE  → toda la API (mutaciones, listados, gestión y LECTURA de contenido).
 *   El contenido se lee por el contrato canónico `GET /api/u/:u/:slug/export?format=html`
 *   (DEVC-01), NUNCA por el sitio público: con SANDBOX_SERVE=on el catch-all devuelve
 *   un shell con `<iframe src="/raw/...">` en lugar de la página.
 * - SITE_BASE → solo para construir la URL pública canónica que se le muestra al humano
 *   (`SITE_BASE/<user>/<slug>`, SIN `/u/`). No se usa para leer.
 */
export const API_BASE = process.env.OUTBOX_API_BASE ?? "https://api.out-box.dev";
export const SITE_BASE = process.env.OUTBOX_SITE_BASE ?? "https://out-box.dev";

/** Límite de caracteres para respuestas de listado/metadata (evita saturar el contexto del agente). */
export const CHARACTER_LIMIT = 25000;

/** Timeout de red por request (DEVC-08). Lecturas y gestión. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Timeout de escrituras pesadas SIN dedupe por Idempotency-Key (upload). */
export const WRITE_TIMEOUT_MS = 60_000;
/**
 * TTL del marcador `pending` de idempotencia del worker
 * (out-box/worker/src/lib/idempotency.ts → IDEMPOTENCY_PENDING_TTL_SECONDS). Espejo:
 * si el worker lo sube, este valor puede quedar como está (el invariante sigue).
 */
export const IDEMPOTENCY_PENDING_TTL_MS = 60_000;
/**
 * Timeout de escrituras pesadas que se reintentan con la MISMA Idempotency-Key
 * (publish, publish-from-template). Tiene que quedar por debajo del TTL del marcador
 * `pending`: con 60 s (= TTL) el reintento tras un timeout llegaba cuando el marcador
 * ya había vencido y el back ejecutaba el publish dos veces. Invariante (test):
 * IDEMPOTENT_WRITE_TIMEOUT_MS + esperas por idempotency_in_progress < TTL.
 */
export const IDEMPOTENT_WRITE_TIMEOUT_MS = 45_000;

/**
 * `model` que manda outbox_append si el agente no lo pasa. El worker lo exige en el
 * primer append de cada día UTC (daily.ts → 400 missing_model); mismo criterio que el
 * CLI (`outbox-cli`, cli/src/lib/meta.ts).
 */
export const DEFAULT_APPEND_MODEL = "outbox-mcp";

export const SERVER_NAME = "outbox-mcp-server";
export const SERVER_VERSION = "0.2.0";
/** Versión del contrato del API contra el que está construido este server (MAJOR.MINOR).
 *  Se compara contra `contract` de GET /api/capabilities. */
export const API_CONTRACT_VERSION = "1.0.0";
export const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;
