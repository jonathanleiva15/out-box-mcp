/**
 * Constantes compartidas del Outbox MCP server.
 *
 * DOBLE BASE (contrato del back, ver matriz-endpoints.md):
 * - API_BASE  → mutaciones, listados, gestión (api.out-box.dev).
 * - SITE_BASE → lectura del HTML servido por el catch-all público (out-box.dev).
 *   El HTML NUNCA se lee desde api.out-box.dev ni con prefijo `/u/`: se construye
 *   `SITE_BASE/<user>/<slug>` SIN `/u/` (front-worker.ts manda `/u/*` a Next, no al back).
 */
export const API_BASE = process.env.OUTBOX_API_BASE ?? "https://api.out-box.dev";
export const SITE_BASE = process.env.OUTBOX_SITE_BASE ?? "https://out-box.dev";

/** Límite de caracteres para respuestas (evita saturar el contexto del agente). */
export const CHARACTER_LIMIT = 25000;

export const SERVER_NAME = "outbox-mcp-server";
export const SERVER_VERSION = "0.1.0";
export const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;
