/**
 * Toolsets del Outbox MCP server (AX-08).
 *
 * `tools/list` con las 64 tools pesaba unos 16-19k tokens en hosts sin tool search
 * (Claude Desktop, Cursor, Agent SDK) y competía en la selección con 63 vecinas. Las
 * tools se agrupan por toolset y el server registra solo los activos:
 *
 *   OUTBOX_TOOLSETS=core,comments,sharing  (default: compartir es la propuesta central)
 *   OUTBOX_TOOLSETS=all                    (todo)
 *   OUTBOX_TOOLSETS=core,sharing,keys      (combinación)
 *
 * Helper PURO (sin I/O): la clasificación de cada tool vive acá y un test verifica
 * que TODA tool registrada tenga toolset (una tool nueva sin clasificar hace fallar
 * el arranque, no queda invisible en silencio).
 */

export const TOOLSETS = ["core", "comments", "library", "sharing", "keys", "teams", "automation", "apps"] as const;
export type Toolset = (typeof TOOLSETS)[number];

/** Toolsets activos si OUTBOX_TOOLSETS no está definido. */
export const DEFAULT_TOOLSETS: readonly Toolset[] = ["core", "comments", "sharing"];

/** Qué hace cada toolset (se muestra en las instructions del server). */
export const TOOLSET_SUMMARY: Record<Toolset, string> = {
  core: "leer, publicar, daily, versiones, visibility, borrador, borrar, subir imágenes, cuenta",
  comments: "comentarios y sugerencias (leer, comentar, sugerir, aceptar, descartar)",
  library: "árbol, carpetas, diff, squash, backup, templates, estilo",
  sharing: "share links, grants user-to-user y quién tiene acceso",
  keys: "API keys (listar, emitir, rotar, revocar), audit y registry de agentes",
  teams: "equipos/orgs, miembros y company keys",
  automation: "event webhooks y schedules (cron → webhook)",
  apps: "visor interactivo de una página (MCP App: metadata, versiones, comentarios y preview aislado)",
};

/** Lo mismo en inglés, para las `instructions` del stdio con OUTBOX_LANG distinto de `es`. */
export const TOOLSET_SUMMARY_EN: Record<Toolset, string> = {
  core: "read, publish, daily, versions, visibility, draft, delete, image uploads, account",
  comments: "comments and suggestions (read, comment, suggest, accept, discard)",
  library: "tree, folders, diff, squash, backup, templates, style",
  sharing: "share links, user-to-user grants and who has access",
  keys: "API keys (list, issue, rotate, revoke), audit and agent registry",
  teams: "teams/orgs, members and company keys",
  automation: "event webhooks and schedules (cron → webhook)",
  apps: "interactive viewer for a page (MCP App: metadata, versions, comments and isolated preview)",
};

/** Toolset de cada tool. Fuente de verdad de la clasificación. */
export const TOOL_TOOLSET: Record<string, Toolset> = {
  // core
  outbox_me: "core",
  outbox_usage: "core",
  outbox_capabilities: "core",
  outbox_list: "core",
  outbox_search: "core",
  outbox_recent: "core",
  outbox_pull: "core",
  outbox_export: "core",
  outbox_versions: "core",
  outbox_rollback: "core",
  outbox_publish: "core",
  outbox_append: "core",
  outbox_get_blocks: "core",
  outbox_set_visibility: "core",
  outbox_go_live: "core",
  outbox_delete: "core",
  outbox_upload: "core",
  // comments
  outbox_read_comments: "comments",
  outbox_create_comment: "comments",
  outbox_create_suggestion: "comments",
  outbox_accept_suggestion: "comments",
  outbox_discard_suggestion: "comments",
  // library
  outbox_list_tree: "library",
  outbox_folders: "library",
  outbox_set_folder: "library",
  outbox_delete_folder: "library",
  outbox_diff: "library",
  outbox_squash: "library",
  outbox_export_library: "library",
  outbox_templates: "library",
  outbox_publish_from_template: "library",
  outbox_set_style: "library",
  // sharing
  outbox_create_share: "sharing",
  outbox_list_shares: "sharing",
  outbox_revoke_share: "sharing",
  outbox_create_grant: "sharing",
  outbox_list_grants: "sharing",
  outbox_revoke_grant: "sharing",
  outbox_access: "sharing",
  outbox_set_page_password: "sharing",
  // keys
  outbox_list_keys: "keys",
  outbox_gen_agent_key: "keys",
  outbox_rotate_key: "keys",
  outbox_revoke_key: "keys",
  outbox_audit: "keys",
  outbox_agents_registry: "keys",
  outbox_instantiate_agent: "keys",
  // teams
  outbox_create_team: "teams",
  outbox_list_teams: "teams",
  outbox_list_team_members: "teams",
  outbox_add_team_member: "teams",
  outbox_remove_team_member: "teams",
  outbox_gen_team_key: "teams",
  outbox_list_team_keys: "teams",
  outbox_revoke_team_key: "teams",
  // Empresas v3
  outbox_invite_team_member: "teams",
  outbox_team_invites: "teams",
  outbox_respond_team_invite: "teams",
  outbox_leave_team: "teams",
  outbox_set_team_member: "teams",
  outbox_team_groups: "teams",
  outbox_team_profile: "teams",
  // Señales de una página publicada: quién la abrió (lo completado se lee con outbox_page_data).
  // Mesa 2026-10-04: "¿lo abrió el cliente?" es parte del loop básico (read-only).
  outbox_page_views: "core",
  // Mismo pedido visto desde los links: "¿quién no abrió la propuesta?" (read-only).
  outbox_unopened_links: "sharing",
  // automation
  outbox_webhook_events: "automation",
  outbox_create_webhook: "automation",
  outbox_list_webhooks: "automation",
  outbox_delete_webhook: "automation",
  outbox_pause_webhook: "automation",
  outbox_create_schedule: "automation",
  outbox_list_schedules: "automation",
  outbox_delete_schedule: "automation",
  outbox_pause_schedule: "automation",
  // apps (Ola 2, MCP Apps). outbox_page_preview es solo-app (_meta.ui.visibility).
  outbox_show_page: "apps",
  outbox_page_preview: "apps",
  // sandbox-platform (src/tools/sandbox-platform.ts): vigía de render y datos de página.
  outbox_render_status: "library",
  outbox_page_data: "library",
};

/**
 * Tools que se registran SOLO sin credencial (ni OUTBOX_API_KEY ni ~/.outboxrc). Con key
 * el agente publica en la biblioteca del usuario con outbox_publish; ofrecerle además
 * un publish anónimo y público lo invitaba a sacar contenido de la cuenta. El remoto
 * siempre corre con credencial, así que nunca las expone.
 */
export const KEYLESS_ONLY_TOOLS: ReadonlySet<string> = new Set(["outbox_publish_anonymous"]);
// Van FUERA de TOOL_TOOLSET a propósito: el remoto (out-box-mcp-remote) arma su
// superficie curada a partir de TOOL_TOOLSET y nunca las registra (siempre tiene
// credencial). No dependen de OUTBOX_TOOLSETS: se registran siempre que no haya key.

export interface ParsedToolsets {
  enabled: Set<Toolset>;
  /** Nombres pedidos que no existen (se ignoran y se avisan por stderr). */
  unknown: string[];
}

/**
 * Parsea OUTBOX_TOOLSETS (lista separada por coma o espacio, case-insensitive).
 * Vacío/ausente → DEFAULT_TOOLSETS. `all` → todos. `core` siempre queda activo:
 * sin él el agente no puede ni leer ni publicar.
 */
export function parseToolsets(raw: string | undefined): ParsedToolsets {
  const unknown: string[] = [];
  const value = raw?.trim();
  if (!value) return { enabled: new Set(DEFAULT_TOOLSETS), unknown };
  const enabled = new Set<Toolset>(["core"]);
  for (const part of value.split(/[\s,]+/).map((p) => p.trim().toLowerCase()).filter(Boolean)) {
    if (part === "all") {
      for (const t of TOOLSETS) enabled.add(t);
    } else if ((TOOLSETS as readonly string[]).includes(part)) {
      enabled.add(part as Toolset);
    } else {
      unknown.push(part);
    }
  }
  return { enabled, unknown };
}

/** ¿La tool está en un toolset activo? Tira si la tool no está clasificada. */
export function isToolEnabled(name: string, enabled: ReadonlySet<Toolset>): boolean {
  if (KEYLESS_ONLY_TOOLS.has(name)) return true;
  const ts = TOOL_TOOLSET[name];
  if (!ts) {
    throw new Error(`La tool ${name} no tiene toolset asignado en src/toolsets.ts (TOOL_TOOLSET).`);
  }
  return enabled.has(ts);
}
