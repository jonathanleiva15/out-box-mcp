/**
 * Cliente HTTP del back de Outbox. Cliente puro (mismo patrón que el CLI/front/rust).
 * - Auth: Bearer `outbox_*`. Sin credencial el server igual arranca y cada llamada
 *   tira MissingCredentialError (AX-10): el agente recibe un error accionable en vez
 *   de un "server disconnected" sin mensaje.
 * - Una sola base (API_BASE). La lectura de contenido usa el contrato canónico
 *   `GET /api/u/:u/:slug/export?format=html` (DEVC-01), nunca el sitio público:
 *   con SANDBOX_SERVE=on el catch-all devuelve un *shell* con un iframe, no la página.
 * - Timeouts propios (DEVC-08) y errores de red traducidos a algo accionable.
 * - Errores: parsea `missingScope` || `missingAnyOf` (contrato §3.3 de la matriz) y
 *   los expone también como objeto estructurado (`describeError`, AX-03/AX-10).
 */
import { createHmac } from "node:crypto";

import { API_BASE, DEFAULT_TIMEOUT_MS, SERVER_VERSION, SITE_BASE, USER_AGENT } from "../constants.js";
import { encodeSlugPath } from "../paths.js";

export interface OutboxErrorBody {
  error?: string;
  message?: string;
  /** de requireScope/requireVerb (auth.ts) */
  missingScope?: string;
  /** de requireOneOfScopes (auth.ts) */
  missingAnyOf?: string[];
  /** de requireQuota (429) — segundos hasta poder reintentar (back: quota middleware → `retryAfter`) */
  retryAfter?: number;
  /** anti-spam de comentarios (429 rate_limited de comments.ts) — segundos, SIN bloque CTA */
  retryIn?: number;
  /**
   * Bloque CTA de upgrade (worker lib/limit-response.ts → UpgradeCta). Lo suman los
   * gates que usan limitResponse (429 rate_limited de quota, 403 daily_docs_limit /
   * daily_updates_limit / keys_limit, 413 storage_limit). OJO: NO toda respuesta con
   * esos códigos lo trae — el 413 html_too_large de publish.ts es un jsonError plano
   * `{ error, message }` y el 429 rate_limited de comments.ts es anti-spam
   * `{ error, message, retryIn }`. Por eso el CTA se arma solo si el bloque está.
   * `used` es number salvo en rate_limited (objeto legacy `{ hour, day }`).
   */
  limit?: number;
  used?: unknown;
  tier?: string;
  upgradeTo?: string | null;
  ctaUrl?: string | null;
  [k: string]: unknown;
}

/**
 * Códigos de límite de PLAN del back (worker lib/limit-response.ts → LimitErrorCode).
 * Exportado para que out-box-mcp-remote (src/errors-en.ts) use esta misma lista en vez de una copia.
 */
export const PLAN_LIMIT_CODES: ReadonlySet<string> = new Set([
  "rate_limited",
  "daily_docs_limit",
  "daily_updates_limit",
  "keys_limit",
  "html_too_large",
  "storage_limit",
  "schedule_limit",
  "webhook_limit",
  "org_limit",
]);

/** CTA de upgrade estructurado que el MCP le devuelve al agente. */
export interface UpgradeCta {
  /** Código del gate (daily_docs_limit, keys_limit, ...). */
  error: string;
  limit: number | null;
  used: unknown;
  tier: string | null;
  /** Próximo tier que levanta el límite; null = ya está en el techo. */
  upgradeTo: string | null;
  /** Página de pricing; null = no hay upgrade posible. */
  ctaUrl: string | null;
  /**
   * Link directo al plan que levanta este límite (worker, 2026-10-11:
   * `https://out-box.dev/pricing?from=limit&plan=<tier>`). Solo https de out-box.dev.
   */
  upgradeUrl?: string;
}

/** Acepta solo un link https a out-box.dev (es texto del back que el agente le muestra al usuario). */
function safeUpgradeUrl(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > 300) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && (u.hostname === "out-box.dev" || u.hostname.endsWith(".out-box.dev"))
      ? u.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extrae el CTA de upgrade de un body de error, o null si el body NO trae el bloque
 * (`upgradeTo` + `tier`). Solo con el bloque presente se puede afirmar algo sobre el
 * upgrade (a qué tier subir, o que ya no hay techo): un body con código de plan pero
 * sin bloque (413 html_too_large de publish, 429 anti-spam de comments) NO es CTA —
 * inventar `upgradeTo: null` ahí le decía al agente "no hay upgrade" cuando el back
 * justamente sugiere pasar a un plan mayor. Ese caso lo maneja formatError aparte.
 */
export function extractUpgradeCta(body: OutboxErrorBody | null): UpgradeCta | null {
  if (!body || typeof body.error !== "string") return null;
  const hasBlock = "upgradeTo" in body && typeof body.tier === "string";
  if (!hasBlock) return null;
  return {
    error: body.error,
    limit: typeof body.limit === "number" ? body.limit : null,
    used: body.used ?? null,
    tier: typeof body.tier === "string" ? body.tier : null,
    upgradeTo: typeof body.upgradeTo === "string" ? body.upgradeTo : null,
    ctaUrl: typeof body.ctaUrl === "string" ? body.ctaUrl : null,
    ...(safeUpgradeUrl(body.upgradeUrl) ? { upgradeUrl: safeUpgradeUrl(body.upgradeUrl) } : {}),
  };
}

/**
 * Mensaje para un límite de PLAN (no de permisos). Antes todo 403 se informaba como
 * "falta scope" y el 413 era genérico: el agente le pedía al usuario cambiar la key
 * cuando lo que hacía falta era subir de plan. Ahora el mensaje lo dice explícito
 * y adjunta el CTA estructurado (JSON) para que el agente lo muestre tal cual.
 */
function formatPlanLimit(status: number, cta: UpgradeCta, retryAfter?: number, message?: string): string {
  const head =
    cta.error === "rate_limited"
      ? `Error ${status}: límite de uso del plan alcanzado (rate_limited)${retryAfter ? `, reintentá en ~${retryAfter}s` : ""}. No reintentes antes de ese plazo ni en loop.`
      : `Error ${status}: límite del plan alcanzado (${cta.error}). No es un problema de permisos/scope de la key: cambiar de key no lo resuelve.`;
  const action =
    cta.upgradeTo && (cta.upgradeUrl ?? cta.ctaUrl)
      ? ` Para más cuota, el usuario puede subir a ${cta.upgradeTo}: ${cta.upgradeUrl ?? cta.ctaUrl}`
      : " El plan actual ya es el más alto para este límite (no hay upgrade que lo levante).";
  return `${head}${action}${message ? ` Detalle del back: ${message}` : ""}\nupgradeCta: ${JSON.stringify(cta)}`;
}

export class OutboxApiError extends Error {
  readonly status: number;
  readonly body: OutboxErrorBody | null;
  /** SECURITY: pathname-only (+ search), NEVER a full URL — must not carry credentials. */
  readonly path: string;
  /** Segundos del header `Retry-After` de la respuesta (ej. 409 idempotency_in_progress). */
  readonly retryAfter?: number;
  /**
   * Idempotency-Key que viajó en el request (la del agente o la que generó el MCP).
   * Pasada 4: sin ella en el error, "reintentá con el MISMO idempotencyKey" era
   * inaccionable cuando el agente no había pasado ninguna.
   */
  readonly idempotencyKey?: string;
  constructor(status: number, body: OutboxErrorBody | null, path: string, retryAfter?: number, idempotencyKey?: string) {
    super(`Outbox API ${status} en ${path}: ${body?.error ?? "error"}`);
    this.name = "OutboxApiError";
    this.status = status;
    this.body = body;
    this.path = path;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
    if (idempotencyKey !== undefined) this.idempotencyKey = idempotencyKey;
  }
}

/**
 * Falla de red ANTES de tener respuesta HTTP (AX-10 / DEVC-08): host inalcanzable,
 * DNS, proxy, TLS o timeout propio. `host` es solo el hostname (sin credenciales).
 */
export class OutboxNetworkError extends Error {
  readonly kind: "timeout" | "unreachable";
  readonly host: string;
  readonly path: string;
  readonly timeoutMs: number;
  /** true si el request era una escritura: pudo haberse aplicado en el back. */
  readonly mutating: boolean;
  /** Idempotency-Key que viajó en el request (ver OutboxApiError.idempotencyKey). */
  readonly idempotencyKey?: string;
  constructor(
    kind: "timeout" | "unreachable",
    host: string,
    path: string,
    timeoutMs: number,
    mutating: boolean,
    cause?: unknown,
    idempotencyKey?: string,
  ) {
    super(kind === "timeout" ? `timeout de red (${timeoutMs} ms) contra ${host}` : `no se pudo conectar con ${host}`);
    this.name = "OutboxNetworkError";
    this.kind = kind;
    this.host = host;
    this.path = path;
    this.timeoutMs = timeoutMs;
    this.mutating = mutating;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
    if (idempotencyKey !== undefined) this.idempotencyKey = idempotencyKey;
  }
}

/** El server arrancó sin credencial (ni OUTBOX_API_KEY ni ~/.outboxrc). */
export class MissingCredentialError extends Error {
  constructor() {
    super("sin credencial de Outbox");
    this.name = "MissingCredentialError";
  }
}

/**
 * Error del lado del MCP con código estable (input inválido, guardas locales,
 * respuesta que viola el contrato). Se informa igual que un error del back.
 */
export class OutboxToolError extends Error {
  readonly code: string;
  readonly fix: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, fix: string, opts: { retryable?: boolean; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "OutboxToolError";
    this.code = code;
    this.fix = fix;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Operaciones de escritura que el MCP sabe reintentar si el back las deduplica. Los
 * nombres son los de `features.idempotencyEndpoints` (y `secretScan.appliesTo`) del
 * worker: `publish`, `publishFromTemplate`, `dailyAppend`. Para los comentarios el
 * worker todavía no fijó nombre: se aceptan los alias de `IDEMPOTENCY_OP_NAMES`.
 */
export type IdempotencyOp = "publish" | "publishFromTemplate" | "dailyAppend" | "comment";

/** Nombres con los que el back puede listar cada operación en `idempotencyEndpoints`. */
export const IDEMPOTENCY_OP_NAMES: Readonly<Record<IdempotencyOp, readonly string[]>> = {
  publish: ["publish"],
  publishFromTemplate: ["publishFromTemplate", "publish-from-template"],
  dailyAppend: ["dailyAppend", "append"],
  comment: ["comment", "comments", "createComment"],
};

export interface ReqInit {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Timeout propio del request (default DEFAULT_TIMEOUT_MS). */
  timeoutMs?: number;
  /**
   * AX-04: clave de idempotencia (header `Idempotency-Key`). El back la usa para
   * devolver la MISMA respuesta ante un retry en vez de duplicar, pero SOLO en las
   * operaciones que lista en `features.idempotencyEndpoints` de /api/capabilities
   * (hoy publish y publishFromTemplate). En el resto el header se ignora.
   */
  idempotencyKey?: string;
  /**
   * Reintentar UNA vez ante falla de red (nunca ante una respuesta HTTP). Solo se
   * hace si hay `idempotencyKey`, `idempotencyOp` Y el back lista esa operación en
   * `features.idempotencyEndpoints` (se consulta recién cuando falla la red). El
   * flag global `features.idempotency` NO alcanza: el worker lo anuncia aunque el
   * append del daily y los comentarios no deduplican, y un retry de una escritura ya
   * aplicada la duplicaba (bloque o comentario doble).
   */
  retryOnNetworkError?: boolean;
  /** Operación del back que deduplica este request (ver `IdempotencyOp`). */
  idempotencyOp?: IdempotencyOp;
  /** Body binario crudo (uploads). Excluyente con `body`. */
  rawBody?: Uint8Array;
  /** content-type del rawBody. */
  contentType?: string;
}

/** Marca del content-agent que `/raw` inyecta (worker lib/sandbox-bridge.ts → AGENT_MARKER). */
const SANDBOX_AGENT_TOKEN = "__ob_sandbox_agent";
const SANDBOX_AGENT_MARKER = `<!-- ${SANDBOX_AGENT_TOKEN} -->`;

/**
 * Saca el bloque `\n<!-- __ob_sandbox_agent --><style>…</style><script>…</script>\n` que el
 * worker inyecta en `/raw` (injectSandboxAgent). Sin esto, re-publicar lo leído por
 * `/raw` duplicaba ~6 KB de JS del sandbox en la página del usuario.
 *
 * Conservador a propósito: injectSandboxAgent es idempotente (si el HTML ya contiene
 * el marcador NO inyecta nada) y cuando inyecta lo hace justo antes del ÚLTIMO
 * `</body>` (o `</html>`, o al final). Por eso solo se quita si el marcador aparece
 * UNA sola vez, con el formato exacto, y el bloque termina donde lo pondría el worker.
 * Una página que menciona el marcador como texto queda intacta.
 */
export function stripSandboxAgent(html: string): string {
  const head = `\n${SANDBOX_AGENT_MARKER}<style>`;
  const start = html.lastIndexOf(head);
  if (start === -1) return html;
  // Más de una aparición del marcador ⇒ el original ya lo tenía ⇒ el worker no inyectó
  // (su chequeo de idempotencia busca el token pelado, sin el comentario HTML).
  if (html.indexOf(SANDBOX_AGENT_TOKEN) !== html.lastIndexOf(SANDBOX_AGENT_TOKEN)) return html;
  const styleClose = html.indexOf("</style><script>", start + head.length);
  if (styleClose === -1) return html;
  const tail = "</script>\n";
  const close = html.indexOf(tail, styleClose);
  if (close === -1) return html;
  const original = html.slice(0, start) + html.slice(close + tail.length);
  // El worker inserta antes del último `</body>`, si no del último `</html>`, si no al final.
  let injectAt = original.lastIndexOf("</body>");
  if (injectAt === -1) injectAt = original.lastIndexOf("</html>");
  if (injectAt === -1) injectAt = original.length;
  return injectAt === start ? original : html;
}

/**
 * ¿La respuesta es el shell sandbox del catch-all y no el contenido? El worker lo
 * marca con `x-outbox-shell: on`; como defensa si un proxy saca el header, también
 * se detecta el iframe `__ob_content` que apunta a `/raw/`.
 */
export function isSandboxShell(headers: Headers, html: string): boolean {
  if (headers.get("x-outbox-shell") === "on") return true;
  return /<iframe[^>]*id=["']__ob_content["'][^>]*src=["'][^"']*\/raw\//i.test(html);
}

/** Respuesta 2xx de send(): headers + lectura del body con el manejo de red de send(). */
interface SentResponse {
  headers: Headers;
  text: () => Promise<string>;
}

export interface ReadContentResult {
  html: string;
  /** export = HTML persistido (round-trip seguro); raw = página compartida de otro usuario. */
  via: "export" | "raw";
  /**
   * Versión EXACTA que se leyó: header `x-outbox-version` del MISMO response de export
   * (worker handlers/export.ts). Es la que corresponde mandar como expectedVersion al
   * re-publicar; leerla aparte (outbox_versions) después del contenido deja una
   * ventana en la que otro agente pudo publicar. undefined = el back no la mandó.
   */
  version?: number;
}

/** `x-outbox-version` → entero positivo, o undefined si falta o es inválido. */
export function versionFromHeaders(headers: Headers): number | undefined {
  const raw = headers.get("x-outbox-version");
  if (raw === null || !/^\d{1,9}$/.test(raw.trim())) return undefined;
  const n = Number(raw.trim());
  return n >= 1 ? n : undefined;
}

/** fetch inyectable (el MCP remoto usa el service binding OUTBOX_API). */
export type FetchLike = (input: URL | string | Request, init?: RequestInit) => Promise<Response>;

/**
 * Opciones del cliente (Ola 2). Todas opcionales y aditivas: sin ellas el cliente se
 * comporta como siempre (API_BASE/SITE_BASE de constants.ts y el fetch global).
 */
export interface OutboxClientOptions {
  /** Base de la API (default API_BASE). */
  apiBase?: string;
  /** Base del sitio para armar URLs públicas (default SITE_BASE). */
  siteBase?: string;
  /** Implementación de fetch (default: el fetch global). */
  fetch?: FetchLike;
  /** Valor del header `Outbox-Client` (ARQ-10). Default `mcp/<versión>`. */
  clientHeader?: string;
  /** Espera entre reintentos de `idempotency_in_progress` (tests). Default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Espera ante `409 idempotency_in_progress` (worker lib/idempotency.ts): otro request
 * con la MISMA Idempotency-Key sigue en curso y el back pide reintentar con la misma
 * key tras `Retry-After`. Pasa sobre todo cuando el reintento automático tras un
 * timeout cae mientras el primer request todavía corre (AX-04). Tope acotado: la
 * suma de esperas + IDEMPOTENT_WRITE_TIMEOUT_MS queda por debajo del TTL del
 * marcador `pending` del worker (ver constants.ts).
 */
export const IDEMPOTENCY_IN_PROGRESS_MAX_WAITS = 5;
/** Espera máxima por intento aunque el back mande un Retry-After mayor (s). */
export const IDEMPOTENCY_IN_PROGRESS_MAX_WAIT_S = 2;

function parseRetryAfter(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v.trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Versión del contrato que declaran los clientes (`Outbox-Contract`, igual que el CLI). */
export const OUTBOX_CONTRACT_HEADER = "1";

export class OutboxClient {
  private readonly apiKey: string | null;
  private capabilities: Promise<Record<string, unknown> | null> | null = null;
  readonly apiBase: string;
  readonly siteBase: string;
  private readonly fetchImpl: FetchLike;
  private readonly clientHeader: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(apiKey: string | null, opts: OutboxClientOptions = {}) {
    this.apiKey = apiKey;
    this.apiBase = (opts.apiBase ?? API_BASE).replace(/\/+$/, "");
    this.siteBase = (opts.siteBase ?? SITE_BASE).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.clientHeader = opts.clientHeader ?? `mcp/${SERVER_VERSION}`;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get hasCredential(): boolean {
    return this.apiKey !== null;
  }

  /**
   * Clave derivada de la credencial para firmar estado del MCP (seg p2: el confirmToken
   * de outbox_accept_suggestion). HMAC-SHA256(apiKey, label): no expone la key, es
   * estable entre procesos e isolates (el remoto stateless la reconstruye en cada
   * request) y queda atada a ESA credencial/grant. null sin credencial.
   */
  deriveKey(label: string): Uint8Array | null {
    if (this.apiKey === null) return null;
    return new Uint8Array(createHmac("sha256", this.apiKey).update(label, "utf8").digest());
  }

  async req<T>(path: string, init: ReqInit = {}): Promise<T> {
    const text = await (await this.send(path, init, "application/json")).text();
    return (text ? (JSON.parse(text) as T) : ({} as T));
  }

  /**
   * Igual que req() pero devuelve el body como TEXTO crudo, sin `JSON.parse`.
   * Para endpoints que responden algo que no es JSON en 2xx: hoy
   * `GET /api/u/:u/:slug/export?format=html` devuelve el HTML crudo, servido como
   * `text/plain; charset=utf-8` + `content-disposition: attachment` + nosniff (worker
   * export.ts, PEN3: nunca renderizable en api.out-box.dev). NO validar que el
   * content-type sea html: el body es el HTML igual. Pasarlo por req() tiraba SyntaxError ("Unexpected token '<'")
   * y outbox_export format=html fallaba SIEMPRE. Los errores (!ok) siguen el mismo
   * camino que req() → OutboxApiError con el body JSON del back.
   */
  async reqText(path: string, init: ReqInit = {}, accept = "text/html, text/plain;q=0.9, */*;q=0.1"): Promise<string> {
    return (await this.reqTextWithHeaders(path, init, accept)).text;
  }

  /** Igual que reqText() pero devuelve también los headers del response (p. ej. `x-outbox-version`). */
  async reqTextWithHeaders(
    path: string,
    init: ReqInit = {},
    accept = "text/html, text/plain;q=0.9, */*;q=0.1",
  ): Promise<{ text: string; headers: Headers }> {
    const res = await this.send(path, init, accept);
    const text = await res.text();
    if (isSandboxShell(res.headers, text)) throw shellError(path);
    return { text, headers: res.headers };
  }

  /** GET a un endpoint PÚBLICO sin Bearer (funciona aunque el server no tenga credencial). */
  async reqPublic<T>(path: string, init: ReqInit = {}): Promise<T> {
    const text = await (await this.send(path, init, "application/json", { anonymous: true })).text();
    return (text ? (JSON.parse(text) as T) : ({} as T));
  }

  /**
   * GET /api/capabilities (público) cacheado por proceso. null si falla: las
   * features opcionales se tratan como NO soportadas.
   *
   * Pasada 3 (2026-09-30): un fallo TRANSITORIO (red, timeout, 408/429/5xx, body que
   * no es JSON, p. ej. un portal cautivo) NO se cachea: antes un solo blip al abrir la
   * laptop sin red dejaba null para toda la sesión stdio (horas o días) y apagaba el
   * reintento idempotente y el expectedVersion atómico. La próxima llamada lo re-pide.
   * Solo se cachean la respuesta OK y un 4xx definitivo (back viejo sin el endpoint).
   */
  async getCapabilities(): Promise<Record<string, unknown> | null> {
    if (!this.capabilities) {
      const pending: Promise<Record<string, unknown> | null> = this.send(
        "/api/capabilities",
        { timeoutMs: 10_000 },
        "application/json",
        { anonymous: true },
      )
        .then(async (r) => {
          const parsed = JSON.parse(await r.text()) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError("capabilities no es un objeto JSON");
          return parsed as Record<string, unknown>;
        })
        .catch((err: unknown) => {
          if (isTransientCapabilitiesError(err) && this.capabilities === pending) this.capabilities = null;
          return null;
        });
      this.capabilities = pending;
    }
    return this.capabilities;
  }

  /** ¿El back anuncia `features.<name> === true` en /api/capabilities? */
  async supportsFeature(name: string): Promise<boolean> {
    const caps = await this.getCapabilities();
    const features = caps?.features as Record<string, unknown> | undefined;
    return features?.[name] === true;
  }

  /**
   * ¿El back deduplica `op` por `Idempotency-Key`? Exige `features.idempotency === true`
   * Y que `op` figure en `features.idempotencyEndpoints`. Sin la lista (back viejo o
   * capabilities caído) se asume que NO: reintentar a ciegas duplica escrituras.
   */
  async supportsIdempotency(op: IdempotencyOp): Promise<boolean> {
    const caps = await this.getCapabilities();
    const features = caps?.features as Record<string, unknown> | undefined;
    if (features?.idempotency !== true) return false;
    const endpoints = features.idempotencyEndpoints;
    if (!Array.isArray(endpoints)) return false;
    return IDEMPOTENCY_OP_NAMES[op].some((name) => endpoints.includes(name));
  }

  /**
   * fetch + auth + timeout + manejo de errores compartido por req() / reqText().
   * Devuelve los headers y un `text()` que lee el body bajo el MISMO manejo de red:
   * AbortSignal.timeout también corta la lectura del body (export/pull grandes o
   * lentos), y ese corte tiene que salir como network_timeout, no como un error
   * genérico que el agente interpreta como "revisá los argumentos" (DEVC-08).
   */
  private async send(path: string, init: ReqInit, accept: string, opts: { anonymous?: boolean } = {}): Promise<SentResponse> {
    if (!opts.anonymous && this.apiKey === null) throw new MissingCredentialError();
    const method = init.method ?? "GET";
    const url = new URL(this.apiBase + path);
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      accept,
      "user-agent": USER_AGENT,
      // ARQ-10: identificación del cliente (mismo contrato que el CLI: `cli/<v>`).
      "outbox-client": this.clientHeader,
      "outbox-contract": OUTBOX_CONTRACT_HEADER,
    };
    if (this.apiKey !== null && !opts.anonymous) headers.authorization = `Bearer ${this.apiKey}`;
    if (MUTATING.has(method)) headers["x-requested-with"] = "XMLHttpRequest";
    if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;

    let body: string | Uint8Array | undefined;
    if (init.rawBody !== undefined) {
      headers["content-type"] = init.contentType ?? "application/octet-stream";
      body = init.rawBody;
    } else if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }

    // SECURITY: el path que viaja en los errores es pathname-only (sin host ni
    // credenciales). El Bearer vive solo en el header, nunca en la URL.
    const safePath = url.pathname + url.search;
    const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const op = init.idempotencyOp;
    const mayRetry = Boolean(init.retryOnNetworkError && init.idempotencyKey && op);
    let res: Response | undefined;
    let parsed: OutboxErrorBody | null = null;
    let waits = 0;
    for (let attempt = 1; attempt <= 2; ) {
      try {
        res = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        const netErr = toNetworkError(err, url, safePath, timeoutMs, MUTATING.has(method), init.idempotencyKey);
        if (attempt === 1 && mayRetry && op && (await this.supportsIdempotency(op))) {
          attempt++;
          continue;
        }
        throw netErr;
      }
      if (res.ok) break;
      parsed = await readErrorBody(res);
      // 409 idempotency_in_progress: el back NO ejecutó este request (hay otro con la
      // misma key en curso) y pide reintentar con la MISMA key tras Retry-After. Solo
      // tiene sentido si mandamos Idempotency-Key; con tope para no colgar la tool.
      if (
        res.status === 409 &&
        parsed?.error === "idempotency_in_progress" &&
        init.idempotencyKey &&
        waits < IDEMPOTENCY_IN_PROGRESS_MAX_WAITS
      ) {
        waits++;
        const ra = parseRetryAfter(res.headers.get("retry-after")) ?? IDEMPOTENCY_IN_PROGRESS_MAX_WAIT_S;
        await this.sleep(Math.min(ra, IDEMPOTENCY_IN_PROGRESS_MAX_WAIT_S) * 1000);
        continue;
      }
      break;
    }
    if (!res) throw new OutboxNetworkError("unreachable", url.host, safePath, timeoutMs, MUTATING.has(method), undefined, init.idempotencyKey);
    if (!res.ok) {
      throw new OutboxApiError(res.status, parsed, safePath, parseRetryAfter(res.headers.get("retry-after")), init.idempotencyKey);
    }
    const okRes = res;
    return {
      headers: okRes.headers,
      text: async () => {
        try {
          return await okRes.text();
        } catch (err) {
          throw toNetworkError(err, url, safePath, timeoutMs, MUTATING.has(method), init.idempotencyKey);
        }
      },
    };
  }

  /**
   * Lectura CANÓNICA del contenido de una página (DEVC-01): el HTML persistido por
   * `GET /api/u/:u/:slug/export?format=html`. Es lo único apto para el loop
   * "leer → sumar → re-publicar": el catch-all público (`out-box.dev/<u>/<slug>`)
   * con SANDBOX_SERVE=on devuelve un shell con `<iframe src="/raw/...">` y
   * re-publicarlo pisaba la página con ese shell. Una respuesta con
   * `x-outbox-shell: on` se RECHAZA (nunca se devuelve como contenido).
   *
   * Página de OTRO usuario que no es `public` (unlisted, grant, org de la que sos
   * miembro): export responde 403 `cross_user_export_forbidden`. Ahí se cae a
   * `GET /raw/:u/:slug` (mismo gate de acceso que el sitio) y se saca el
   * content-agent que el worker inyecta, así el HTML es el persistido.
   *
   * Solo devuelve el ESTADO ACTUAL: para versiones viejas, outbox_versions + outbox_rollback.
   */
  async readContent(user: string, slug: string, opts: { self: boolean }): Promise<ReadContentResult> {
    const base = `/api/u/${encodeURIComponent(user)}/${encodeSlugPath(slug)}/export`;
    try {
      const { text: html, headers } = await this.reqTextWithHeaders(base, { query: { format: "html" } });
      const version = versionFromHeaders(headers);
      return { html, via: "export", ...(version !== undefined ? { version } : {}) };
    } catch (e) {
      const crossUser =
        !opts.self && e instanceof OutboxApiError && e.status === 403 && e.body?.error === "cross_user_export_forbidden";
      if (!crossUser) throw e;
    }
    const rawPath = `/raw/${encodeURIComponent(user)}/${encodeSlugPath(slug)}`;
    const html = await this.reqText(rawPath);
    return { html: stripSandboxAgent(html), via: "raw" };
  }

  /**
   * Fuente Markdown de una página publicada con `markdown` (AX-07):
   * `GET /api/u/:u/:slug/export?format=markdown`. Dos casos se traducen a un error
   * accionable (`markdown_source_unavailable`) en vez de un 400/404 crudo:
   *   - 400 invalid_format: el back todavía no expone el `.md` (worker viejo);
   *   - 404 markdown_source_unavailable: la página EXISTE pero la versión vigente no
   *     se publicó en markdown (worker export.ts). Sin esto el agente leía "el recurso
   *     no existe" y concluía que la página no estaba.
   */
  async readMarkdown(user: string, slug: string): Promise<string> {
    return (await this.readMarkdownVersioned(user, slug)).markdown;
  }

  /** readMarkdown() + la versión leída (`x-outbox-version` del mismo response). */
  async readMarkdownVersioned(user: string, slug: string): Promise<{ markdown: string; version?: number }> {
    const path = `/api/u/${encodeURIComponent(user)}/${encodeSlugPath(slug)}/export`;
    try {
      const { text, headers } = await this.reqTextWithHeaders(
        path,
        { query: { format: "markdown" } },
        "text/markdown, text/plain;q=0.9, */*;q=0.1",
      );
      const version = versionFromHeaders(headers);
      return { markdown: text, ...(version !== undefined ? { version } : {}) };
    } catch (e) {
      if (e instanceof OutboxApiError && e.status === 400 && e.body?.error === "invalid_format") {
        throw new OutboxToolError(
          "markdown_source_unavailable",
          "El back todavía no expone el .md fuente (export?format=markdown no soportado).",
          "Leé el HTML con outbox_pull format=html. Si re-publicás ese HTML, se guarda como HTML (sin re-aplicar el template).",
        );
      }
      if (e instanceof OutboxApiError && e.status === 404 && e.body?.error === "markdown_source_unavailable") {
        const sourceFormat = typeof e.body.sourceFormat === "string" ? e.body.sourceFormat : "html";
        throw new OutboxToolError(
          "markdown_source_unavailable",
          `La página existe, pero la versión vigente no se publicó en markdown (sourceFormat: ${sourceFormat}).`,
          "Leé el HTML con outbox_pull format=html. Si re-publicás ese HTML, se guarda como HTML.",
        );
      }
      throw e;
    }
  }
}

/**
 * Resumen de hallazgos de secretos para el agente: `tipo (línea N)`, sin el valor
 * (tampoco el `redacted`: no hace falta para actuar). Tolerante a entradas malformadas.
 */
export function secretsSummary(secrets: unknown[], max = 5): string {
  const parts: string[] = [];
  for (const s of secrets) {
    if (!s || typeof s !== "object") continue;
    const { type, line } = s as { type?: unknown; line?: unknown };
    if (typeof type !== "string" || !/^[a-z0-9_]{1,40}$/.test(type)) continue;
    parts.push(typeof line === "number" && Number.isInteger(line) && line > 0 ? `${type} (línea ${line})` : type);
  }
  if (parts.length <= max) return parts.join(", ");
  return `${parts.slice(0, max).join(", ")} y ${parts.length - max} más`;
}

/**
 * ¿El fallo de GET /api/capabilities puede no repetirse? Red/timeout, 408, 429, 5xx y
 * un body que no es JSON (portal cautivo, proxy) → sí: no se cachea. Un 4xx definitivo
 * (404 de un back viejo sin el endpoint) → no: se cachea para no re-pedirlo siempre.
 */
function isTransientCapabilitiesError(err: unknown): boolean {
  if (err instanceof OutboxApiError) return err.status === 408 || err.status === 429 || err.status >= 500;
  return true;
}

/** Body JSON de una respuesta !ok, o null si no es un objeto JSON. */
async function readErrorBody(res: Response): Promise<OutboxErrorBody | null> {
  try {
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as OutboxErrorBody) : null;
  } catch {
    return null;
  }
}

function shellError(path: string): OutboxToolError {
  return new OutboxToolError(
    "shell_response",
    `La respuesta de ${path} es el shell sandbox (x-outbox-shell: on), no el contenido de la página.`,
    "No re-publiques este HTML: pisaría la página con el shell. Leé con outbox_pull (usa /export) o outbox_export.",
  );
}

function toNetworkError(
  err: unknown,
  url: URL,
  safePath: string,
  timeoutMs: number,
  mutating: boolean,
  idempotencyKey?: string,
): OutboxNetworkError {
  const name = err instanceof Error ? err.name : "";
  const kind = name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable";
  return new OutboxNetworkError(kind, url.host, safePath, timeoutMs, mutating, err, idempotencyKey);
}

/** Error estructurado que el MCP devuelve junto al texto (AX-03 / AX-10 / P7). */
export interface StructuredError {
  /** Código estable: el `error` del back o uno propio del MCP. */
  code: string;
  /** Status HTTP (null si no hubo respuesta). */
  status: number | null;
  /** ¿Tiene sentido reintentar la misma operación? */
  retryable: boolean;
  /** Qué hacer (para el agente y para mostrarle al usuario). */
  fix: string;
  missingScope?: string;
  missingAnyOf?: string[];
  retryAfter?: number;
  upgradeCta?: UpgradeCta;
  host?: string;
  message?: string;
  [k: string]: unknown;
}

/**
 * 413 de límites FIJOS del back (iguales en todos los tiers): subir de plan no los
 * levanta. Los de plan son los de PLAN_LIMIT_CODES (html_too_large, storage_limit) o
 * los que traen bloque CTA. Ej.: block_too_large = BLOCK_SIZE_MAX 50 KB (worker
 * lib/daily.ts), upload_too_large = MAX_UPLOAD_SIZE, anchor/replacement de comments.
 */
function isPlanTooLarge(code: string): boolean {
  return PLAN_LIMIT_CODES.has(code);
}

/** Campos numéricos del límite que el back manda en un 413 y el agente necesita. */
const SIZE_LIMIT_FIELDS = ["maxBytes", "limit", "bytes"] as const;

/** Scopes que habilitan leer privados propios (worker resolvePrivateRead). */
const PRIVATE_READ_ANY_OF = ["list", "admin:self"];

/** Clasifica cualquier error en un objeto estable { code, retryable, fix, ... }. */
export function describeError(e: unknown): StructuredError {
  if (e instanceof MissingCredentialError) {
    return {
      code: "missing_credential",
      status: null,
      retryable: false,
      fix:
        "Configurá OUTBOX_API_KEY (Bearer outbox_*) en el config del cliente MCP, o corré `outbox login` con el CLI para dejar la key en ~/.outboxrc, y reiniciá el server.",
    };
  }
  if (e instanceof OutboxNetworkError) {
    // Pasada 4: la clave viaja en el error (también la que generó el MCP si el agente
    // no pasó ninguna); sin ella, "el MISMO idempotencyKey" no se podía cumplir.
    const key = e.mutating ? e.idempotencyKey : undefined;
    const sameKey = key
      ? `reintentá con el MISMO idempotencyKey (idempotencyKey=${key})`
      : "repetirla con el MISMO idempotencyKey";
    const verify = e.mutating
      ? ` Era una escritura: pudo haberse aplicado. Verificá (outbox_versions / outbox_get_blocks / outbox_read_comments) antes de repetirla. Si hay que repetirla, ${sameKey}: evita el duplicado en las operaciones que outbox_capabilities lista en features.idempotencyEndpoints; en las que no figuren ahí, el retry puede duplicarla.`
      : "";
    return {
      code: e.kind === "timeout" ? "network_timeout" : "network_unreachable",
      status: null,
      retryable: true,
      host: e.host,
      ...(key ? { idempotencyKey: key } : {}),
      fix:
        e.kind === "timeout"
          ? `El back (${e.host}) no respondió en ${Math.round(e.timeoutMs / 1000)}s. Reintentá en un momento.${verify}`
          : `No se pudo conectar con ${e.host}: revisá la red, el proxy o OUTBOX_API_BASE.${verify}`,
    };
  }
  if (e instanceof OutboxToolError) {
    return { code: e.code, status: null, retryable: e.retryable, fix: e.fix, message: e.message, ...(e.details ?? {}) };
  }
  if (e instanceof OutboxApiError) {
    const b = e.body;
    const code = typeof b?.error === "string" ? b.error : `http_${e.status}`;
    const base: StructuredError = { code, status: e.status, retryable: false, fix: "" };
    if (typeof b?.message === "string") base.message = b.message;
    // Pasada 3: el back manda `hint` accionable en muchos errores (keys.ts, page-data.ts,
    // secret-scan...). Antes se descartaba y el agente recibía el genérico por status.
    const backHint = typeof b?.hint === "string" && b.hint.trim() ? b.hint.trim() : undefined;
    if (backHint) base.hint = backHint;
    // Ronda 4 (worker lib/request-id.ts, capabilities features.errorRequestId): todo
    // body JSON de error trae `requestId` (= header x-request-id), el "ID para
    // soporte". Solo un charset opaco y acotado: es texto del back que llega al agente.
    if (typeof b?.requestId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(b.requestId)) base.requestId = b.requestId;
    if (typeof b?.missingScope === "string") base.missingScope = b.missingScope;
    if (Array.isArray(b?.missingAnyOf)) base.missingAnyOf = b.missingAnyOf;
    const cta = extractUpgradeCta(b);
    if (cta) {
      base.upgradeCta = cta;
      if (typeof b?.retryAfter === "number") base.retryAfter = b.retryAfter;
      base.retryable = cta.error === "rate_limited";
      // El back ya arma un `fix` con el reset y lo que desbloquea el plan siguiente
      // (worker lib/limit-response.ts). Si viene, va tal cual (acotado); si no, el genérico.
      const backFix = typeof b?.fix === "string" && b.fix.trim() ? b.fix.trim().slice(0, 1000) : undefined;
      const link = cta.upgradeUrl ?? cta.ctaUrl;
      base.fix =
        backFix ??
        (cta.error === "rate_limited"
          ? `Esperá${base.retryAfter ? ` ~${base.retryAfter}s` : ""} antes de reintentar (no en loop).${cta.upgradeTo && link ? ` Para más cuota: ${link}` : ""}`
          : cta.upgradeTo && link
            ? `Límite del plan: el usuario puede subir a ${cta.upgradeTo} (${link}).`
            : "Límite del plan en el tier más alto: reducí el uso (borrar, compactar) o esperá el reset.");
      return base;
    }
    if (code === "private_read_scope_required") {
      base.missingAnyOf = base.missingAnyOf ?? PRIVATE_READ_ANY_OF;
      base.fix =
        "La key no puede leer páginas privadas/unlisted: le falta el verbo `list` (o admin:self). Emití una key con `--verbs publish,list` (outbox_gen_agent_key verbs ['publish','list']).";
      return base;
    }
    if (code === "cross_user_export_forbidden") {
      base.fix =
        "De otro usuario solo se leen sus páginas `public` (o las que te compartió con un grant). Pedile al owner un grant o que la haga pública.";
      return base;
    }
    if (code === "version_conflict") {
      base.retryable = true;
      for (const k of ["current", "yours", "expectedVersion", "currentEtag"]) if (b && k in b) base[k] = b[k];
      // El worker (commitPage, worker-integrity) responde `currentVersion`; `current`
      // es la forma del chequeo local del MCP. Se normaliza a `current`.
      if (b && !("current" in b) && "currentVersion" in b) base.current = b.currentVersion;
      base.fix =
        "La página cambió desde que la leíste. Releé con outbox_pull, mergeá tus cambios sobre la versión actual y re-publicá con expectedVersion = la versión actual.";
      return base;
    }
    if (code === "step_up_required") {
      // PEN-03: la cuenta tiene MFA; emitir/rotar keys o instanciar agentes pide
      // un código fresco. NO es una credencial rota: reintentable con mfaCode.
      // Seguridad pasada 4 (worker lib/mfa-verify.ts): el TOTP es de UN solo uso.
      // `reason: 'code_already_used'` = el código era válido pero ya se gastó en otra
      // operación (o en el intento anterior): hace falta el PRÓXIMO código.
      base.retryable = true;
      if (typeof b?.reason === "string") base.reason = b.reason;
      base.fix =
        b?.reason === "code_already_used"
          ? "Ese código MFA ya se usó: cada código sirve para UNA sola operación. Pedile al usuario el PRÓXIMO código de su app de autenticación (cambia cada 30 s) y reintentá la MISMA tool con ese mfaCode nuevo. No reuses el anterior."
          : "La cuenta tiene MFA activo: pedile al usuario su código TOTP (o un recovery code) y reintentá la MISMA tool con mfaCode. Cada código sirve para UNA sola operación: no lo reuses en otra tool ni en un reintento. No lo inventes ni lo guardes.";
      return base;
    }
    if (code === "folder_escalation" || code === "slug_not_under_allowed_folder") {
      // Worker (seguridad pasada 4): una key confinada a carpetas (algún scope f/) solo
      // emite/rota keys bajo esas carpetas (folder_escalation), y solo opera sobre slugs
      // dentro de ellas (slug_not_under_allowed_folder). Trae `allowedFolders`.
      const folders = Array.isArray(b?.allowedFolders)
        ? b.allowedFolders.filter((f): f is string => typeof f === "string")
        : [];
      if (folders.length) base.allowedFolders = folders;
      const where = folders.length ? ` (${folders.join(", ")})` : "";
      base.fix =
        code === "folder_escalation"
          ? `Esta key está acotada a carpetas${where}: solo puede emitir o rotar keys acotadas a esas carpetas. Usá \`folder\` dentro de tus carpetas (p. ej. outbox_gen_agent_key con folder) o pedile al usuario que la emita desde out-box.dev. No reintentes igual.`
          : `Esta key está acotada a carpetas${where}: solo opera sobre slugs dentro de ellas. Usá un slug bajo una de esas carpetas o pedile al usuario una key sin esa restricción. No reintentes igual.`;
      return base;
    }
    if (code === "read_scope_required") {
      // Worker page-data.ts (seguridad pasada 4): abrir la lectura de las entradas de una
      // página a los visitantes exige poder leerlas (scope list sobre esa página).
      base.fix =
        "Abrir la lectura de los datos de la página a visitantes exige que la key pueda leerlos (verbo `list` sobre esa página, o una sesión del usuario). Pedile al usuario una key con `list` o que lo active desde out-box.dev. No reintentes con esta key.";
      return base;
    }
    if (code === "idempotency_in_progress") {
      // Worker lib/idempotency.ts: otro request con la MISMA Idempotency-Key sigue en
      // curso; este NO se ejecutó. El back lo marca retryable y manda Retry-After.
      base.retryable = true;
      const ra = e.retryAfter ?? (typeof b?.retryAfter === "number" ? b.retryAfter : undefined);
      if (ra !== undefined) base.retryAfter = ra;
      if (e.idempotencyKey) base.idempotencyKey = e.idempotencyKey;
      base.fix = `Todavía está en curso un request con esta misma idempotencyKey (este no se aplicó). Esperá${
        ra !== undefined ? ` ~${ra}s` : " unos segundos"
      } y reintentá la MISMA tool con el MISMO idempotencyKey${
        e.idempotencyKey ? ` (idempotencyKey=${e.idempotencyKey})` : ""
      }: si el primero terminó, el back devuelve su resultado sin duplicar. No cambies la key (con una nueva la escritura se aplicaría dos veces).`;
      return base;
    }
    if (code === "daily_not_found") {
      // Worker handlers/daily.ts: GET /api/daily/... sin manifest para esa fecha (o el
      // daily no existe). Los dailies no aparecen en outbox_list / outbox_search, así
      // que el genérico del 404 mandaba a buscar donde no están.
      if (typeof b?.date === "string") base.date = b.date;
      base.fix =
        "No hay bloques para esa fecha (o ese daily todavía no existe). Omití `date` para ver el último día con contenido; si el slug puede estar mal, confirmalo con el usuario (los dailies no aparecen en outbox_list ni outbox_search).";
      return base;
    }
    if (code === "daily_exists") {
      // Worker handlers/daily.ts (ronda 4): append con createOnly:true sobre un slug que
      // ya tiene daily (cualquier fecha). NO se escribió nada (ni bloque ni cuota).
      if (typeof b?.existingDate === "string") base.existingDate = b.existingDate;
      base.fix =
        "Ese slug ya tiene un daily (no se escribió nada). Si el usuario quería sumar al daily existente, repetí el append SIN createOnly; si quería uno nuevo, elegí otro slug. No reintentes igual.";
      return base;
    }
    if (code === "slug_not_allowed") {
      // Worker (pasada 2): la key tiene slugWhitelist y el slug no está en la lista
      // (visibility, password, draft, rollback, squash, delete, share, grants).
      base.fix =
        "Esta key tiene una lista de slugs permitidos (slugWhitelist) y este slug no está en ella. Operá sobre un slug de la lista o pedile al usuario una key sin esa restricción.";
      return base;
    }
    if (code === "concurrent_update") {
      // Worker lib/commit-page.ts: agotó los reintentos por escrituras concurrentes.
      // Desde la pasada 4 manda Retry-After (+ retryAfter en el body).
      base.retryable = true;
      const ra = e.retryAfter ?? (typeof b?.retryAfter === "number" ? b.retryAfter : undefined);
      if (ra !== undefined) base.retryAfter = ra;
      base.fix =
        "La página cambió varias veces mientras se aplicaba el cambio (escrituras concurrentes). Reintentá la misma operación una vez; si vuelve a fallar, releé el recurso y avisale al usuario.";
      return base;
    }
    if (code === "comment_scope_required") {
      // Worker auth-visitor.ts (seguridad pasada 3): comentar, sugerir, reaccionar o
      // agregar datos en una página de OTRA cuenta exige publish:<propio> amplio (sin
      // carpeta ni whitelist). Una key de solo lectura o acotada nunca va a poder.
      if (typeof b?.missingScope === "string") base.missingScope = b.missingScope;
      base.fix =
        "Esta key no puede escribir en páginas de otra cuenta (comentar, sugerir, reaccionar o agregar datos): hace falta una key con publish sobre la propia cuenta, sin carpeta ni lista de slugs. No reintentes con esta key; si el usuario lo pidió, que lo haga desde out-box.dev.";
      return base;
    }
    if (code === "invalid_expiresInDays") {
      // Worker issued-expiry.ts (seguridad pasada 3): una key de agente no emite share
      // links ni grants sin vencimiento.
      base.fix =
        "Esta key no puede emitir share links ni grants sin vencimiento: mandá expiresInDays con un número de días (el `message` del back dice el rango). No reintentes con null.";
      return base;
    }
    if (code === "oauth_key_not_rotatable") {
      // Worker keys.ts (pasada 1): una key emitida por el connector OAuth no se rota
      // (el clon heredaría el grant y caería con él). Reintentar nunca funciona.
      base.fix =
        "Esa key la emitió un connector OAuth (p. ej. el de Claude): no se rota. Para renovarla, el usuario desconecta y reconecta el connector; para cortarle el acceso, revocala con outbox_revoke_key. No reintentes la rotación.";
      return base;
    }
    if (code === "expiry_escalation" || code === "slug_whitelist_escalation") {
      // Worker keys.ts / agents.ts (seg p2): la key que emite o rota no puede vivir más ni
      // cubrir más slugs que la credencial que la pide (antes solo se comparaban scopes).
      if (typeof b?.maxExpiresAt === "string") base.maxExpiresAt = b.maxExpiresAt;
      if (Array.isArray(b?.allowedSlugs)) base.allowedSlugs = b.allowedSlugs;
      base.fix =
        code === "expiry_escalation"
          ? "Esta key vence: solo puede emitir o rotar keys, share links y grants que venzan antes que ella (ver maxExpiresAt). Pedí un vencimiento menor (`days` / `expiresInDays`) o pedile al usuario que lo haga desde out-box.dev. No reintentes igual."
          : "Esta key está acotada a slugs: solo puede emitir, rotar o clonar agentes con una slugWhitelist dentro de la suya (ver allowedSlugs). No reintentes igual.";
      return base;
    }
    if (code === "key_expired" && e.status === 409) {
      // Worker keys.ts (#31): rotar una key vencida clonaría su expiresAt pasado.
      base.fix =
        "La key ya venció: rotarla no sirve. Emití una nueva con outbox_gen_agent_key (y revocá la vencida con outbox_revoke_key si querés limpiarla). No reintentes la rotación.";
      return base;
    }
    if (code === "secrets_detected") {
      // Worker secret-scan.ts: 422 con rejectOnSecrets:true, NO se escribió nada. Los
      // hallazgos vienen redactados (nunca el secreto completo).
      if (Array.isArray(b?.secrets)) base.secrets = b.secrets;
      if (typeof b?.count === "number") base.count = b.count;
      base.fix =
        "No se publicó: el contenido parece incluir credenciales (ver `secrets`: tipo y línea). Sacalas del contenido y volvé a publicar; avisale al usuario que, si ya estuvieron expuestas, las rote en el proveedor.";
      return base;
    }
    // El back marca `retryable: true` en errores transitorios que no tienen caso propio acá.
    if (b?.retryable === true) base.retryable = true;
    // Sin caso propio: el `hint` del back es más preciso que el genérico por status.
    // Salvo donde el genérico ya es el remedio correcto o arma campos propios:
    // 401 (credencial), 403 con scope faltante, 413 (límites), 429 (espera) y 5xx.
    const hasScope = Boolean(base.missingScope ?? base.missingAnyOf?.length);
    if (backHint && e.status !== 401 && e.status !== 413 && e.status !== 429 && e.status < 500 && !(e.status === 403 && hasScope)) {
      base.fix = backHint;
      return base;
    }
    switch (e.status) {
      case 401:
        base.fix = "Credencial inválida, vencida o revocada: verificá OUTBOX_API_KEY / ~/.outboxrc.";
        return base;
      case 403: {
        const scope = base.missingScope ?? (base.missingAnyOf?.length ? base.missingAnyOf.join(" o ") : undefined);
        base.fix = scope
          ? `A la key le falta el scope ${scope}. Pedile al usuario una key con ese verbo/carpeta.`
          : "La key no tiene permiso sobre este recurso (verbo o carpeta). Pedile al usuario una key con el scope necesario.";
        return base;
      }
      case 404:
        base.fix =
          "El recurso no existe o no es visible para esta key. Revisá user/slug con outbox_list o outbox_search.";
        return base;
      case 409:
        base.fix = "Conflicto con el estado actual: releé el recurso antes de reintentar.";
        return base;
      case 413: {
        for (const k of SIZE_LIMIT_FIELDS) if (typeof b?.[k] === "number") base[k] = b[k];
        const max = typeof b?.maxBytes === "number" ? b.maxBytes : typeof b?.limit === "number" ? b.limit : undefined;
        base.fix = isPlanTooLarge(code)
          ? "El contenido es demasiado grande para el plan: reducilo (subí imágenes con outbox_upload) o pasá a un plan mayor."
          : `El contenido supera un límite FIJO del back${max !== undefined ? ` (${max} bytes)` : ""}, igual en todos los planes: subir de plan no lo resuelve. Partilo en piezas más chicas${
              max !== undefined ? ` (≤ ${max} bytes cada una, p. ej. varios bloques)` : " (p. ej. varios bloques)"
            } o sacá las imágenes embebidas (subilas con outbox_upload).`;
        return base;
      }
      case 429: {
        const retry = b?.retryAfter ?? b?.retryIn;
        if (typeof retry === "number") base.retryAfter = retry;
        base.retryable = true;
        base.fix = `Esperá${typeof retry === "number" ? ` ~${retry}s` : " un momento"} antes de reintentar (no en loop).`;
        return base;
      }
      default:
        if (e.status >= 500) {
          base.retryable = true;
          base.fix = "Error del back: reintentá en un momento. Si persiste, avisale al usuario.";
        } else {
          base.fix = "Revisá los argumentos de la tool (el `message` del back explica el valor aceptado).";
        }
        return base;
    }
  }
  return {
    code: "invalid_input",
    status: null,
    retryable: false,
    fix: "Revisá los argumentos de la tool.",
    message: e instanceof Error ? e.message : String(e),
  };
}

/** Traduce cualquier error a un mensaje accionable para el agente. */
export function formatError(e: unknown): string {
  if (e instanceof MissingCredentialError) {
    return `Error: Outbox MCP sin credencial. ${describeError(e).fix}`;
  }
  if (e instanceof OutboxNetworkError) {
    return `Error de red: ${describeError(e).fix}`;
  }
  if (e instanceof OutboxToolError) {
    return `Error (${e.code}): ${e.message} ${e.fix}`;
  }
  if (e instanceof OutboxApiError) {
    const b = e.body;
    const backMessage = typeof b?.message === "string" ? b.message : undefined;
    // Límite de plan (403/413/429 con bloque CTA) ANTES que el switch por status:
    // un 403 daily_docs_limit / keys_limit NO es "falta scope".
    const cta = extractUpgradeCta(b);
    if (cta) return formatPlanLimit(e.status, cta, b?.retryAfter, backMessage);
    // Código de límite de plan SIN bloque CTA (hoy: 413 html_too_large de publish.ts,
    // jsonError plano). Es límite del plan, pero no hay datos para afirmar si existe
    // upgrade: se pasa el `message` del back, que ya explica qué hacer.
    // `rate_limited` sin bloque es el anti-spam de comments (no de plan) → cae al 429.
    if (b?.error && b.error !== "rate_limited" && PLAN_LIMIT_CODES.has(b.error)) {
      return `Error ${e.status}: límite del plan alcanzado (${b.error}). No es un problema de permisos/scope de la key: cambiar de key no lo resuelve.${
        backMessage ? ` Detalle del back: ${backMessage}` : ""
      }`;
    }
    // AX-03: códigos con causa conocida → mensaje específico (antes: "no existe o no sos el owner").
    if (b?.error === "private_read_scope_required") {
      return `Error 403 (private_read_scope_required): la key no puede leer páginas privadas/unlisted — le falta el verbo \`list\` (o admin:self). ${describeError(e).fix}`;
    }
    if (b?.error === "slug_not_allowed") {
      return `Error 403 (slug_not_allowed): ${describeError(e).fix}`;
    }
    // 401 step_up_required NO es una credencial rota: sin este caso caía al genérico
    // "credencial inválida" del switch por status.
    if (b?.error === "step_up_required") {
      return `Error ${e.status} (step_up_required${b.reason === "code_already_used" ? ", code_already_used" : ""}): ${describeError(e).fix}`;
    }
    if (
      b?.error === "folder_escalation" ||
      b?.error === "slug_not_under_allowed_folder" ||
      b?.error === "read_scope_required"
    ) {
      return `Error ${e.status} (${b.error}): ${describeError(e).fix}`;
    }
    if (b?.error === "daily_exists") {
      return `Error 409 (daily_exists${typeof b.existingDate === "string" ? `, último día ${b.existingDate}` : ""}): no reintentable. ${describeError(e).fix}`;
    }
    if (b?.error === "daily_not_found") {
      return `Error 404 (daily_not_found${typeof b.date === "string" ? `, ${b.date}` : ""}): ${describeError(e).fix}`;
    }
    if (b?.error === "cross_user_export_forbidden") {
      return `Error 403 (cross_user_export_forbidden): ${describeError(e).fix}`;
    }
    if (b?.error === "idempotency_in_progress" || b?.error === "concurrent_update") {
      return `Error 409 (${b.error}): conflicto transitorio, reintentable. ${describeError(e).fix}`;
    }
    if (b?.error === "expiry_escalation" || b?.error === "slug_whitelist_escalation") {
      return `Error ${e.status} (${b.error}): no reintentable. ${describeError(e).fix}`;
    }
    if (b?.error === "oauth_key_not_rotatable" || (b?.error === "key_expired" && e.status === 409)) {
      return `Error ${e.status} (${b.error}): no reintentable. ${describeError(e).fix}`;
    }
    if (b?.error === "secrets_detected") {
      const found = Array.isArray(b.secrets) ? secretsSummary(b.secrets) : "";
      return `Error ${e.status} (secrets_detected): ${found ? `posibles credenciales en el contenido (${found}). ` : ""}${describeError(e).fix}`;
    }
    if (b?.error === "version_conflict") {
      const curV = b.current !== undefined ? b.current : b.currentVersion;
      const cur = curV !== undefined ? ` (versión actual: ${JSON.stringify(curV)})` : "";
      return `Error 409 (version_conflict): la página cambió desde que la leíste${cur}. ${describeError(e).fix}`;
    }
    const scope =
      b?.missingScope ?? (b?.missingAnyOf?.length ? b.missingAnyOf.join(" o ") : undefined);
    // Pasada 3: el `hint` del back (si vino) se suma al texto; describeError lo usa como fix.
    const hint = typeof b?.hint === "string" && b.hint.trim() ? ` ${b.hint.trim()}` : "";
    switch (e.status) {
      case 401:
        return "Error 401: credencial inválida o ausente. Verificá OUTBOX_API_KEY (Bearer outbox_*).";
      case 403:
        return `Error 403: la key no tiene permiso${scope ? ` (falta scope: ${scope})` : ""}. Usá una key con el scope/folder necesario.${
          b?.error && b.error !== "forbidden" ? ` (${b.error})` : ""
        }${hint}`;
      case 404:
        return "Error 404: el recurso no existe o no es visible para esta key. Revisá user/slug (outbox_list / outbox_search).";
      case 409:
        return `Error 409: conflicto (${
          b?.error === "anchor_not_found"
            ? "el texto anclado ya no existe en la página; releé el post y descartá la sugerencia si quedó obsoleta"
            : b?.error === "comment_not_open"
              ? "el comentario ya no está abierto"
              : (b?.error ?? b?.message ?? "el estado del recurso cambió")
        }).${hint}`;
      case 410:
        return `Error 410: el recurso expiró o fue consumido.${hint}`;
      case 413:
        return b?.error && !isPlanTooLarge(b.error)
          ? `Error 413 (${b.error}): el contenido es demasiado grande. ${describeError(e).fix}`
          : "Error 413: el contenido es demasiado grande.";
      case 429: {
        // quota → `retryAfter`; anti-spam de comments → `retryIn` (mismo significado: segundos).
        const retry = b?.retryAfter ?? b?.retryIn;
        return `Error 429: límite de uso alcanzado${retry ? `, reintentá en ~${retry}s` : ""}. No reintentes antes de ese plazo ni en loop.${
          backMessage ? ` (${backMessage})` : ""
        }`;
      }
      default:
        // Sumar `message` cuando viene junto a `error`: el back explica ahí el
        // valor aceptado (ej. 400 invalid_events lista los eventos válidos).
        return `Error ${e.status} en ${e.path}: ${b?.error ?? b?.message ?? "fallo de la API"}${
          b?.error && typeof b?.message === "string" ? ` (${b.message})` : ""
        }${e.status < 500 ? hint : ""}`;
    }
  }
  return `Error: ${e instanceof Error ? e.message : String(e)}`;
}
