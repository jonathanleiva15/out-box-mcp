# AGENTS.md — @out-box/mcp

> Documento canónico de contexto para agentes (Claude Code, Cursor, etc.) que trabajan en este repo.

## Propósito

Server **MCP oficial de [Outbox](https://out-box.dev)** (out-box.dev). Expone Outbox como
**herramientas nativas** para cualquier cliente MCP (Claude Desktop, Cursor, etc.) — sin curl ni CLI.

El cliente MCP lo lanza por **stdio** con `npx -y @out-box/mcp` y una credencial `OUTBOX_API_KEY`
(`outbox_*`). No requiere instalación global.

Es una de las **3 vías** para usar Outbox desde un agente, todas contra la misma API/back y la misma
API key:
- **CLI** (`outbox …`) — comandos shell.
- **skill** `outbox-publish` — para agentes con skills.
- **MCP** (este paquete) — tools nativas en clientes MCP.

## Estructura

```
src/
├── constants.ts     API_BASE / SITE_BASE, SERVER_NAME, SERVER_VERSION, límites
├── config.ts        resolución de credencial y defaults (key, user, bases)
├── index.ts         entry: registra las tools y arranca el server stdio
└── services/        lógica de cada tool (fetch a la API, parsing de respuestas)
evals/
└── outbox-evals.xml golden dataset / evals del server
dist/                output de `tsc` (compilado, no se edita a mano)
```

## Las 27 tools

Agrupadas por categoría (ver README.md para la tabla completa con args):

- **read (13)** — `outbox_me`, `outbox_list`, `outbox_list_tree`, `outbox_read`, `outbox_versions`,
  `outbox_get_blocks`, `outbox_list_shares`, `outbox_list_keys`, `outbox_list_grants`,
  `outbox_folders`, `outbox_export`, `outbox_capabilities`, `outbox_read_comments`.
- **write (10)** — `outbox_publish`, `outbox_publish_from_template`, `outbox_append`,
  `outbox_rollback`, `outbox_set_visibility`, `outbox_set_folder`, `outbox_set_style`,
  `outbox_create_share`, `outbox_create_grant`.
- **comment / owner (3)** — `outbox_create_suggestion` (comment), `outbox_accept_suggestion` (owner),
  `outbox_discard_suggestion` (owner). Flujo agents-first: el agente propone un cambio de texto
  (anchor + replacement) y el owner lo acepta → versión nueva atribuida.
- **⚠️ sensible (1)** — `outbox_gen_agent_key`: emite una agent key folder-scoped (delegación).
- **⚠️ destructivo (1)** — `outbox_delete`: elimina una página.

## Autenticación

Precedencia de la credencial:
1. `OUTBOX_API_KEY` (variable de entorno) — recomendado.
2. `~/.outboxrc` — el archivo que escribe el CLI con `outbox login`.

La key **nunca** se loguea. El server **no** escribe `~/.outboxrc` (eso lo hace el CLI). En sesiones
remotas/headless el agente **no puede hacer login interactivo** → por eso la auth es por key.

Variables de entorno (todas opcionales salvo la credencial):

| Variable | Default | Para qué |
|---|---|---|
| `OUTBOX_API_KEY` | — | La API key `outbox_*`. Precedencia sobre `~/.outboxrc`. |
| `OUTBOX_USER` | (de `~/.outboxrc` o `/api/me`) | Username del owner, para defaultear el arg `user`. |
| `OUTBOX_RC` | `~/.outboxrc` | Path alternativo al archivo de credencial. |
| `OUTBOX_API_BASE` | `https://api.out-box.dev` | Base de la API (mutaciones, listados, gestión). |
| `OUTBOX_SITE_BASE` | `https://out-box.dev` | Base del sitio público para leer el HTML (`SITE_BASE/<user>/<slug>`, sin `/u/`). |

## Contrato

- **`model` es obligatorio** en `outbox_publish` y `outbox_publish_from_template` (contrato B8 del
  back: si falta, responde `400 missing_model`). Es el id del modelo que generó el contenido.
- **Doble base**: las mutaciones/listados pegan a `API_BASE`; el HTML servido se lee desde
  `SITE_BASE/<user>/<slug>` (**sin** `/u/`, nunca desde la API).
- **`outbox_accept_suggestion` no siempre publica `vN+1`**: si el reemplazo no cambia el HTML,
  el back aplica un no-op guard (`{ noChange: true }`) y NO crea versión nueva.

## Comandos de desarrollo

```bash
npm install
npm run build          # compila a dist/ (tsc)
npm run dev            # tsx watch src/index.ts
npm run inspector      # probar con MCP Inspector
```

## Gotchas

- **stdio**: el transporte es stdout; **nada** debe escribir a stdout salvo el protocolo MCP
  (los logs van a stderr). No agregar `console.log` a stdout.
- **La key nunca se loguea**: cuidado al agregar logging que pueda filtrar `OUTBOX_API_KEY`.
- **`dist/` es output de build**: no editar a mano; se regenera con `npm run build`.
- **Lectura de HTML sin `/u/`**: el catch-all del front manda `/u/*` a Next, no al back. El path
  correcto del sitio público es `SITE_BASE/<user>/<slug>`.
- **Páginas privadas**: para leerlas, la key debe ser del owner.
- Ver [`STATUS.md`](./STATUS.md) para el estado de release (versión, rename de paquete, npm).
