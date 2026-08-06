# AGENTS.md — @out-box/mcp

> Documento canónico de contexto para agentes (Claude Code, Cursor, etc.) que trabajan en este repo.

## Propósito

Server **MCP oficial de [Outbox](https://out-box.dev)** (out-box.dev). Expone Outbox como
**herramientas nativas** para cualquier cliente MCP (Claude Desktop, Cursor, etc.) — sin curl ni CLI.

El cliente MCP lo lanza por **stdio** con una credencial `OUTBOX_API_KEY` (`outbox_*`).
La forma de lanzarlo depende del estado de publicación del paquete en npm — ver el README
(sección Instalación) para las vías vigentes y `STATUS.md` para el estado de release.

Es una de las **3 vías** para usar Outbox desde un agente, todas contra la misma API/back y la misma
API key:
- **CLI** (`outbox …`) — comandos shell.
- **skill** `outbox-publish` — para agentes con skills.
- **MCP** (este paquete) — tools nativas en clientes MCP.

## Estructura

```
src/
├── constants.ts        API_BASE / SITE_BASE, SERVER_NAME, SERVER_VERSION, límites
├── config.ts           resolución de credencial y defaults (key, user, bases)
├── schemas.ts          esquemas Zod compartidos anti path-traversal (SLUG_SCHEMA,
│                       PREFIX_SCHEMA, USER_SCHEMA, TEAM_HANDLE_SCHEMA, FREE_TEXT_SCHEMA)
├── paths.ts            helpers PUROS de paths de URL (encodeSlugPath, per-segmento) —
│                       sin I/O ni config, la única implementación compartida
├── index.ts            entry MONOLÍTICO: acá viven TODAS las tools (server.registerTool)
│                       + helpers ok()/fail() + arranque del server stdio
└── services/
    └── client.ts       OutboxClient: fetch a la API, readHtml del sitio público,
                        parsing de errores (missingScope / missingAnyOf)
test/                   tests unitarios (node:test, *.test.mjs) — corren contra dist/
evals/
└── outbox-evals.xml    golden dataset / evals del server
dist/                   output de `tsc` (compilado, no se edita a mano)
```

## Las tools

Todas las tools se registran en `src/index.ts` (no hay un archivo por tool). Para el
**conteo real** no confíes en ningún doc: derivalo con
`grep -c registerTool src/index.ts` o corré el `docs-check.mjs` de la skill
`outbox-docs-sync`. La tabla completa (nombre, qué hace, categoría) vive en README.md.

Categorías (la anotación de cada tool en `index.ts` es la fuente de verdad):

- **read** — listados, lecturas de HTML/JSON, capabilities, audit, teams. Read-only.
- **write** — publish, append, visibility, shares, grants, webhooks, schedules, teams.
- **comment / owner** — flujo de sugerencias agents-first: el agente propone un cambio de
  texto (anchor + replacement) y el owner lo acepta → versión nueva atribuida.
- **⚠️ sensible** — emisión de API keys (plaintext se muestra 1 sola vez), sin
  `destructiveHint`.
- **⚠️ destructivo** — todo lo que lleva `destructiveHint: true`:
  delete/rollback/squash/remove-member y `outbox_rotate_key` (revoca la key vieja).
  La categoría del README debe coincidir 1:1 con esa annotation:
  `grep -c 'destructiveHint: true' src/index.ts`.

## Convención: encoding y validación de slugs/prefixes

Regla dura del repo (rompió prod dos veces antes de fijarse):

- **Slugs y prefixes se encodean SIEMPRE per-segmento con `encodeSlugPath`**
  (`src/paths.ts`): split por `/` → `encodeURIComponent` de cada segmento → join con `/`.
  **NUNCA** `encodeURIComponent` del path entero: convierte `/` en `%2F` y el worker
  splitea el pathname crudo sin decodificar → `clientes%2Fsolera` cae como UN segmento
  → `400 invalid_slug` / `invalid_prefix`. Aplica a toda URL que lleve un slug/prefix
  (API y sitio público). Si agregás una tool nueva con slug/prefix en la URL, usá
  `encodeSlugPath` — no reimplementes el encode inline.
- **Todo input que viaje en una URL se valida con los schemas compartidos de
  `src/schemas.ts`**: `SLUG_SCHEMA`/`PREFIX_SCHEMA` (regex path-slug copiado verbatim del
  backend + refine anti `.`/`..` → cierra path traversal), `USER_SCHEMA`/
  `TEAM_HANDLE_SCHEMA` (regex username verbatim del backend; el charset sin `.` bloquea
  dot-segments que sobreviven a `encodeURIComponent` y reescribirían segmentos como
  `/api/teams/:handle/members/:user`). `FREE_TEXT_SCHEMA` es solo para texto que NO se
  concatena a URLs (hoy: el `q` de búsqueda). No declares
  `z.string().min(1).max(200)` inline para un slug/user: usá el schema compartido y
  agregale tu `.describe(...)` encima.
- Si el backend cambia sus regex (`out-box/worker/src/lib/slug.ts`,
  `out-box/worker/src/lib/users.ts`), estos schemas deben re-copiarse verbatim.

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
npm run test           # build + tests unitarios (node --test, corren contra dist/)
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
