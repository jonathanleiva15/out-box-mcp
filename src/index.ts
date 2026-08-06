#!/usr/bin/env node
/**
 * Outbox MCP server (out-box.dev) — agents-first.
 *
 * Expone Outbox como tools nativas para clientes MCP (Claude Desktop, Cursor, etc.)
 * sin curl ni CLI. Transporte: stdio (local). Auth: Bearer `outbox_*` (env OUTBOX_API_KEY
 * o ~/.outboxrc). Ver decisiones-jonathan.md §14.4 y _auditoria/planes/02-mcp.md.
 *
 * NOTA: stdio NO debe loguear a stdout — solo stderr (console.error).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { API_BASE, CHARACTER_LIMIT, SERVER_NAME, SERVER_VERSION, SITE_BASE, USER_AGENT } from "./constants.js";
import { loadConfig } from "./config.js";
import { SLUG_SCHEMA, PREFIX_SCHEMA, USER_SCHEMA, TEAM_HANDLE_SCHEMA, FREE_TEXT_SCHEMA } from "./schemas.js";
import { encodeSlugPath } from "./paths.js";
import { OutboxClient, OutboxApiError, formatError, type OutboxErrorBody } from "./services/client.js";

// ── Bootstrap ────────────────────────────────────────────────────────────────
const config = loadConfig();
const client = new OutboxClient(config.apiKey);

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

// ── Helpers ──────────────────────────────────────────────────────────────────
type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  let text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (text.length > CHARACTER_LIMIT) {
    const original = text.length;
    text =
      text.slice(0, CHARACTER_LIMIT) +
      `\n…(response truncated at ${CHARACTER_LIMIT} of ${original} chars — narrow with prefix/limit/range filters. ` +
      `respuesta truncada en ${CHARACTER_LIMIT} de ${original} caracteres; acotá con filtros de prefix/limit/rango.)`;
  }
  return { content: [{ type: "text", text }] };
}

function fail(e: unknown): ToolResult {
  return { isError: true, content: [{ type: "text", text: formatError(e) }] };
}

/**
 * Igual que ok() pero SIN el cap de CHARACTER_LIMIT. Para tools que devuelven
 * contenido AUTORITATIVO destinado a round-trip / backup: truncar acá corrompe el
 * contenido. Un outbox_pull recortado que el agente re-publica pisa la página con
 * HTML mutilado (pérdida de datos irreversible en la versión vigente), y un backup
 * JSON cortado a la mitad queda inválido/inusable. El cap de CHARACTER_LIMIT queda
 * reservado para las tools de listado/metadata, donde acotar el contexto es seguro.
 * (BUGS-VALIDACION #7.)
 */
function raw(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

/**
 * POST de bytes crudos a /api/uploads. El worker (uploads.ts → readUploadBytes)
 * NO decodifica base64: para un request no-multipart lee el body crudo con
 * `req.arrayBuffer()` y valida los magic bytes del contenido. Mandar
 * {data:base64,...} como JSON fallaba SIEMPRE (el back veía los bytes del string
 * JSON, que no matchean ningún magic number → 415). Por eso decodificamos el
 * base64 y posteamos los bytes ya crudos con el content-type declarado (solo
 * hint; el back valida el contenido real). Mismo manejo de auth/errores que
 * OutboxClient.req para que fail()/formatError sean idénticos. (BUGS-VALIDACION #6.)
 */
async function uploadImageBytes(bytes: Uint8Array, contentType: string): Promise<unknown> {
  const url = new URL(API_BASE + "/api/uploads");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      accept: "application/json",
      "user-agent": USER_AGENT,
      "content-type": contentType,
      "x-requested-with": "XMLHttpRequest",
    },
    body: bytes,
  });
  if (!res.ok) {
    let parsed: OutboxErrorBody | null = null;
    try {
      parsed = (await res.json()) as OutboxErrorBody;
    } catch {
      parsed = null;
    }
    throw new OutboxApiError(res.status, parsed, "/api/uploads");
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

const VISIBILITY = z.enum(["private", "unlisted", "public"]);

/** Resuelve el username del owner: param explícito → cache → /api/me. */
let cachedUser: string | undefined = config.user;
async function resolveUser(provided?: string): Promise<string> {
  if (provided) return provided;
  if (cachedUser) return cachedUser;
  const me = await client.req<{ user?: string; username?: string }>("/api/me");
  cachedUser = me.user ?? me.username;
  if (!cachedUser) {
    throw new Error(
      "Could not determine the user. Pass `user` explicitly. / No se pudo determinar el usuario. Pasá `user` explícitamente.",
    );
  }
  return cachedUser;
}

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

// ── Tools: lectura ─────────────────────────────────────────────────────────────
server.registerTool(
  "outbox_me",
  {
    title: "Outbox: mi perfil",
    description:
      "Devuelve la cuenta autenticada de Outbox: usuario, tier, límites y origen de auth. Útil para saber quién sos y qué scopes/quota tenés antes de publicar. Read-only.",
    inputSchema: {},
    annotations: { ...RO, idempotentHint: true },
  },
  async () => {
    try {
      return ok(await client.req("/api/me"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_usage",
  {
    title: "Outbox: consumo y cuota",
    description:
      "Devuelve el snapshot de uso y límites de la cuenta (GET /api/me/usage): publishes por hora/día, storage, agent keys, daily docs, todo contra el tope del tier. " +
      "Usalo antes de un batch grande para no chocar con la cuota. `refresh=true` saltea el cache de 5 min. Read-only.",
    inputSchema: {
      refresh: z.boolean().default(false).describe("true = fuerza recálculo (saltea cache de 5 min)"),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ refresh }) => {
    try {
      return ok(await client.req("/api/me/usage", { query: { refresh: refresh ? "true" : undefined } }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_list",
  {
    title: "Outbox: listar páginas",
    description:
      "Lista las páginas (HTMLs) de tu biblioteca. Filtro opcional por tag y límite. Read-only.\n\nArgs: tag (string, opcional), limit (1-200, default 50).",
    inputSchema: {
      tag: z.string().min(1).max(64).optional().describe("Filtrar por tag"),
      limit: z.number().int().min(1).max(200).default(50).describe("Máximo de resultados"),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ tag, limit }) => {
    try {
      return ok(await client.req("/api/list", { query: { tag, limit } }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_list_tree",
  {
    title: "Outbox: árbol de la biblioteca",
    description:
      "Devuelve la biblioteca como árbol (carpetas + páginas) hasta `depth` niveles. Con `shared=true` devuelve lo que te compartieron a vos. Read-only.",
    inputSchema: {
      depth: z.union([z.literal(1), z.literal(2)]).default(2).describe("Niveles de profundidad (1 o 2)"),
      shared: z.boolean().default(false).describe("true = páginas compartidas conmigo"),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ depth, shared }) => {
    try {
      return ok(await client.req("/api/list", { query: { depth, shared: shared ? 1 : undefined } }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_read",
  {
    title: "Outbox: leer el HTML de una página",
    description:
      "Devuelve el HTML servido (estado ACTUAL) de una página. Lee del sitio público (out-box.dev/<user>/<slug>, sin /u/). " +
      "Para páginas privadas, la key debe ser del owner (si no, 404). " +
      "Solo lee la versión vigente; el back NO sirve versiones históricas por HTML. " +
      "Para una versión vieja usá `outbox_versions` (historial) + `outbox_rollback` (restaurar), o `outbox_export` para el estado actual machine-readable. Read-only.",
    inputSchema: {
      slug: SLUG_SCHEMA.describe("Slug/path de la página. Acepta paths jerárquicos estilo Confluence (ej. 'briefings/hoy', 'clientes/solera/q3')"),
      user: USER_SCHEMA.optional().describe("Owner (default: vos)"),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ slug, user }) => {
    try {
      const u = await resolveUser(user);
      const html = await client.readHtml(u, slug);
      return raw(html);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_open",
  {
    title: "Outbox: URL canónica de una página",
    description:
      "Devuelve la URL pública canónica de una página (out-box.dev/<user>/<slug>, SIN /u/) para abrir o compartir. " +
      "NO le pega al back: solo construye la URL a partir del owner + slug (resuelve el owner igual que el resto de tools). " +
      "Para páginas privadas la URL solo carga con la sesión/key del owner; para unlisted/public abre directo. " +
      "Para LEER el contenido usá outbox_pull / outbox_read. Read-only, sin red.",
    inputSchema: {
      slug: SLUG_SCHEMA.describe("Slug/path de la página (acepta paths jerárquicos, ej. 'briefings/hoy')"),
      user: USER_SCHEMA.optional().describe("Owner (default: vos)"),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ slug, user }) => {
    try {
      const u = await resolveUser(user);
      const url = `${SITE_BASE}/${encodeURIComponent(u)}/${encodeSlugPath(slug)}`;
      return ok({ url, user: u, slug });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_pull",
  {
    title: "Outbox: traer el contenido de una página (string)",
    description:
      "Trae el HTML servido (estado ACTUAL) de una página como STRING crudo, listo para que el agente lo lea/transforme. " +
      "Es el atajo 'dame el contenido' del flujo agents-first: pull → sumar contexto → outbox_append / outbox_publish. " +
      "Lee del sitio público (out-box.dev/<user>/<slug>, sin /u/); para privados la key debe ser del owner (si no, 404). " +
      "Solo sirve la versión vigente. Para JSON estructurado (metadata + contenido) usá outbox_export; para versiones viejas, outbox_versions + outbox_rollback. Read-only.",
    inputSchema: {
      slug: SLUG_SCHEMA.describe("Slug/path de la página (acepta paths jerárquicos, ej. 'briefings/hoy')"),
      user: USER_SCHEMA.optional().describe("Owner (default: vos)"),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ slug, user }) => {
    try {
      const u = await resolveUser(user);
      return raw(await client.readHtml(u, slug));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_versions",
  {
    title: "Outbox: historial de versiones",
    description:
      "Lista las versiones de una página (el versionado automático de Outbox). Read-only.",
    inputSchema: {
      slug: SLUG_SCHEMA.describe("Slug/path de la página"),
      user: USER_SCHEMA.optional().describe("Owner (default: vos)"),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ slug, user }) => {
    try {
      const u = await resolveUser(user);
      return ok(
        await client.req(`/api/u/${encodeURIComponent(u)}/${encodeSlugPath(slug)}/versions`),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_get_blocks",
  {
    title: "Outbox: bloques de un daily",
    description:
      "Devuelve los bloques de una página tipo daily (append-only). `date` opcional (YYYY-MM-DD) para un día puntual. Read-only.",
    inputSchema: {
      slug: SLUG_SCHEMA.describe("Slug del daily"),
      user: USER_SCHEMA.optional().describe("Owner (default: vos)"),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD").optional(),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ slug, user, date }) => {
    try {
      const u = await resolveUser(user);
      return ok(
        await client.req(`/api/u/${encodeURIComponent(u)}/${encodeSlugPath(slug)}/blocks`, {
          query: { date },
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_list_shares",
  {
    title: "Outbox: listar share links",
    description: "Lista los share tokens (links públicos) activos de tu cuenta. Read-only.",
    inputSchema: {},
    annotations: { ...RO, idempotentHint: true },
  },
  async () => {
    try {
      return ok(await client.req("/api/share"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_list_keys",
  {
    title: "Outbox: listar API keys",
    description:
      "Lista las API keys de tu cuenta (sin exponer el secreto). Útil para auditar qué keys/agentes tienen acceso. Read-only.",
    inputSchema: {},
    annotations: { ...RO, idempotentHint: true },
  },
  async () => {
    try {
      return ok(await client.req("/api/keys"));
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Tools: escritura / gestión ─────────────────────────────────────────────────
server.registerTool(
  "outbox_append",
  {
    title: "Outbox: agregar bloque a un daily",
    description:
      "Agrega un bloque HTML a una página tipo daily (append-only, versionado automático). " +
      "Es el flujo agents-first central: durante el día sumás contexto a un HTML. No es destructivo.",
    inputSchema: {
      slug: SLUG_SCHEMA.describe("Slug del daily (ej. 'daily/2026-05-29')"),
      html: z.string().min(1).describe("HTML del bloque a agregar"),
      user: USER_SCHEMA.optional().describe("Owner (default: vos)"),
      label: z.string().max(120).optional().describe("Etiqueta del bloque (opcional)"),
      title: z.string().max(200).optional().describe("Título de la página si se crea (opcional)"),
      visibility: VISIBILITY.optional().describe("Visibility si se crea la página (default del back)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ slug, html, user, label, title, visibility }) => {
    try {
      const u = await resolveUser(user);
      return ok(
        await client.req(`/api/u/${encodeURIComponent(u)}/${encodeSlugPath(slug)}/append`, {
          method: "POST",
          body: { html, label, title, visibility },
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Tools: comentarios / sugerencias ───────────────────────────────────────────
// Capa de anotaciones sobre una página: el HTML del owner NUNCA se modifica por
// comentar; SOLO aceptar una sugerencia (acción del owner) publica una versión
// nueva atribuida. El agente lee el texto (outbox_read / outbox_export) y propone.
server.registerTool(
  "outbox_read_comments",
  {
    title: "Outbox: comentarios y sugerencias de una página",
    description:
      "Lista los comentarios y sugerencias de una página (capa de anotaciones; NO modifica el HTML). " +
      "Cada item trae: id, kind (comment | suggestion), commenter, commenterType (human | agent), body, " +
      "anchor {exact, prefix?, suffix?}, replacement? (solo suggestion), parentId? (reply, hilo 1 nivel), " +
      "status (open | resolved | accepted | discarded), createdAt, resultingVersion?. Para ver sugerencias " +
      "pendientes filtrá por status=open. Páginas privadas: key del owner, grant view/comment, o ?share. Read-only.",
    inputSchema: {
      slug: SLUG_SCHEMA.describe("Slug/path de la página (acepta paths jerárquicos, ej 'briefings/hoy')"),
      user: USER_SCHEMA.optional().describe("Owner (default: vos)"),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ slug, user }) => {
    try {
      const u = await resolveUser(user);
      return ok(
        await client.req(`/api/u/${encodeURIComponent(u)}/${encodeSlugPath(slug)}/comments`),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_create_comment",
  {
    title: "Outbox: comentar / responder en un hilo",
    description:
      "Postea un comentario (kind 'comment') sobre una página, SIN editar el HTML (capa de anotaciones). " +
      "Es el flujo 'charlar con mi agente': el AGENTE DEL USUARIO responde/charla en el hilo — lee el contenido " +
      "(outbox_read / outbox_export) y los comentarios (outbox_read_comments), y deja un comentario o una RESPUESTA. " +
      "Para responder a un comentario/sugerencia existente pasá `parentId` (el comment.id del padre); el kind sigue " +
      "siendo 'comment' (hilo de 1 nivel). Sin `parentId` queda como comentario top-level. " +
      "`anchor.exact` (texto exacto y visible del HTML) es opcional: anclá el comentario a un fragmento puntual; " +
      "si ese texto se repite, desambiguá con prefix/suffix. `body` es TEXTO PLANO (no mandes HTML — el back lo trata " +
      "como texto). Si NO sos el owner necesitás un grant 'comment' (o un ?share token). NO modifica el HTML ni publica " +
      "versión: para proponer un cambio aplicable usá outbox_create_suggestion.",
    inputSchema: {
      slug: SLUG_SCHEMA.describe("Slug/path de la página"),
      body: z
        .string()
        .min(1)
        .max(4000)
        .describe("Texto plano del comentario / respuesta. NO HTML (el back lo trata como texto). MAX 4000"),
      parentId: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-f0-9]+$/, "ID hex (de outbox_read_comments)")
        .optional()
        .describe("ID del comentario/sugerencia al que respondés (comment.id). Omitir = comentario top-level"),
      exact: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe(
          "Texto EXACTO y visible del documento al que anclás el comentario; debe aparecer literal en el HTML servido. MAX 2000",
        ),
      prefix: z
        .string()
        .max(500)
        .optional()
        .describe("Contexto inmediatamente ANTES de `exact` (desambigua si `exact` se repite)"),
      suffix: z.string().max(500).optional().describe("Contexto inmediatamente DESPUÉS de `exact`"),
      user: USER_SCHEMA.optional().describe("Owner de la página (default: vos)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ slug, body, parentId, exact, prefix, suffix, user }) => {
    try {
      const u = await resolveUser(user);
      const anchor = exact
        ? { exact, ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) }
        : undefined;
      return ok(
        await client.req(`/api/u/${encodeURIComponent(u)}/${encodeSlugPath(slug)}/comments`, {
          method: "POST",
          body: { kind: "comment", body, ...(parentId ? { parentId } : {}), ...(anchor ? { anchor } : {}) },
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_create_suggestion",
  {
    title: "Outbox: proponer un cambio (sugerencia)",
    description:
      "Propone un cambio de texto sobre una página publicada SIN editarla: una sugerencia anclada " +
      "(anchor.exact = texto exacto y visible del HTML) + replacement (texto nuevo). El owner la acepta en el " +
      "widget y recién ahí se aplica como versión nueva atribuida. Si NO sos el owner necesitás un grant 'comment' " +
      "(o un ?share token). Flujo: 1) leé el contenido (outbox_read / outbox_export), 2) elegí el texto EXACTO a " +
      "reemplazar, 3) sugerí. Si ese texto aparece varias veces, pasá prefix/suffix para desambiguar.",
    inputSchema: {
      slug: SLUG_SCHEMA.describe("Slug/path de la página"),
      exact: z
        .string()
        .min(1)
        .max(2000)
        .describe(
          "Texto EXACTO y visible del documento a reemplazar; debe aparecer literal en el HTML servido. MAX 2000",
        ),
      replacement: z
        .string()
        .max(8000)
        .describe("Texto nuevo; se inserta HTML-escapado (no podés meter markup). MAX 8000"),
      prefix: z
        .string()
        .max(500)
        .optional()
        .describe("Contexto inmediatamente ANTES de `exact` (desambigua si `exact` se repite)"),
      suffix: z.string().max(500).optional().describe("Contexto inmediatamente DESPUÉS de `exact`"),
      body: z.string().max(4000).optional().describe("Nota: por qué proponés el cambio"),
      user: USER_SCHEMA.optional().describe("Owner de la página (default: vos)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ slug, exact, replacement, prefix, suffix, body, user }) => {
    try {
      const u = await resolveUser(user);
      const anchor = { exact, ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) };
      return ok(
        await client.req(`/api/u/${encodeURIComponent(u)}/${encodeSlugPath(slug)}/comments`, {
          method: "POST",
          body: { kind: "suggestion", body, replacement, anchor },
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_accept_suggestion",
  {
    title: "Outbox: aceptar una sugerencia (owner)",
    description:
      "Acepta una sugerencia: aplica el reemplazo y publica una versión nueva atribuida (quién propuso + quién " +
      "aceptó). Respuesta { ok, comment, version, noChange }. El ancla matchea por TEXTO VISIBLE (tag-aware): el back " +
      "compara el texto del anchor contra el contenido visible del HTML aunque haya tags/entidades en el medio. " +
      "NO-OP GUARD: si el reemplazo NO cambia el HTML resultante, devuelve { ok, comment, version, noChange: true } " +
      "y NO crea una versión nueva (la marca como aceptada igual). OWNER-ONLY: si no sos el owner de la página → 403. " +
      "NO es destructivo (la versión anterior queda en el historial; revertí con outbox_rollback). Errores: " +
      "409 anchor_not_found (el texto ancla ya no está/cambió, descartá la sugerencia), 409 comment_not_open, " +
      "400 not_a_suggestion.",
    inputSchema: {
      slug: SLUG_SCHEMA.describe("Slug/path de la página"),
      commentId: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-f0-9]+$/, "ID hex (de outbox_read_comments)")
        .describe("ID de la sugerencia (comment.id)"),
      user: USER_SCHEMA.optional().describe("Owner (default: vos). Aceptar es owner-only."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ slug, commentId, user }) => {
    try {
      const u = await resolveUser(user);
      return ok(
        await client.req(
          `/api/u/${encodeURIComponent(u)}/${encodeSlugPath(slug)}/comments/${encodeURIComponent(commentId)}/accept`,
          { method: "POST" },
        ),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_discard_suggestion",
  {
    title: "Outbox: descartar una sugerencia o comentario (owner)",
    description:
      "Descarta una sugerencia o comentario (lo marca discarded; NO toca el HTML). OWNER-ONLY → 403 si no sos el " +
      "owner. Útil para limpiar sugerencias obsoletas (ej. tras un 409 anchor_not_found al intentar aceptarlas).",
    inputSchema: {
      slug: SLUG_SCHEMA.describe("Slug/path de la página"),
      commentId: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-f0-9]+$/, "ID hex (de outbox_read_comments)")
        .describe("ID del comentario/sugerencia"),
      user: USER_SCHEMA.optional().describe("Owner (default: vos). Owner-only."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ slug, commentId, user }) => {
    try {
      const u = await resolveUser(user);
      return ok(
        await client.req(
          `/api/u/${encodeURIComponent(u)}/${encodeSlugPath(slug)}/comments/${encodeURIComponent(commentId)}/discard`,
          { method: "POST" },
        ),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_rollback",
  {
    title: "Outbox: revertir a una versión",
    description:
      "Restaura una página a una versión anterior (cambia la versión actual). El parámetro `to` va en el BODY como número. " +
      "Nota: el rollback NO crea una versión nueva, sobrescribe la actual.",
    inputSchema: {
      slug: SLUG_SCHEMA.describe("Slug de la página"),
      to: z.number().int().min(1).describe("Número de versión a restaurar"),
      user: USER_SCHEMA.optional().describe("Owner (default: vos)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ slug, to, user }) => {
    try {
      const u = await resolveUser(user);
      return ok(
        await client.req(`/api/u/${encodeURIComponent(u)}/${encodeSlugPath(slug)}/rollback`, {
          method: "POST",
          body: { to },
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_squash",
  {
    title: "Outbox: compactar el historial de versiones",
    description:
      "Compacta (squash) el historial de versiones de una página en una sola versión consolidada " +
      "(POST /api/u/:user/:slug/squash). El contenido ACTUAL se conserva; lo que se elimina es el historial " +
      "intermedio. Con `keepOriginal=true` se preserva además la primera versión (v1) como punto de anclaje; " +
      "por default (false) el historial queda compactado en una sola entrada. DESTRUCTIVO e irreversible: las " +
      "versiones intermedias se pierden y ya no podrás hacer `outbox_rollback` a ellas — pedí confirmación al " +
      "usuario antes de usarla. Útil para limpiar dailies con cientos de bloques o páginas con mucho versionado.",
    inputSchema: {
      slug: SLUG_SCHEMA.describe("Slug/path de la página a compactar"),
      keepOriginal: z
        .boolean()
        .optional()
        .describe("true = preserva la primera versión (v1) además de la actual; default false = compacta todo el historial"),
      user: USER_SCHEMA.optional().describe("Owner (default: vos)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ slug, keepOriginal, user }) => {
    try {
      const u = await resolveUser(user);
      return ok(
        await client.req(`/api/u/${encodeURIComponent(u)}/${encodeSlugPath(slug)}/squash`, {
          method: "POST",
          body: { keepOriginal },
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_set_visibility",
  {
    title: "Outbox: cambiar visibility de una página",
    description:
      "Cambia la visibility de una página: private (solo vos) / unlisted (con link) / public (indexable). No es destructivo.",
    inputSchema: {
      slug: SLUG_SCHEMA.describe("Slug de la página"),
      visibility: VISIBILITY.describe("Nueva visibility"),
      user: USER_SCHEMA.optional().describe("Owner (default: vos)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ slug, visibility, user }) => {
    try {
      const u = await resolveUser(user);
      return ok(
        await client.req(`/api/u/${encodeURIComponent(u)}/${encodeSlugPath(slug)}/visibility`, {
          method: "PUT",
          body: { visibility },
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_delete",
  {
    title: "Outbox: eliminar una página",
    description:
      "Elimina una página de tu biblioteca. DESTRUCTIVO e irreversible — pedí confirmación al usuario antes de usarla.",
    inputSchema: {
      slug: SLUG_SCHEMA.describe("Slug de la página a eliminar"),
      user: USER_SCHEMA.optional().describe("Owner (default: vos)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ slug, user }) => {
    try {
      const u = await resolveUser(user);
      return ok(
        await client.req(`/api/u/${encodeURIComponent(u)}/${encodeSlugPath(slug)}`, {
          method: "DELETE",
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_create_share",
  {
    title: "Outbox: crear share link",
    description:
      "Crea un link público anónimo (share token) para una página o carpeta, con expiración opcional. " +
      "`resource` = slug de la página o path de la carpeta. No es destructivo.",
    inputSchema: {
      resource: SLUG_SCHEMA.describe("Slug/path del recurso a compartir"),
      resourceType: z.enum(["post", "folder"]).default("post").describe("Tipo de recurso"),
      expiresInDays: z.number().int().min(1).max(365).nullable().optional().describe("Días hasta expirar (null = sin expiración)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ resource, resourceType, expiresInDays }) => {
    try {
      return ok(
        await client.req("/api/share", {
          method: "POST",
          body: { resource, resourceType, expiresInDays },
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Tools: publicación (HTML crudo / template) ──────────────────────────────────
// B8 (BREAKING): `model` es OBLIGATORIO en ambos publishes — el back devuelve
// 400 missing_model si falta. Es el id del modelo que generó el contenido
// (atribución/auditoría). Ej: "claude-opus-4-8", "gpt-4o".
const MODEL = z
  .string()
  .min(1)
  .max(64)
  .describe("OBLIGATORIO (B8): id del modelo que generó el contenido (ej. 'claude-opus-4-8')");

server.registerTool(
  "outbox_publish",
  {
    title: "Outbox: publicar HTML o Markdown",
    description:
      "Publica una página con `html` crudo O `markdown` (POST /publish). Crea o sobrescribe el `slug` (versionado automático: cada publish es una versión nueva). " +
      "Mandá UNO de los dos: `html` (se sirve tal cual) o `markdown` (el back lo renderiza a HTML seguro y lo envuelve en tu template/marca; guarda el .md fuente para round-trip). Mandar ambos → 400 conflicting_content; ninguno → 400 missing_content. " +
      "`model` es OBLIGATORIO (atribución del modelo, B8). `visibility` default `private`. No es destructivo (no borra; versiona).\n\n" +
      "Args clave: slug, model (req) + html O markdown. Opcionales: title, visibility, tags, summary, description, contentType, ttl, inheritFolderVisibility.",
    inputSchema: {
      slug: SLUG_SCHEMA.describe("Slug/path de la página. Acepta paths jerárquicos estilo Confluence (ej. 'briefings/hoy', 'clientes/solera/q3')"),
      owner: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe(
          "Teams F1: handle de un ORG del que sos MIEMBRO → publica bajo el namespace del equipo (publish-as-team). " +
            "Omitir = publica bajo tu namespace propio. Para company keys (key del org) NO hace falta: ya publican bajo el org.",
        ),
      html: z.string().min(1).optional().describe("HTML crudo de la página (se sirve tal cual; máx 5MB). Excluyente con `markdown`."),
      markdown: z.string().min(1).optional().describe("Fuente Markdown (camino agents-first): el back la renderiza a HTML seguro (escape + allowlist, sin raw-HTML ejecutable) y la envuelve en tu template o el shell de marca. Guarda el .md fuente. Excluyente con `html`."),
      model: MODEL,
      title: z.string().max(200).optional().describe("Título de la página"),
      visibility: VISIBILITY.optional().describe("private (default) / unlisted / public"),
      tags: z.array(z.string().min(1).max(64)).max(50).optional().describe("Tags"),
      summary: z.string().max(280).optional().describe("Resumen breve estilo tweet (si falta, el back lo deriva del title sin IA)"),
      description: z.string().max(2000).optional().describe("Descripción larga"),
      contentType: z.string().max(40).optional().describe("Tipo de contenido libre: briefing | report | notes | post | mockup | ..."),
      ttl: z.string().max(16).optional().describe("TTL de visibility (ej. '24h', '7d', '2w'); degrada a private al vencer. Solo aplica a no-private"),
      inheritFolderVisibility: z.boolean().optional().describe("true = hereda la visibility del folder ancestro más cercano"),
      notifySlack: z.string().max(512).optional().describe("Canal de Slack a notificar la publicación, ej. '#joni' (NO una URL; el webhook real vive en tu config server-side)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (args) => {
    try {
      return ok(await client.req("/publish", { method: "POST", body: args }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_publish_from_template",
  {
    title: "Outbox: publicar desde template",
    description:
      "Publica renderizando server-side a partir de un template + data JSON estructurada (POST /api/publish-from-template). " +
      "Ideal para agentes que NO generan HTML (Custom GPTs, Zapier, n8n). `template` es el id del template del catálogo; `data` es el objeto con los campos requeridos. " +
      "`model` es OBLIGATORIO (B8). `slug` requerido. No es destructivo.",
    inputSchema: {
      template: z.string().min(1).max(64).describe("Id del template del catálogo (GET /api/templates)"),
      data: z.record(z.unknown()).describe("Data estructurada que rellena el template (máx 64KB serializado)"),
      slug: SLUG_SCHEMA.describe("Slug/path de la página. Acepta paths jerárquicos estilo Confluence (ej. 'reportes/2026/q3')"),
      model: MODEL,
      title: z.string().max(200).optional().describe("Título de la página"),
      visibility: VISIBILITY.optional().describe("private (default) / unlisted / public"),
      tags: z.array(z.string().min(1).max(64)).max(50).optional().describe("Tags"),
      summary: z.string().max(280).optional().describe("Resumen breve (si falta, derivado del title sin IA)"),
      ttl: z.string().max(16).optional().describe("TTL de visibility (ej. '24h', '7d'); solo no-private"),
      inheritFolderVisibility: z.boolean().optional().describe("true = hereda visibility del folder ancestro"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (args) => {
    try {
      return ok(await client.req("/api/publish-from-template", { method: "POST", body: args }));
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Tools: delegación / keys de agente ──────────────────────────────────────────
server.registerTool(
  "outbox_gen_agent_key",
  {
    title: "Outbox: emitir agent key (delegación)",
    description:
      "Emite una API key de tipo agent para delegar publicación a otro agente (POST /api/keys/agent). " +
      "Con `folder` la key queda acotada a esa carpeta (blast radius reducido). El secreto (`plaintext`) se devuelve UNA SOLA VEZ — guardalo al instante. " +
      "Write SENSIBLE: confirmá con el usuario antes de emitir. Requiere scope `genkey`.\n\n" +
      "Args: label (req), verbs (subset de publish|list|delete|folder|share|template|upload, default ['publish']), folder?, days? (default 30, 0 = no expira).",
    inputSchema: {
      label: z.string().min(1).max(60).describe("Etiqueta de la key (1-60 chars, [a-zA-Z0-9_-:. ])"),
      verbs: z
        .array(z.enum(["publish", "list", "delete", "folder", "share", "template", "upload"]))
        .min(1)
        .optional()
        .describe("Verbos permitidos (default ['publish']). NUNCA genkey/admin (no se puede escalar)"),
      folder: PREFIX_SCHEMA.optional().describe("Folder al que se acota la key (ej. 'clientes/solera'). Sin folder = todo el namespace"),
      days: z.number().int().min(0).max(365).optional().describe("Días hasta expirar (default 30; 0 = no expira, con warning)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ label, verbs, folder, days }) => {
    try {
      return ok(await client.req("/api/keys/agent", { method: "POST", body: { label, verbs, folder, days } }));
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Tools: grants user-to-user ──────────────────────────────────────────────────
server.registerTool(
  "outbox_create_grant",
  {
    title: "Outbox: dar acceso a otro usuario (grant)",
    description:
      "Le da acceso de lectura a otro usuario de Outbox sobre un post o folder tuyo (POST /api/grants). " +
      "El recipient lo ve en su biblioteca como 'compartido conmigo'. v1 solo soporta permiso `view`. No es destructivo.",
    inputSchema: {
      recipientUser: USER_SCHEMA.describe("Username del destinatario (debe existir)"),
      resource: SLUG_SCHEMA.describe("Slug del post o path del folder a compartir"),
      resourceType: z.enum(["post", "folder"]).default("post").describe("Tipo de recurso"),
      expiresInDays: z.number().int().min(1).max(365).nullable().optional().describe("Días hasta expirar (default 30; null = sin expiración)"),
      message: z.string().max(500).optional().describe("Mensaje para el destinatario (opcional)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ recipientUser, resource, resourceType, expiresInDays, message }) => {
    try {
      return ok(
        await client.req("/api/grants", {
          method: "POST",
          body: { recipientUser, resource, resourceType, permissions: ["view"], expiresInDays, message },
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_list_grants",
  {
    title: "Outbox: listar grants",
    description:
      "Lista los grants user-to-user (GET /api/grants). Por default los que VOS diste (como owner). Con `incoming=true`, los que te dieron a VOS (recipient). Read-only.",
    inputSchema: {
      incoming: z.boolean().default(false).describe("true = grants RECIBIDOS (yo como recipient); false = grants que YO di"),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ incoming }) => {
    try {
      return ok(await client.req("/api/grants", { query: { incoming: incoming ? 1 : undefined } }));
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Tools: teams / orgs (Teams F1) ──────────────────────────────────────────────
// Una empresa es un UserRecord{type:'org', ownerUser}. 3 actores comparten el org:
//   humano  → miembro vía grant de membership (outbox_add_team_member)
//   agente  → company key folder-scoped (outbox_gen_team_key, key.user = handle)
//   cliente → share link (outbox_create_share, ya existe)
// Publicar como equipo: humanos pasan `owner` en outbox_publish; las company keys
// publican bajo el org automáticamente (sin owner).
// Misma regla canónica que un username ([a-z0-9-]{2,32}, ver schemas.ts): el
// charset sin '.' bloquea dot-segments que reescribirían /api/teams/:handle/...
const TEAM_HANDLE = TEAM_HANDLE_SCHEMA.describe(
  "Handle del org/equipo (namespace, ej. 'procontacto')",
);

server.registerTool(
  "outbox_create_team",
  {
    title: "Outbox: crear un equipo (org)",
    description:
      "Crea un equipo/empresa (UserRecord type 'org') bajo un `handle` propio (POST /api/teams). " +
      "Quedás como owner del org. El handle es el namespace público del equipo: las páginas publicadas como equipo " +
      "viven bajo out-box.dev/<handle>/<slug>. Tras crearlo podés sumar miembros (outbox_add_team_member) y " +
      "emitir company keys (outbox_gen_team_key). Respuesta { handle, name, ownerUser, createdAt }. No es destructivo.",
    inputSchema: {
      handle: TEAM_HANDLE,
      name: z.string().min(1).max(120).optional().describe("Nombre legible del equipo (opcional)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ handle, name }) => {
    try {
      return ok(await client.req("/api/teams", { method: "POST", body: { handle, name } }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_list_teams",
  {
    title: "Outbox: listar mis equipos",
    description:
      "Lista los equipos/orgs de los que sos miembro (GET /api/teams). " +
      "Cada item trae { handle, name, role, addedAt } — `role` indica si sos owner o member. " +
      "Usalo para descubrir bajo qué namespaces podés publicar como equipo (pasando ese handle como `owner` en outbox_publish). Read-only.",
    inputSchema: {},
    annotations: { ...RO, idempotentHint: true },
  },
  async () => {
    try {
      return ok(await client.req("/api/teams"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_list_team_members",
  {
    title: "Outbox: listar miembros de un equipo",
    description:
      "Lista los miembros de un equipo/org (GET /api/teams/:handle/members). " +
      "Cada item trae { user, role, addedAt, addedBy, canManageKeys? } — `canManageKeys:true` indica que ese miembro puede emitir/revocar company keys del org. Útil para auditar quién tiene acceso al namespace del equipo. Read-only.",
    inputSchema: { handle: TEAM_HANDLE },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ handle }) => {
    try {
      return ok(await client.req(`/api/teams/${encodeURIComponent(handle)}/members`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_add_team_member",
  {
    title: "Outbox: sumar un miembro al equipo (owner)",
    description:
      "Suma un usuario humano de Outbox como miembro de tu equipo/org (POST /api/teams/:handle/members). " +
      "El miembro puede publicar bajo el namespace del equipo (pasando el handle como `owner` en outbox_publish). " +
      "OWNER-ONLY: solo el owner del org puede sumar miembros. El nuevo miembro entra siempre con rol " +
      "'member' (el ownership se transfiere aparte, no se asigna al sumar). " +
      "Respuesta { ok, user, role }. No es destructivo.",
    inputSchema: {
      handle: TEAM_HANDLE,
      user: USER_SCHEMA.describe("Username del humano a sumar (debe existir)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ handle, user }) => {
    try {
      return ok(
        await client.req(`/api/teams/${encodeURIComponent(handle)}/members`, {
          method: "POST",
          body: { user },
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_remove_team_member",
  {
    title: "Outbox: quitar un miembro del equipo (owner)",
    description:
      "Quita un miembro de tu equipo/org (DELETE /api/teams/:handle/members/:user). " +
      "Pierde el acceso a publicar bajo el namespace del equipo. OWNER-ONLY → 403 si no sos el owner del org. " +
      "Respuesta { ok, removed }. DESTRUCTIVO sobre la membresía (no borra contenido) — confirmá con el usuario.",
    inputSchema: {
      handle: TEAM_HANDLE,
      user: USER_SCHEMA.describe("Username del miembro a quitar"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ handle, user }) => {
    try {
      return ok(
        await client.req(
          `/api/teams/${encodeURIComponent(handle)}/members/${encodeURIComponent(user)}`,
          { method: "DELETE" },
        ),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_gen_team_key",
  {
    title: "Outbox: emitir company key del equipo (owner)",
    description:
      "Emite una company key del equipo/org para delegar publicación a un AGENTE bajo el namespace del equipo " +
      "(POST /api/teams/:handle/keys). A diferencia de outbox_gen_agent_key (que emite bajo TU namespace), esta key " +
      "tiene user = handle del org: el agente que la use publica bajo out-box.dev/<handle>/ AUTOMÁTICAMENTE, sin pasar " +
      "`owner`. Con `folder` se acota a una carpeta (blast radius reducido). El secreto (`plaintext`) se devuelve UNA " +
      "SOLA VEZ — guardalo al instante. OWNER-ONLY. Write SENSIBLE: confirmá con el usuario antes de emitir.",
    inputSchema: {
      handle: TEAM_HANDLE,
      label: z.string().min(1).max(60).describe("Etiqueta de la key (1-60 chars, [a-zA-Z0-9_-:. ])"),
      // Prefix de carpeta como los demás (anti-traversal). Viaja SOLO en el body
      // JSON del POST (nunca se concatena a la URL), así que el schema alcanza.
      folder: PREFIX_SCHEMA.optional().describe(
        "Folder al que se acota la key (ej. 'clientes/solera'). Sin folder = todo el namespace del org",
      ),
      days: z
        .number()
        .int()
        .min(0)
        .max(365)
        .optional()
        .describe("Días hasta expirar (default del back; 0 = no expira)"),
      verbs: z
        .array(z.enum(["publish", "list", "delete", "folder", "share", "template", "upload"]))
        .min(1)
        .optional()
        .describe("Verbos permitidos (default del back, típicamente ['publish']). NUNCA genkey/admin"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ handle, label, folder, days, verbs }) => {
    try {
      return ok(
        await client.req(`/api/teams/${encodeURIComponent(handle)}/keys`, {
          method: "POST",
          body: { label, folder, days, verbs },
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_list_team_keys",
  {
    title: "Outbox: listar company keys del equipo",
    description:
      "Lista las company keys del equipo/org (GET /api/teams/:handle/keys), SIN exponer el secreto. " +
      "Cada item trae { id, label, folder, verbs, createdAt, expiresAt, revoked }. Útil para auditar qué agentes tienen acceso al namespace del equipo. " +
      "Membership-gated: owner o miembro con canManageKeys. Read-only.",
    inputSchema: { handle: TEAM_HANDLE },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ handle }) => {
    try {
      return ok(await client.req(`/api/teams/${encodeURIComponent(handle)}/keys`));
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Tools: event webhooks ───────────────────────────────────────────────────────
server.registerTool(
  "outbox_create_webhook",
  {
    title: "Outbox: crear event webhook",
    description:
      "Registra un endpoint HTTPS que Outbox dispara con un POST firmado cuando ocurre un evento en tu biblioteca (POST /api/webhooks). " +
      "Eventos: comment.created, version.created, page.published. Entrega async (<= 1 min), firmada con HMAC-SHA256 en el header X-Outbox-Signature (sha256=<hex>). " +
      "El secret de firma se devuelve UNA sola vez. La URL debe ser HTTPS y no privada/interna. No es destructivo.",
    inputSchema: {
      url: z.string().url().describe("URL HTTPS del endpoint (no privada/interna; se valida anti-SSRF)"),
      events: z
        .array(z.enum(["comment.created", "version.created", "page.published"]))
        .min(1)
        .describe("Eventos a suscribir"),
      slugPrefix: z.string().max(200).optional().describe("Solo dispara si el slug del evento empieza con este prefijo (opcional)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ url, events, slugPrefix }) => {
    try {
      return ok(await client.req("/api/webhooks", { method: "POST", body: { url, events, slugPrefix } }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_list_webhooks",
  {
    title: "Outbox: listar event webhooks",
    description: "Lista tus event webhooks (GET /api/webhooks), sin exponer el secret. Read-only.",
    inputSchema: {},
    annotations: { ...RO, idempotentHint: true },
  },
  async () => {
    try {
      return ok(await client.req("/api/webhooks"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_delete_webhook",
  {
    title: "Outbox: borrar event webhook",
    description: "Borra un event webhook por id (DELETE /api/webhooks/:id). Idempotente.",
    inputSchema: { id: z.string().min(1).describe("id del webhook a borrar") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ id }) => {
    try {
      return ok(await client.req(`/api/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_pause_webhook",
  {
    title: "Outbox: pausar/reanudar event webhook",
    description:
      "Pausa o reanuda un event webhook SIN borrarlo (POST /api/webhooks/:id, body { paused }). " +
      "Un webhook pausado (paused=true) NO se entrega hasta reanudarlo (paused=false); el drain del worker lo saltea. " +
      "Útil para silenciar un endpoint temporalmente (mantenimiento, ruido) sin perder su config/secret. Devuelve el webhook actualizado. Idempotente.",
    inputSchema: {
      id: z.string().min(1).describe("id del webhook a pausar/reanudar (de outbox_list_webhooks)"),
      paused: z.boolean().describe("true = pausar (deja de entregar); false = reanudar"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, paused }) => {
    try {
      return ok(await client.req(`/api/webhooks/${encodeURIComponent(id)}`, { method: "POST", body: { paused } }));
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Tools: folders ──────────────────────────────────────────────────────────────
server.registerTool(
  "outbox_folders",
  {
    title: "Outbox: listar carpetas",
    description:
      "Lista todas las carpetas de tu biblioteca con count + visibility (GET /api/folders). " +
      "`depth` opcional (1-3) devuelve el árbol anidado. Incluye folders implícitos (de slugs), explícitos (_folder.json) y declarados por keys. Read-only.",
    inputSchema: {
      depth: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe("Profundidad del árbol (1 = flat, default). 2-3 = anidado"),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ depth }) => {
    try {
      return ok(await client.req("/api/folders", { query: { depth } }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_set_folder",
  {
    title: "Outbox: setear visibility de una carpeta",
    description:
      "Crea o actualiza la metadata de una carpeta — principalmente su visibility default (PUT /api/folders/:prefix, NO PATCH). " +
      "NO afecta retroactivamente lo ya publicado; solo lo que se publique después con inheritFolderVisibility hereda. No es destructivo.",
    inputSchema: {
      prefix: PREFIX_SCHEMA.describe("Path de la carpeta (ej. 'clientes/solera')"),
      visibility: VISIBILITY.describe("Visibility default de la carpeta"),
      title: z.string().max(200).optional().describe("Título de la carpeta (opcional)"),
      description: z.string().max(2000).optional().describe("Descripción de la carpeta (opcional)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ prefix, visibility, title, description }) => {
    try {
      return ok(
        // encodeSlugPath (NO encodeURIComponent del prefix entero): el back splitea
        // el pathname crudo — `clientes%2Fsolera` cae como UN segmento → 400 invalid_prefix.
        await client.req(`/api/folders/${encodeSlugPath(prefix)}`, {
          method: "PUT",
          body: { visibility, title, description },
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Tools: export / descubrimiento / estilo ─────────────────────────────────────
server.registerTool(
  "outbox_export",
  {
    title: "Outbox: exportar un post (machine-readable)",
    description:
      "Exporta el contenido + metadata de un post (B9, GET /api/u/:user/:slug/export). " +
      "`format=json` (default) devuelve { model, summary, contenido, title, tags, visibility, version, ... } — ideal para que un agente lea el post y su contexto. " +
      "`format=html` devuelve el HTML crudo persistido. Solo exportás lo TUYO (cross-user = 403). Read-only.",
    inputSchema: {
      slug: SLUG_SCHEMA.describe("Slug del post a exportar"),
      format: z.enum(["json", "html"]).default("json").describe("json (default, estructurado) o html (crudo)"),
      user: USER_SCHEMA.optional().describe("Owner (default: vos). Debe ser vos — cross-user da 403"),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ slug, format, user }) => {
    try {
      const u = await resolveUser(user);
      const exported = await client.req(
        `/api/u/${encodeURIComponent(u)}/${encodeSlugPath(slug)}/export`,
        { query: { format } },
      );
      // format=html devuelve el HTML crudo persistido: contenido autoritativo que
      // NO debe truncarse (round-trip → re-publish). El JSON estructurado se
      // mantiene con el cap de contexto habitual. (BUGS-VALIDACION #7.)
      return format === "html" ? raw(exported) : ok(exported);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_capabilities",
  {
    title: "Outbox: capacidades del back",
    description:
      "Describe qué soporta el back (B15, GET /api/capabilities): verbos, scopes, límites por tier, constraints de content-meta/upload/ttl, brand presets y features activas. " +
      "Endpoint PÚBLICO (no requiere auth válida). Úsalo para AUTO-DESCUBRIR capacidades antes de publicar (no hardcodees límites). Read-only.",
    inputSchema: {},
    annotations: { ...RO, idempotentHint: true },
  },
  async () => {
    try {
      return ok(await client.req("/api/capabilities"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_set_style",
  {
    title: "Outbox: cambiar brand preset",
    description:
      "Cambia tu brand preset preferido (stylePreference) sin re-aplicar el template HTML (B3, PUT /api/me/style). " +
      "Uno de los 6 IDs del catálogo: paper, minimal, corporate, dark, brutalist, editorial. Requiere scope `template`. No es destructivo.",
    inputSchema: {
      stylePreference: z
        .enum(["paper", "minimal", "corporate", "dark", "brutalist", "editorial"])
        .describe("Brand preset: uno de los 6 IDs del catálogo"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ stylePreference }) => {
    try {
      return ok(await client.req("/api/me/style", { method: "PUT", body: { stylePreference } }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_recent",
  {
    title: "Outbox: actividad reciente",
    description:
      "Devuelve los cambios recientes de tu biblioteca (GET /api/u/:user/recent): el primitivo de 'qué cambió'. " +
      "Filtros opcionales: `since` (ISO-8601 o epoch ms, según contrato del back), `prefix` (acota a una carpeta, " +
      "ej. 'clientes/solera') y `slug` (una página puntual). Ideal para que un agente detecte qué se modificó desde la " +
      "última vez antes de re-leer o re-publicar. Read-only.",
    inputSchema: {
      since: z
        .string()
        .min(1)
        .max(40)
        .optional()
        .describe("Cota inferior temporal (ISO-8601, ej. '2026-06-01T00:00:00Z', o epoch ms). Solo cambios posteriores"),
      prefix: PREFIX_SCHEMA.optional().describe("Acota a una carpeta (ej. 'clientes/solera')"),
      slug: SLUG_SCHEMA.optional().describe("Acota a una página puntual (slug/path)"),
      user: USER_SCHEMA.optional().describe("Owner (default: vos)"),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ since, prefix, slug, user }) => {
    try {
      const u = await resolveUser(user);
      return ok(
        await client.req(`/api/u/${encodeURIComponent(u)}/recent`, {
          query: { since, prefix, slug },
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_search",
  {
    title: "Outbox: buscar en mi biblioteca",
    description:
      "Búsqueda full-text / retrieval sobre tu propia biblioteca (GET /api/u/:user/search?q=). " +
      "Devuelve las páginas que matchean `q` (título, contenido, tags según el back). " +
      "Es más potente que `outbox_list` (que solo filtra por tag): usá esto cuando el agente necesita ENCONTRAR contenido " +
      "por texto antes de leer/actualizar. Read-only.",
    inputSchema: {
      q: FREE_TEXT_SCHEMA.describe("Texto a buscar (full-text sobre tu biblioteca)"),
      limit: z.number().int().min(1).max(200).default(20).describe("Máximo de resultados"),
      prefix: PREFIX_SCHEMA.optional().describe("Acota la búsqueda a una carpeta (ej. 'clientes/solera')"),
      user: USER_SCHEMA.optional().describe("Owner (default: vos)"),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ q, limit, prefix, user }) => {
    try {
      const u = await resolveUser(user);
      return ok(
        await client.req(`/api/u/${encodeURIComponent(u)}/search`, {
          query: { q, limit, prefix },
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_diff",
  {
    title: "Outbox: diff entre versiones",
    description:
      "Devuelve el diff de una página entre dos versiones (GET /api/u/:user/:slug/diff?from=&to=). " +
      "`from`/`to` son números de versión (de `outbox_versions`). Útil para que el agente entienda QUÉ cambió entre " +
      "dos puntos del historial antes de actuar (revisar, revertir, comentar). Read-only.",
    inputSchema: {
      slug: SLUG_SCHEMA.describe("Slug/path de la página"),
      from: z.number().int().min(1).describe("Versión base (la más vieja)"),
      to: z.number().int().min(1).describe("Versión destino (la más nueva)"),
      user: USER_SCHEMA.optional().describe("Owner (default: vos)"),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ slug, from, to, user }) => {
    try {
      const u = await resolveUser(user);
      return ok(
        await client.req(`/api/u/${encodeURIComponent(u)}/${encodeSlugPath(slug)}/diff`, {
          query: { from, to },
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_access",
  {
    title: "Outbox: quién tiene acceso a una página",
    description:
      "Devuelve quién puede acceder a una página y cómo (GET /api/u/:user/:slug/access): visibility efectiva, " +
      "grants user-to-user, share tokens y keys con scope sobre ese recurso. Útil para auditar el blast radius de un post " +
      "antes de cambiar su visibility o compartirlo. Read-only.",
    inputSchema: {
      slug: SLUG_SCHEMA.describe("Slug/path de la página"),
      user: USER_SCHEMA.optional().describe("Owner (default: vos)"),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ slug, user }) => {
    try {
      const u = await resolveUser(user);
      return ok(
        await client.req(`/api/u/${encodeURIComponent(u)}/${encodeSlugPath(slug)}/access`),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_audit",
  {
    title: "Outbox: log de auditoría",
    description:
      "Devuelve el log de auditoría de tu cuenta (GET /api/audit): publishes, deletes, rollbacks, emisión de keys, " +
      "grants, etc. — quién hizo qué y cuándo. Filtros opcionales: `limit` y `since`. Ideal para revisar la actividad de " +
      "agentes delegados. Read-only.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(50).describe("Máximo de eventos"),
      since: z
        .string()
        .min(1)
        .max(40)
        .optional()
        .describe("Cota inferior temporal (ISO-8601 o epoch ms). Solo eventos posteriores"),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ limit, since }) => {
    try {
      return ok(await client.req("/api/audit", { query: { limit, since } }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_templates",
  {
    title: "Outbox: catálogo de templates",
    description:
      "Lista los content-templates disponibles con sus schemas (GET /api/templates). " +
      "Cada template trae su `id`, los campos requeridos/opcionales y el shape del `data` esperado. " +
      "Usalo para AUTO-DESCUBRIR qué templates podés pasarle a `outbox_publish_from_template` y con qué estructura de " +
      "`data` — no hardcodees los campos. Read-only.",
    inputSchema: {},
    annotations: { ...RO, idempotentHint: true },
  },
  async () => {
    try {
      return ok(await client.req("/api/templates"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_agents_registry",
  {
    title: "Outbox: registry de agentes",
    description:
      "Lista los agentes disponibles en el registry de Outbox (GET /api/agents/registry): plantillas de agente " +
      "instanciables (id, nombre, descripción, capabilities, scopes/verbs que requieren). Es el paso de descubrimiento " +
      "antes de `outbox_instantiate_agent`. Estratégico: deja que un agente vea qué otros agentes puede levantar. Read-only.",
    inputSchema: {},
    annotations: { ...RO, idempotentHint: true },
  },
  async () => {
    try {
      return ok(await client.req("/api/agents/registry"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_instantiate_agent",
  {
    title: "Outbox: instanciar un agente del registry",
    description:
      "Instancia un agente del registry (POST /api/agents/instantiate) a partir de su `agentId` (de `outbox_agents_registry`). " +
      "Crea la instancia con su agent key folder-scoped y la config asociada. Write SENSIBLE: puede emitir credenciales y " +
      "acotar acceso a una carpeta — confirmá con el usuario antes de instanciar. La respuesta puede traer un secreto UNA " +
      "SOLA VEZ (guardalo al instante).",
    inputSchema: {
      fromUser: z
        .string()
        .min(1)
        .max(64)
        .describe("Username DUEÑO del registry de donde se clona el agente (el back lo exige)"),
      agentId: z.string().min(1).max(64).describe("Id del agente del registry (de outbox_agents_registry)"),
      inputs: z
        .record(z.unknown())
        .optional()
        .describe("Config/inputs estructurados de la instancia (campos que pida el agente del registry)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  // El back (POST /api/agents/instantiate) EXIGE { fromUser, agentId } y lee
  // `inputs`; ignora label/folder (la key clonada deriva sus scopes del agente
  // fuente). Mandar el shape viejo daba 400 invalid_fields siempre.
  async ({ fromUser, agentId, inputs }) => {
    try {
      return ok(
        await client.req("/api/agents/instantiate", {
          method: "POST",
          body: { fromUser, agentId, inputs },
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_upload",
  {
    title: "Outbox: subir una imagen (content-addressed)",
    description:
      "Sube una imagen (POST /api/uploads) y devuelve una URL content-addressed (hash del contenido) para referenciarla " +
      "desde el HTML de tus páginas. La imagen se pasa como `data` en base64 + el `contentType` (ej. 'image/png'). " +
      "Útil para que el agente incruste imágenes propias sin depender de hosts externos. Requiere scope `upload`. No es destructivo.",
    inputSchema: {
      data: z.string().min(1).describe("Bytes de la imagen en base64 (sin el prefijo data: URI)"),
      contentType: z
        .string()
        .min(1)
        .max(60)
        .regex(/^image\//, "Debe ser un MIME de imagen (image/png, image/jpeg, image/webp, image/gif, image/svg+xml)")
        .describe("MIME de la imagen (ej. 'image/png', 'image/jpeg', 'image/webp')"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ data, contentType }) => {
    try {
      // El back deriva todo del contenido (hash + magic bytes) y el path raw-body del
      // worker no acepta metadata extra: por eso NO hay `filename` en el schema — sería
      // un parámetro que el modelo puede mandar y que no viaja a ningún lado.
      // Ver uploadImageBytes.
      const bytes = new Uint8Array(Buffer.from(data, "base64"));
      return ok(await uploadImageBytes(bytes, contentType));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_delete_folder",
  {
    title: "Outbox: eliminar una carpeta",
    description:
      "Elimina la metadata de una carpeta (DELETE /api/folders/:prefix). DESTRUCTIVO — según el contrato del back puede " +
      "arrastrar las páginas que contiene; pedí confirmación al usuario antes de usarla. Complementa `outbox_folders` " +
      "(listar) y `outbox_set_folder` (crear/actualizar): cierra el CRUD de carpetas.",
    inputSchema: {
      prefix: PREFIX_SCHEMA.describe("Path de la carpeta a eliminar (ej. 'clientes/solera')"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ prefix }) => {
    try {
      return ok(
        // encodeSlugPath: mismo contrato que outbox_set_folder — el back no decodifica %2F.
        await client.req(`/api/folders/${encodeSlugPath(prefix)}`, { method: "DELETE" }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_export_library",
  {
    title: "Outbox: exportar TODA la biblioteca (backup)",
    description:
      "Exporta TODA tu biblioteca como JSON (list + export de cada post) para backup / portabilidad. " +
      "Hoy `outbox_export` solo exporta 1 post; esta tool lista todos (GET /api/list) y exporta cada uno " +
      "(GET /api/u/:user/:slug/export?format=json), devolviendo { user, count, exportedAt, posts: [...] }. " +
      "Filtros opcionales: `prefix` (solo una carpeta) y `limit` (tope de posts, protege contexto/quota). " +
      "Si un export individual falla, el post queda con { slug, error } y la exportación continúa (best-effort). Read-only.",
    inputSchema: {
      prefix: PREFIX_SCHEMA.optional().describe("Acota el backup a una carpeta (ej. 'clientes/solera')"),
      limit: z.number().int().min(1).max(500).default(100).describe("Tope de posts a exportar (protege contexto y quota)"),
      user: USER_SCHEMA.optional().describe("Owner (default: vos). Debe ser vos — cross-user da 403"),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ prefix, limit, user }) => {
    try {
      const u = await resolveUser(user);

      // Paginar /api/list con cursor hasta juntar `limit` slugs o agotar el bucket.
      // Antes se usaba solo `limit` sin cursor → con más posts que `limit` el backup
      // quedaba INCOMPLETO en silencio (trampa de pérdida de datos en una tool de
      // backup). El backend tope por página es 200, así que pedimos de a 200.
      const slugs: string[] = [];
      let cursor: string | undefined;
      let truncatedByLimit = false;
      do {
        const pageSize = Math.min(200, limit - slugs.length);
        const listed = await client.req<{
          posts?: { slug?: string }[];
          items?: { slug?: string }[];
          cursor?: string | null;
        }>("/api/list", { query: { limit: pageSize, prefix, cursor } });
        const rows = listed.posts ?? listed.items ?? [];
        for (const r of rows) {
          if (typeof r.slug === "string") slugs.push(r.slug);
          if (slugs.length >= limit) break;
        }
        cursor = listed.cursor ?? undefined;
        if (slugs.length >= limit && cursor) truncatedByLimit = true;
      } while (cursor && slugs.length < limit);

      // Exportar en paralelo con un pool acotado (no N+1 secuencial). Si la API
      // tira 429, ABORTAR el batch (seguir martilleando agrava el rate-limit).
      const posts: unknown[] = [];
      let rateLimited = false;
      const POOL = 5;
      for (let i = 0; i < slugs.length && !rateLimited; i += POOL) {
        const batch = slugs.slice(i, i + POOL);
        const results = await Promise.all(
          batch.map(async (slug) => {
            try {
              return await client.req<unknown>(
                `/api/u/${encodeURIComponent(u)}/${encodeSlugPath(slug)}/export`,
                { query: { format: "json" } },
              );
            } catch (err) {
              if (err instanceof OutboxApiError && err.status === 429) {
                rateLimited = true;
              }
              return { slug, error: formatError(err) };
            }
          }),
        );
        posts.push(...results);
      }

      // Backup: JSON autoritativo para portabilidad. NO truncar — un backup cortado
      // a la mitad queda inválido/inusable. (BUGS-VALIDACION #7.)
      return raw({
        user: u,
        ...(prefix ? { prefix } : {}),
        count: posts.length,
        requested: slugs.length,
        complete: !truncatedByLimit && !rateLimited && posts.length === slugs.length,
        exportedAt: new Date().toISOString(),
        ...(truncatedByLimit ? { truncated: true, note: `Backup truncated by limit=${limit}; raise limit or use prefix to cover the rest. / Backup truncado por limit=${limit}. Subí limit o usá prefix para cubrir el resto.` } : {}),
        ...(rateLimited
          ? {
              aborted: "rate_limited",
              exported: posts.length,
              note: `Rate-limited (429): the batch was aborted at ${posts.length}/${slugs.length} posts to avoid worsening the limit. This backup is INCOMPLETE — retry in a few minutes. / La API devolvió 429; el batch se abortó en ${posts.length}/${slugs.length} posts. El backup está INCOMPLETO, reintentá en unos minutos.`,
            }
          : {}),
        posts,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Tools: schedules (cron → webhook) ───────────────────────────────────────────
// Outbox NO hospeda IA ni corre la lógica del agente: un schedule simplemente
// dispara un POST a un webhook tuyo según un cron. El agente vive de tu lado.
server.registerTool(
  "outbox_create_schedule",
  {
    title: "Outbox: crear schedule (cron → webhook)",
    description:
      "Registra un disparador programado: en cada match del cron, Outbox hace un POST a tu webhook HTTPS (POST /api/schedules). " +
      "Outbox NO corre tu agente — solo dispara el webhook; la lógica vive de tu lado (ese endpoint despierta a tu agente). " +
      "El cron se evalúa en UTC, granularidad por minuto (ej. '0 9 * * *' = 09:00 UTC diario). La URL debe ser HTTPS y no privada/interna (anti-SSRF). " +
      "Requiere scope `template`. No es destructivo.",
    inputSchema: {
      label: z.string().min(1).max(120).describe("Etiqueta del schedule (para reconocerlo en la lista)"),
      cronExpression: z.string().min(1).max(120).describe("Expresión cron UTC de 5 campos (ej. '0 9 * * *' = 09:00 UTC diario)"),
      webhookUrl: z.string().url().describe("URL HTTPS a la que Outbox hará POST en cada disparo (no privada/interna)"),
      agentKeyId: z.string().min(1).max(120).optional().describe("keyId del agente a notificar (opcional; default: la key actual)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ label, cronExpression, webhookUrl, agentKeyId }) => {
    try {
      return ok(
        await client.req("/api/schedules", {
          method: "POST",
          body: { label, cronExpression, webhookUrl, agentKeyId },
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_list_schedules",
  {
    title: "Outbox: listar schedules",
    description: "Lista tus schedules (GET /api/schedules): label, cron, timezone (UTC) y el webhook destino. Read-only.",
    inputSchema: {},
    annotations: { ...RO, idempotentHint: true },
  },
  async () => {
    try {
      return ok(await client.req("/api/schedules"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_delete_schedule",
  {
    title: "Outbox: borrar schedule",
    description: "Borra un schedule por id (DELETE /api/schedules/:id). Deja de disparar el webhook. Idempotente.",
    inputSchema: { id: z.string().min(1).describe("id del schedule a borrar (de outbox_list_schedules)") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ id }) => {
    try {
      return ok(await client.req(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "outbox_pause_schedule",
  {
    title: "Outbox: pausar/reanudar schedule",
    description:
      "Pausa o reanuda un schedule SIN borrarlo (POST /api/schedules/:id, body { paused }). " +
      "Un schedule pausado (paused=true) NO dispara su webhook hasta reanudarlo (paused=false); el scheduled handler del worker lo saltea. " +
      "Útil para detener temporalmente un cron (pausar el agente unos días) sin perder su config. Devuelve el schedule actualizado. Idempotente.",
    inputSchema: {
      id: z.string().min(1).describe("id del schedule a pausar/reanudar (de outbox_list_schedules)"),
      paused: z.boolean().describe("true = pausar (deja de disparar); false = reanudar"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, paused }) => {
    try {
      return ok(await client.req(`/api/schedules/${encodeURIComponent(id)}`, { method: "POST", body: { paused } }));
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Tools: rotación de keys ─────────────────────────────────────────────────────
server.registerTool(
  "outbox_rotate_key",
  {
    title: "Outbox: rotar una API key",
    description:
      "Rota una API key: revoca la vieja y emite una nueva con los MISMOS scopes/label, en una sola operación atómica (POST /api/keys/rotate). " +
      "El secreto nuevo (`plaintext`) se devuelve UNA SOLA VEZ — guardalo al instante y actualizá los servicios que usaban la key vieja. " +
      "Sin `keyId` rota la key que estás usando ahora (no disponible con auth de sesión). Write SENSIBLE: confirmá con el usuario antes de rotar. Requiere scope `genkey`.",
    inputSchema: {
      keyId: z.string().min(1).max(120).optional().describe("keyId a rotar (de outbox_list_keys). Sin esto, rota la key actual"),
      label: z.string().min(1).max(60).optional().describe("Label para la NUEVA key (default: <user>-rotated-<short>)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ keyId, label }) => {
    try {
      return ok(await client.req("/api/keys/rotate", { method: "POST", body: { keyId, label } }));
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Arranque (stdio) ───────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} corriendo (auth: ${config.source}).`);
}

main().catch((err) => {
  console.error("Fallo al iniciar el Outbox MCP server:", err);
  process.exit(1);
});
