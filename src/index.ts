#!/usr/bin/env node
/**
 * Outbox MCP server (out-box.dev) — agents-first. Entry STDIO (binario `outbox-mcp`).
 *
 * Expone Outbox como tools nativas para clientes MCP (Claude Desktop, Cursor, etc.)
 * sin curl ni CLI. Transporte: stdio (local). Auth: Bearer `outbox_*` (env OUTBOX_API_KEY
 * o ~/.outboxrc). Ver decisiones-jonathan.md §14.4 y _auditoria/planes/02-mcp.md.
 *
 * Ola 2 (2026-09-30): las tools viven en src/tools.ts (`registerOutboxTools`), el
 * mismo registro que usa el MCP remoto (out-box-mcp-remote/, mcp.out-box.dev). Acá
 * queda solo el bootstrap del proceso: credencial, toolsets, filesystem, elicitation
 * del cliente conectado y el transporte stdio.
 *
 * Mesa 2026-09-29 (AX / DEVC):
 * - `instructions` del server con las reglas transversales (src/instructions.ts).
 * - Toolsets (OUTBOX_TOOLSETS, src/toolsets.ts): por default core + comments + sharing.
 * - Arranca SIN credencial: cada tool devuelve un error accionable (AX-10).
 * - Errores con texto + objeto estructurado { code, retryable, fix } (AX-03/AX-10).
 * - Lectura canónica por /export; nunca el shell sandbox (DEVC-01).
 *
 * Ronda 4 (2026-10-01): SDK v2 de MCP (`@modelcontextprotocol/server`, zod 4). El
 * registro compartido se monta con el mismo adaptador que el remoto (shape → z.object
 * con el zod de este paquete). Transporte stdio cableado a mano: sirve la era 2025
 * (initialize), igual que el binario 0.2.x con el SDK 1.x. `serveStdio` (2026-07-28 por
 * stdio) queda para cuando la elicitation pase a `inputRequired` (multi-round-trip).
 *
 * NOTA: stdio NO debe loguear a stdout — solo stderr (console.error).
 */
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { SERVER_NAME, SERVER_VERSION, SITE_BASE } from "./constants.js";
import { loadConfig } from "./config.js";
import { CONTENT_READ_EXTENSIONS, IMAGE_READ_EXTENSIONS, readFileInRoot, writeFileInRoot } from "./files.js";
import { parseToolsets } from "./toolsets.js";
import { buildInstructions } from "./instructions.js";
import { OutboxClient } from "./services/client.js";
import {
  registerOutboxTools,
  toObjectSchema,
  type ElicitAnswer,
  type ElicitRequest,
  type OutboxFileAccess,
  type OutboxToolHost,
  type ToolResult,
} from "./tools.js";

// ── Bootstrap ────────────────────────────────────────────────────────────────
// Sin credencial NO se muere acá (AX-10): el server conecta y cada tool que
// necesita auth responde "configurá OUTBOX_API_KEY…". Antes loadConfig() tiraba a
// nivel de módulo, fuera del .catch de main(), y el host solo veía "disconnected".
const config = loadConfig();
const client = new OutboxClient(config?.apiKey ?? null);

const toolsets = parseToolsets(process.env.OUTBOX_TOOLSETS);
const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { instructions: buildInstructions(toolsets.enabled, SITE_BASE) },
);

/** I/O local confinado a OUTBOX_FILES_DIR (src/files.ts), para los args `file_path`. */
const files: OutboxFileAccess = {
  read: (path, kind) =>
    readFileInRoot(path, { extensions: kind === "image" ? IMAGE_READ_EXTENSIONS : CONTENT_READ_EXTENSIONS }),
  write: (path, content, opts) => writeFileInRoot(path, content, opts),
};

/**
 * Adaptador host ↔ McpServer v2. El v2 pide un Standard Schema (z.object) en
 * `inputSchema`; el shape crudo sigue andando pero por un overload @deprecated. Se
 * envuelve con `toObjectSchema` (el zod de ESTE paquete: una sola copia en el proceso).
 */
const host: OutboxToolHost = {
  registerTool(name, config, handler) {
    return server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: toObjectSchema(config.inputSchema),
        annotations: config.annotations,
        ...(config._meta ? { _meta: config._meta } : {}),
      },
      async (args: unknown) => (await handler(args as never)) as ToolResult & { content: { type: "text"; text: string }[] },
    );
  },
  registerResource(name, uri, config, read) {
    return server.registerResource(name, uri, config, async () => read());
  },
};

registerOutboxTools(host, client, {
  toolsets: toolsets.enabled,
  user: config?.user,
  files,
  // Elicitation solo si el cliente conectado la declaró (se consulta en cada llamada).
  elicit: () =>
    server.server.getClientCapabilities()?.elicitation
      ? // Era 2025 (la única que sirve este transporte): elicitation push-style.
        (req: ElicitRequest): Promise<ElicitAnswer> => server.server.elicitInput(req)
      : undefined,
  // Mercado prioritario EE.UU. (mesa 2026-10-04): inglés por default; OUTBOX_LANG=es
  // vuelve a los textos en español. Las tools sin texto en inglés quedan en español.
  lang: process.env.OUTBOX_LANG === "es" ? "es" : "en",
  // Ronda 4: offset/maxChars en outbox_pull (paridad con el remoto; opt-in por llamada).
  pullChunks: true,
  // Aviso de versión nueva en outbox_me / outbox_capabilities (clients.mcp.latest).
  packageVersion: SERVER_VERSION,
});

// ── Arranque (stdio) ───────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const auth = config ? `auth: ${config.source}` : "SIN credencial: las tools van a pedir OUTBOX_API_KEY";
  const active = [...toolsets.enabled].join(",");
  console.error(`${SERVER_NAME} v${SERVER_VERSION} corriendo (${auth}; toolsets: ${active}).`);
  if (toolsets.unknown.length > 0) {
    console.error(`OUTBOX_TOOLSETS: se ignoraron toolsets desconocidos: ${toolsets.unknown.join(", ")}.`);
  }
}

main().catch((err) => {
  console.error("Fallo al iniciar el Outbox MCP server:", err);
  process.exit(1);
});
