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

import { CHARACTER_LIMIT, SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { loadConfig } from "./config.js";
import { OutboxClient, formatError } from "./services/client.js";

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
    text = text.slice(0, CHARACTER_LIMIT) + "\n…(respuesta truncada — usá filtros o paginación)";
  }
  return { content: [{ type: "text", text }] };
}

function fail(e: unknown): ToolResult {
  return { isError: true, content: [{ type: "text", text: formatError(e) }] };
}

/**
 * Codifica un slug jerárquico (ej: `notes/2026`) segmento por segmento.
 * `encodeURIComponent` sobre el slug entero convierte `/` en `%2F` y el worker
 * lo rechaza (400 invalid_slug). Igual que el CLI: split → encode → join.
 */
function encodeSlugPath(slug: string): string {
  return slug.split("/").map(encodeURIComponent).join("/");
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
    throw new Error("No se pudo determinar el usuario. Pasá `user` explícitamente.");
  }
  return cachedUser;
}

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

// ── Tools: lectura ─────────────────────────────────────────────────────────────
server.registerTool(
  "outbox_me",
  {
    title: "Outbox: mi cuenta",
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
      "Devuelve el HTML servido (estado ACTUAL) de una página. Lee del sitio público (out-box.dev/<user>/<slug>, SIN /u/). " +
      "Para páginas privadas, la key debe ser del owner (si no, 404). " +
      "Solo lee la versión vigente: el back NO sirve versiones históricas por HTML. " +
      "Para una versión vieja usá `outbox_versions` (historial) + `outbox_rollback` (restaurar), o `outbox_export` para el estado actual machine-readable. Read-only.",
    inputSchema: {
      slug: z.string().min(1).max(200).describe("Slug/path de la página. Acepta paths jerárquicos estilo Confluence (ej. 'briefings/hoy', 'clientes/solera/q3')"),
      user: z.string().min(1).max(64).optional().describe("Owner (default: vos)"),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ slug, user }) => {
    try {
      const u = await resolveUser(user);
      const html = await client.readHtml(u, slug);
      return ok(html);
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
      slug: z.string().min(1).max(200).describe("Slug/path de la página"),
      user: z.string().min(1).max(64).optional().describe("Owner (default: vos)"),
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
      slug: z.string().min(1).max(200).describe("Slug del daily"),
      user: z.string().min(1).max(64).optional().describe("Owner (default: vos)"),
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
      slug: z.string().min(1).max(200).describe("Slug del daily (ej. 'daily/2026-05-29')"),
      html: z.string().min(1).describe("HTML del bloque a agregar"),
      user: z.string().min(1).max(64).optional().describe("Owner (default: vos)"),
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
      slug: z
        .string()
        .min(1)
        .max(200)
        .describe("Slug/path de la página (acepta paths jerárquicos, ej 'briefings/hoy')"),
      user: z.string().min(1).max(64).optional().describe("Owner (default: vos)"),
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
      slug: z.string().min(1).max(200).describe("Slug/path de la página"),
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
      user: z.string().min(1).max(64).optional().describe("Owner de la página (default: vos)"),
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
      slug: z.string().min(1).max(200).describe("Slug/path de la página"),
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
      user: z.string().min(1).max(64).optional().describe("Owner de la página (default: vos)"),
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
      slug: z.string().min(1).max(200).describe("Slug/path de la página"),
      commentId: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-f0-9]+$/, "ID hex (de outbox_read_comments)")
        .describe("ID de la sugerencia (comment.id)"),
      user: z.string().min(1).max(64).optional().describe("Owner (default: vos). Aceptar es owner-only."),
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
      slug: z.string().min(1).max(200).describe("Slug/path de la página"),
      commentId: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-f0-9]+$/, "ID hex (de outbox_read_comments)")
        .describe("ID del comentario/sugerencia"),
      user: z.string().min(1).max(64).optional().describe("Owner (default: vos). Owner-only."),
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
      slug: z.string().min(1).max(200).describe("Slug de la página"),
      to: z.number().int().min(1).describe("Número de versión a restaurar"),
      user: z.string().min(1).max(64).optional().describe("Owner (default: vos)"),
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
      slug: z.string().min(1).max(200).describe("Slug/path de la página a compactar"),
      keepOriginal: z
        .boolean()
        .optional()
        .describe("true = preserva la primera versión (v1) además de la actual; default false = compacta todo el historial"),
      user: z.string().min(1).max(64).optional().describe("Owner (default: vos)"),
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
      slug: z.string().min(1).max(200).describe("Slug de la página"),
      visibility: VISIBILITY.describe("Nueva visibility"),
      user: z.string().min(1).max(64).optional().describe("Owner (default: vos)"),
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
      slug: z.string().min(1).max(200).describe("Slug de la página a eliminar"),
      user: z.string().min(1).max(64).optional().describe("Owner (default: vos)"),
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
      resource: z.string().min(1).max(200).describe("Slug/path del recurso a compartir"),
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
      slug: z.string().min(1).max(200).describe("Slug/path de la página. Acepta paths jerárquicos estilo Confluence (ej. 'briefings/hoy', 'clientes/solera/q3')"),
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
      notifySlack: z.string().max(512).optional().describe("Webhook de Slack para notificar la publicación (opcional)"),
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
      slug: z.string().min(1).max(200).describe("Slug/path de la página. Acepta paths jerárquicos estilo Confluence (ej. 'reportes/2026/q3')"),
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
      folder: z.string().min(1).max(200).optional().describe("Folder al que se acota la key (ej. 'clientes/solera'). Sin folder = todo el namespace"),
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
      recipientUser: z.string().min(1).max(64).describe("Username del destinatario (debe existir)"),
      resource: z.string().min(1).max(200).describe("Slug del post o path del folder a compartir"),
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
      prefix: z.string().min(1).max(200).describe("Path de la carpeta (ej. 'clientes/solera')"),
      visibility: VISIBILITY.describe("Visibility default de la carpeta"),
      title: z.string().max(200).optional().describe("Título de la carpeta (opcional)"),
      description: z.string().max(2000).optional().describe("Descripción de la carpeta (opcional)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ prefix, visibility, title, description }) => {
    try {
      return ok(
        await client.req(`/api/folders/${encodeURIComponent(prefix)}`, {
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
      slug: z.string().min(1).max(200).describe("Slug del post a exportar"),
      format: z.enum(["json", "html"]).default("json").describe("json (default, estructurado) o html (crudo)"),
      user: z.string().min(1).max(64).optional().describe("Owner (default: vos). Debe ser vos — cross-user da 403"),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ slug, format, user }) => {
    try {
      const u = await resolveUser(user);
      return ok(
        await client.req(`/api/u/${encodeURIComponent(u)}/${encodeSlugPath(slug)}/export`, {
          query: { format },
        }),
      );
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
      prefix: z.string().min(1).max(200).optional().describe("Acota a una carpeta (ej. 'clientes/solera')"),
      slug: z.string().min(1).max(200).optional().describe("Acota a una página puntual (slug/path)"),
      user: z.string().min(1).max(64).optional().describe("Owner (default: vos)"),
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
      q: z.string().min(1).max(200).describe("Texto a buscar (full-text sobre tu biblioteca)"),
      limit: z.number().int().min(1).max(200).default(20).describe("Máximo de resultados"),
      prefix: z.string().min(1).max(200).optional().describe("Acota la búsqueda a una carpeta (ej. 'clientes/solera')"),
      user: z.string().min(1).max(64).optional().describe("Owner (default: vos)"),
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
      slug: z.string().min(1).max(200).describe("Slug/path de la página"),
      from: z.number().int().min(1).describe("Versión base (la más vieja)"),
      to: z.number().int().min(1).describe("Versión destino (la más nueva)"),
      user: z.string().min(1).max(64).optional().describe("Owner (default: vos)"),
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
      slug: z.string().min(1).max(200).describe("Slug/path de la página"),
      user: z.string().min(1).max(64).optional().describe("Owner (default: vos)"),
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
      agentId: z.string().min(1).max(64).describe("Id del agente del registry (de outbox_agents_registry)"),
      label: z.string().min(1).max(60).optional().describe("Etiqueta de la instancia (1-60 chars)"),
      folder: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Folder al que se acota el agente (blast radius reducido, ej. 'clientes/solera')"),
      config: z
        .record(z.unknown())
        .optional()
        .describe("Config estructurada de la instancia (campos que pida el agente del registry)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ agentId, label, folder, config }) => {
    try {
      return ok(
        await client.req("/api/agents/instantiate", {
          method: "POST",
          body: { agentId, label, folder, config },
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
      filename: z.string().min(1).max(200).optional().describe("Nombre de archivo sugerido (opcional, informativo)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ data, contentType, filename }) => {
    try {
      return ok(
        await client.req("/api/uploads", {
          method: "POST",
          body: { data, contentType, filename },
        }),
      );
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
      prefix: z.string().min(1).max(200).describe("Path de la carpeta a eliminar (ej. 'clientes/solera')"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ prefix }) => {
    try {
      return ok(
        await client.req(`/api/folders/${encodeURIComponent(prefix)}`, { method: "DELETE" }),
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
      prefix: z.string().min(1).max(200).optional().describe("Acota el backup a una carpeta (ej. 'clientes/solera')"),
      limit: z.number().int().min(1).max(500).default(100).describe("Tope de posts a exportar (protege contexto y quota)"),
      user: z.string().min(1).max(64).optional().describe("Owner (default: vos). Debe ser vos — cross-user da 403"),
    },
    annotations: { ...RO, idempotentHint: true },
  },
  async ({ prefix, limit, user }) => {
    try {
      const u = await resolveUser(user);
      const listed = await client.req<{ posts?: { slug?: string }[]; items?: { slug?: string }[] }>(
        "/api/list",
        { query: { limit, prefix } },
      );
      const rows = listed.posts ?? listed.items ?? [];
      const slugs = rows
        .map((r) => (typeof r.slug === "string" ? r.slug : undefined))
        .filter((s): s is string => typeof s === "string")
        .slice(0, limit);

      const posts: unknown[] = [];
      for (const slug of slugs) {
        try {
          const exported = await client.req<unknown>(
            `/api/u/${encodeURIComponent(u)}/${encodeSlugPath(slug)}/export`,
            { query: { format: "json" } },
          );
          posts.push(exported);
        } catch (err) {
          posts.push({ slug, error: formatError(err) });
        }
      }

      return ok({
        user: u,
        ...(prefix ? { prefix } : {}),
        count: posts.length,
        exportedAt: new Date().toISOString(),
        posts,
      });
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
