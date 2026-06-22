/**
 * Cliente HTTP del back de Outbox. Cliente puro (mismo patrón que el CLI/front/rust).
 * - Auth: Bearer `outbox_*`.
 * - Doble base: API_BASE para mutaciones/listados; SITE_BASE para leer HTML (sin `/u/`).
 * - Errores: parsea `missingScope` || `missingAnyOf` (contrato §3.3 de la matriz).
 */
import { API_BASE, SITE_BASE, USER_AGENT } from "../constants.js";

export interface OutboxErrorBody {
  error?: string;
  message?: string;
  /** de requireScope/requireVerb (auth.ts) */
  missingScope?: string;
  /** de requireOneOfScopes (auth.ts) */
  missingAnyOf?: string[];
  /** de requireQuota (429) — segundos hasta poder reintentar (back: quota middleware → `retryAfter`) */
  retryAfter?: number;
  [k: string]: unknown;
}

export class OutboxApiError extends Error {
  constructor(
    public status: number,
    public body: OutboxErrorBody | null,
    /** SECURITY: pathname-only (+ search), NEVER a full URL — must not carry credentials. */
    public path: string,
  ) {
    super(`Outbox API ${status} en ${path}: ${body?.error ?? "error"}`);
    this.name = "OutboxApiError";
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface ReqInit {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

export class OutboxClient {
  constructor(private readonly apiKey: string) {}

  async req<T>(path: string, init: ReqInit = {}): Promise<T> {
    const method = init.method ?? "GET";
    const url = new URL(API_BASE + path);
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: "application/json",
      "user-agent": USER_AGENT,
    };
    if (MUTATING.has(method)) headers["x-requested-with"] = "XMLHttpRequest";

    let body: string | undefined;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }

    const res = await fetch(url, { method, headers, body });
    if (!res.ok) {
      let parsed: OutboxErrorBody | null = null;
      try {
        parsed = (await res.json()) as OutboxErrorBody;
      } catch {
        parsed = null;
      }
      throw new OutboxApiError(res.status, parsed, path);
    }
    const text = await res.text();
    return (text ? (JSON.parse(text) as T) : ({} as T));
  }

  /**
   * Lee el HTML público servido por el catch-all. CONTRATO: `SITE_BASE/<user>/<slug>`
   * SIN `/u/`. Para privados, el Bearer debe ser del owner; si no, el back responde 404.
   *
   * Solo devuelve el ESTADO ACTUAL: el catch-all (serve.ts) no lee `?version=` —
   * solo maneja `?share=` y `?date=`. No existe endpoint que sirva el HTML crudo de
   * una versión histórica (getVersionContent solo está wireado en /diff y /rollback).
   * Para ver/restaurar versiones viejas: outbox_versions + outbox_rollback.
   */
  async readHtml(user: string, slug: string): Promise<string> {
    const url = new URL(`${SITE_BASE}/${encodeURIComponent(user)}/${encodeURIComponent(slug)}`);
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${this.apiKey}`, "user-agent": USER_AGENT },
    });
    // SECURITY: the `path` passed to OutboxApiError must be pathname-only (never the
    // full URL), so a logged/surfaced error can't expose the scheme/host. The Bearer
    // token only lives in the request header, never in the URL — keep it that way.
    const safePath = url.pathname + url.search;
    if (!res.ok) {
      if (res.status === 404) {
        throw new OutboxApiError(404, { error: "not_found_or_private" }, safePath);
      }
      throw new OutboxApiError(res.status, null, safePath);
    }
    return res.text();
  }
}

/** Traduce cualquier error a un mensaje accionable para el agente. */
export function formatError(e: unknown): string {
  if (e instanceof OutboxApiError) {
    const b = e.body;
    const scope =
      b?.missingScope ?? (b?.missingAnyOf?.length ? b.missingAnyOf.join(" o ") : undefined);
    switch (e.status) {
      case 401:
        return "Error 401: credencial inválida o ausente. Verificá OUTBOX_API_KEY (Bearer outbox_*).";
      case 403:
        return `Error 403: la key no tiene permiso${scope ? ` (falta scope: ${scope})` : ""}. Usá una key con el scope/folder necesario.`;
      case 404:
        return "Error 404: el recurso no existe, o es privado y la key no es del owner.";
      case 409:
        return `Error 409: conflicto (${
          b?.error === "anchor_not_found"
            ? "el texto anclado ya no existe en la página; releé el post y descartá la sugerencia si quedó obsoleta"
            : b?.error === "comment_not_open"
              ? "el comentario ya no está abierto"
              : (b?.error ?? b?.message ?? "el estado del recurso cambió")
        }).`;
      case 410:
        return "Error 410: el recurso expiró o fue consumido.";
      case 413:
        return "Error 413: el contenido es demasiado grande.";
      case 429:
        return `Error 429: límite de uso alcanzado${b?.retryAfter ? `, reintentá en ~${b.retryAfter}s` : ""}. NO reintentar automáticamente.`;
      default:
        return `Error ${e.status} en ${e.path}: ${b?.error ?? b?.message ?? "fallo de la API"}`;
    }
  }
  return `Error inesperado: ${e instanceof Error ? e.message : String(e)}`;
}
