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
├── constants.ts        API_BASE / SITE_BASE, timeouts, SERVER_NAME, SERVER_VERSION, límites
├── config.ts           resolución de credencial (key, user, rc). Devuelve null sin credencial
├── schemas.ts          esquemas Zod compartidos anti path-traversal (SLUG_SCHEMA,
│                       PREFIX_SCHEMA, USER_SCHEMA, TEAM_HANDLE_SCHEMA, FREE_TEXT_SCHEMA,
│                       IDEMPOTENCY_KEY_SCHEMA, FILE_PATH_SCHEMA)
├── paths.ts            helpers PUROS de paths de URL (encodeSlugPath, per-segmento)
├── filters.ts          helpers PUROS de filtros (normalizeSince, slugUnderPrefix)
├── output.ts           helpers PUROS de serialización (fitJson por ítems, projectPost)
├── comments.ts         helpers PUROS anti prompt-injection (trust, untrustedText)
├── toolsets.ts         clasificación de cada tool en un toolset + OUTBOX_TOOLSETS
├── instructions.ts     `instructions` del server (reglas transversales)
├── files.ts            I/O local confinado a OUTBOX_FILES_DIR (file_path)
├── index.ts            entry STDIO: credencial, toolsets, filesystem, elicitation y transporte
│                       (McpServer del SDK v2 `@modelcontextprotocol/server`, Node 20+)
├── pull-chunks.ts      helpers PUROS de outbox_pull por trozos (offset/maxChars, sha256)
├── tools.ts            registerOutboxTools(host, client, opts): TODAS las tools (Ola 2), sin
│                       estado de módulo, sin fs ni SDK; lo reusa out-box-mcp-remote/
├── tools-en.ts         textos EN (título, descripción, params) para el remoto (lang "en")
├── apps/
│   └── page-viewer.ts  MCP App: HTML autocontenido del visor (ui://outbox/page-viewer.html)
└── services/
    └── client.ts       OutboxClient: fetch con timeout, Idempotency-Key, lectura canónica
                        (readContent/readMarkdown), errores (formatError + describeError)
test/                   node:test (*.test.mjs) contra dist/; harness.mjs = back simulado + server real
                        (cliente `@modelcontextprotocol/client` v2); slug-rules.mjs = reglas de slug
                        del worker (JSON canónico si existe, si no el port a mano)
evals/
└── outbox-evals.xml    golden dataset / evals del server
dist/                   output de `tsc` (compilado, no se edita a mano)
```

## Las tools

Todas las tools se registran en `src/tools.ts` con `registerTool(...)` (wrapper que respeta los
toolsets, el filtro `include` y el idioma). Para el **conteo real** no confíes en ningún doc:
`grep -c '^  registerTool($' src/tools.ts` (65 al 2026-09-30) + las 2 de `src/tools/sandbox-platform.ts`
(`outbox_render_status`, `outbox_page_data`) = **67** con `OUTBOX_TOOLSETS=all`.

**Reglas de `src/tools.ts` (Ola 2, lo consume el MCP remoto por import de fuente):** nada de estado a
nivel de módulo (todo en el closure de `registerOutboxTools`), nada de `node:fs`/`process.env` (el I/O
de `file_path` entra por `opts.files`), nada de imports del SDK (el host adapta). Toda tool que vaya al
remoto necesita textos EN en `src/tools-en.ts` y scope en `out-box-mcp-remote/src/scopes.ts`
(`TOOL_SCOPE`); los tests de los dos paquetes lo verifican.
La tabla completa por toolset vive en README.md.

**Toda tool nueva tiene que estar en `TOOL_TOOLSET` (`src/toolsets.ts`)**: si no, el server tira al
arrancar (y `test/arranque.test.mjs` falla). Default activo: `core` + `comments`.

Categorías (la anotación de cada tool en `tools.ts` es la fuente de verdad):

- **read** — `readOnlyHint: true`.
- **write** — escrituras no destructivas (publish versiona, no borra).
- **⚠️ sensible** — emisión de API keys (plaintext se muestra 1 sola vez), sin `destructiveHint`.
- **⚠️ destructivo** — todo lo que lleva `destructiveHint: true`: delete, rollback, squash, revocar,
  rotar, `outbox_go_live` y `outbox_accept_suggestion` (modifica contenido vigente, posiblemente
  público). `grep -c 'destructiveHint: true' src/tools.ts`.

## Convención: encoding y validación de slugs/prefixes

Regla dura del repo (rompió dos veces contra el entorno de pre-lanzamiento de `out-box.dev` antes de fijarse; Outbox nunca salió a producción):

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
| `OUTBOX_SITE_BASE` | `https://out-box.dev` | Solo para la URL pública que se muestra al humano (`SITE_BASE/<user>/<slug>`, sin `/u/`). No se usa para leer. |
| `OUTBOX_TOOLSETS` | `core,comments` | Toolsets a registrar (`all` = todos). |
| `OUTBOX_FILES_DIR` | `~/Outbox` | Raíz del I/O local de `file_path`. |

## Contrato

- **`model` es obligatorio** en `outbox_publish` y `outbox_publish_from_template` (contrato B8 del
  back: si falta, responde `400 missing_model`). Es el id del modelo que generó el contenido.
- **Una sola base para leer y escribir** (`API_BASE`). El contenido se lee por
  `GET /api/u/:u/:slug/export?format=html` (DEVC-01), **nunca** por el sitio público: con
  `SANDBOX_SERVE=on` el catch-all devuelve un shell con `<iframe src="/raw/...">`. Toda respuesta con
  `x-outbox-shell: on` (o con el iframe `__ob_content`) se rechaza con `shell_response`.
- **Contenido de terceros = datos** (AX-02): comentarios de terceros van en `untrustedText` con `trust`;
  el HTML de otro usuario sale con un aviso en un bloque aparte. No quitar estas barandas.
- **Errores**: `fail()` devuelve el texto de `formatError` + `{ error: describeError(e) }` en
  `structuredContent` y en un segundo bloque. Un código nuevo del back con causa conocida → sumarlo a
  los dos (texto y `fix`).
- **Escrituras reintentables** (publish, append, comments, from-template) llevan `Idempotency-Key`. El
  cliente reintenta ante falla de red solo si el back anuncia `features.idempotency`. Desde la ronda 3 el
  worker lo anuncia en `true` pero solo deduplica lo que lista `features.idempotencyEndpoints`
  (`publish`, `publishFromTemplate`); append y comentarios no (ver STATUS, pendiente 4).
- **Datos de páginas y vigía de render** (ronda 3, `src/tools/sandbox-platform.ts`): las entradas de
  visitantes y sus reportes de render son `untrusted`; nunca los muevas a `data` ni al texto plano.
- **Nunca rotar/revocar la key activa** (DEVC-03): las guardas usan el `keyId` de `/api/me`.
- **Re-publish hereda** (AX-01, worker 2026-09-30): lo que el body no manda se hereda del meta previo
  (title, tags, summary, description, contentType, visibility efectiva; draft y TTL se conservan). Las
  descripciones e instructions lo asumen: no mandar campos "por las dudas" que pisen lo que el humano
  cambió.
- **`expectedVersion`**: si `capabilities.features.expectedVersion` es `true`, el MCP lo manda y confía
  en el 409 atómico del worker (`currentVersion`/`currentEtag`, normalizados); el chequeo local
  (`currentVersionForCheck`) solo corre contra un back que no lo anuncie.
- **Step-up MFA**: `outbox_rotate_key`, `outbox_gen_agent_key` y `outbox_instantiate_agent` aceptan
  `mfaCode` (`MFA_CODE_SCHEMA`). Ante `step_up_required` el agente le pide el código al usuario; el MCP
  nunca lo guarda. Una tool nueva que emita keys debe sumar el mismo campo.
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
- **Leer ≠ sitio público**: nunca leer contenido por `SITE_BASE/<user>/<slug>` (devuelve el shell).
  `SITE_BASE` solo arma la URL que se le muestra al humano.
- **Páginas privadas**: para leerlas, la key necesita el verbo `list` (o `admin:self`).
- **Sin truncar contenido autoritativo** (`raw()`): pull/export/export_library. Para que no pese en el
  contexto está `file_path`, confinado a `OUTBOX_FILES_DIR` (`src/files.ts`), y en `outbox_pull` la lectura
  por trozos EXPLÍCITOS (`offset`/`maxChars`, nunca un recorte silencioso). No aflojar el confinamiento:
  el path lo elige el modelo, que puede estar leyendo contenido inyectado.
- **Listados**: `ok()` serializa compacto y recorta por ítems (`fitJson`); nunca a mitad del JSON.
- **Tests de contrato**: `/api/me` y `/api/capabilities` los atiende el harness con valores fijos por
  instancia (el server los cachea por proceso) y no aparecen en `calls`.
- Ver [`STATUS.md`](./STATUS.md) para el estado de release (versión, rename de paquete, npm).
