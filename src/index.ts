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
        await client.req(`/api/u/${encodeURIComponent(u)}/${encodeURIComponent(slug)}/versions`),
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
        await client.req(`/api/u/${encodeURIComponent(u)}/${encodeURIComponent(slug)}/blocks`, {
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
        await client.req(`/api/u/${encodeURIComponent(u)}/${encodeURIComponent(slug)}/append`, {
          method: "POST",
          body: { html, label, title, visibility },
        }),
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
        await client.req(`/api/u/${encodeURIComponent(u)}/${encodeURIComponent(slug)}/rollback`, {
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
        await client.req(`/api/u/${encodeURIComponent(u)}/${encodeURIComponent(slug)}/visibility`, {
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
        await client.req(`/api/u/${encodeURIComponent(u)}/${encodeURIComponent(slug)}`, {
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
    title: "Outbox: publicar HTML crudo",
    description:
      "Publica una página con HTML crudo (POST /publish). Crea o sobrescribe el `slug` (versionado automático: cada publish es una versión nueva). " +
      "`model` es OBLIGATORIO (atribución del modelo, B8). `visibility` default `private`. No es destructivo (no borra; versiona).\n\n" +
      "Args clave: slug, html, model (req). Opcionales: title, visibility, tags, summary, description, contentType, ttl, inheritFolderVisibility.",
    inputSchema: {
      slug: z.string().min(1).max(200).describe("Slug/path de la página. Acepta paths jerárquicos estilo Confluence (ej. 'briefings/hoy', 'clientes/solera/q3')"),
      html: z.string().min(1).describe("HTML crudo de la página (máx 5MB)"),
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
        await client.req(`/api/u/${encodeURIComponent(u)}/${encodeURIComponent(slug)}/export`, {
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
