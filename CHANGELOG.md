# Changelog — @out-box/mcp

Todos los cambios notables del MCP server de Outbox.
Formato [Keep a Changelog](https://keepachangelog.com/) + SemVer.
La versión vive en `package.json` y `src/constants.ts` (`SERVER_VERSION`), sincronizadas.

## [Unreleased]

## [0.3.0] — 2026-10-03

Primera versión publicada en npm. Incluye todo lo de abajo (SDK v2 de MCP, toolsets, registro portable compartido con el MCP remoto) más Empresas v3 (invitaciones, roles, grupos, perfil público, aperturas, links por destinatario), `outbox_set_page_password` y el paquete sin source maps.

### Ronda 4 (2026-10-01)

- **SDK v2 de MCP.** El binario stdio pasa de `@modelcontextprotocol/sdk` 1.x a `@modelcontextprotocol/server`
  ^2.2.0 (zod 4), con el mismo adaptador que el MCP remoto (`toObjectSchema`: shape → `z.object` del zod de
  este paquete, sin el overload @deprecated de shapes crudos). Mismo binario (`outbox-mcp`), mismos
  toolsets y nombres de tools. Transporte stdio cableado a mano: sirve la era 2025 (`initialize`,
  protocolo negociado 2025-11-25) y la elicitation sigue siendo push-style; `serveStdio` (2026-07-28 por
  stdio) queda para cuando `outbox_accept_suggestion` pase a `inputRequired`. Los tests usan
  `@modelcontextprotocol/client` ^2.2.0 (`setRequestHandler("elicitation/create", …)`). **Node 20+**
  (`engines`), lo exige el v2. En `tools/list` cambia `$schema` (2020-12) y deja de venir `execution`
  (tasks, que el v2 sacó). Argumentos inválidos siguen saliendo como resultado `isError`.
- **`outbox_pull` por trozos** (paridad con el remoto): `offset` y `maxChars` (1000-200000, default
  60000), opt-in. Sin ellos, contenido completo como siempre. Con ellos, `structuredContent` suma `offset`,
  `length`, `totalChars`, `nextOffset`, `complete` y `contentSha256`, y un trozo parcial va con un aviso
  "LECTURA PARCIAL". `file_path` + trozos → `conflicting_args`; offset fuera de rango → `invalid_offset`.
  Opción `pullChunks` del registro (el remoto no la activa: parte en su adaptador). `src/pull-chunks.ts`.
- **`idempotencyKey` en las respuestas exitosas** de `outbox_publish`, `outbox_publish_from_template`,
  `outbox_append`, `outbox_create_comment` y `outbox_create_suggestion` (campo al final del JSON; no pisa
  una del back). Antes solo salía en los errores.
- **`outbox_append` con el contrato de atributos del worker (ronda 4):** `createOnly` (solo crear: si el slug
  ya tiene daily, `409 daily_exists` con `existingDate`, sin escribir) y `applyAttributes` (aplicar
  title/visibility en un append de continuación). Las descripciones de `title`/`visibility` (ES y EN)
  dicen que se aplican al crear el día y se ignoran después; el 200 con `ignoredAttributes` suma un aviso
  que pide no repetir el append. `describeError`/`formatError` con caso propio para `daily_exists`.
  `outbox_set_visibility` aclara que también sirve para dailies.
- **Reglas de slug en los tests:** `test/slug-rules.mjs` consume el JSON canónico del worker si existe
  (`../out-box/worker/src/lib/slug-rules.json`, `../out-box/worker/slug-rules.json` u
  `OUTBOX_SLUG_RULES_JSON`) y si no cae al port a mano, que se sigue comparando con `lib/slug.ts`.
- Tope de peso de `tools/list` (default core+comments) de 33.000 a 34.000 bytes por los params nuevos
  (el SDK 1.x ya dejaba 32.990). `test/ronda4-mcp4.test.mjs`; `pasada5-append-meta` actualizado al
  contrato nuevo del worker.
- **Gate de la ronda 4:** `describeError` suma `requestId` (el que el worker pone en todo body JSON de
  error, igual a `x-request-id`) cuando cumple el charset opaco `[A-Za-z0-9_.:-]{1,128}`; si no, lo
  descarta. El remoto lo conserva en su error EN. `test/gate-ronda4.test.mjs` también corre los `examples`
  de `out-box/worker/src/lib/slug-rules.json` contra `SLUG_SCHEMA` + las reglas cargadas (vectores de
  conformidad). Tests al cierre: **362 (361 pass, 1 skip intencional)**.

### Seguridad pasada 4 (2026-10-01)

- **Gate:** `describeError`/`formatError` con casos propios para 401 `step_up_required` (antes el texto
  caía al genérico "credencial inválida"; con `reason: "code_already_used"` pide el PRÓXIMO código: el
  TOTP ahora es de un solo uso), 403 `folder_escalation` y `slug_not_under_allowed_folder` (con
  `allowedFolders`) y 403 `read_scope_required` (abrir `visitorRead` de page-data). El schema de `mfaCode`
  dice que cada código sirve para una operación. `test/gate-seg-p4.test.mjs`.
- **Confianza de comentarios relativa al LECTOR**: en una página ajena, los comentarios de SU dueño
  llegaban como `trust: "owner"` planos (el worker la calcula por página: commenter === postOwner) y el
  modelo leía "owner" como su usuario. Ahora `readerTrust` los marca `page-owner` (tercero: texto en
  `untrustedText`, `notice` + `trustNote`); fail-closed: solo `viewerIsOwner === true` deja algo plano.
  Aplica a `outbox_read_comments`, `outbox_show_page` y el preview de `outbox_accept_suggestion`.
  `from: "owner"` = lo escrito por el dueño de la página (owner | page-owner).
- **`outbox_accept_suggestion` / `outbox_discard_suggestion`**: el preview mandaba `note` (body del tercero),
  `exact`, `replacement` y `proposedBy` planos al lado de un confirmToken válido; ahora van en
  `preview.untrustedText` con `notice`. El `comment` que devuelve el worker en accept/discard pasa por
  `annotateCommentWrite` (antes se reenviaba crudo).
- **Contenido de páginas ajenas**: `outbox_export` (html: bloque de aviso aparte antes del HTML intacto;
  json: `thirdParty` + `thirdPartyNotice`), `outbox_get_blocks`, `outbox_versions`, `outbox_diff`,
  `outbox_recent`, `outbox_search`, `outbox_export_library` y `outbox_show_page` (title/summary/tags y
  títulos/model de versiones en `untrustedText`) llevan el mismo aviso que `outbox_pull`. El visor lee
  `untrustedText` y oculta "restore/review" en páginas ajenas. `test/seg-p4-inyeccion.test.mjs`.

### Seguridad pasada 3 (2026-10-01)

- **Gate:** `describeError` con casos propios para 403 `comment_scope_required` (no escribe en páginas de
  otra cuenta, no reintentar) y 400 `invalid_expiresInDays` (share/grant sin vencimiento desde una key
  agent); el texto de `expiry_escalation` nombra share links y grants. `test/gate-seg-p3.test.mjs`.

- **`outbox_list_grants incoming:true` / `outbox_list_teams`**: cualquier cuenta puede crearte un grant con
  `message` libre (500 chars) o sumarte/transferirte su equipo con un `name` libre, sin que aceptes nada, y ese
  texto llegaba plano al agente. Ahora los grants recibidos traen `trust: "third-party"` y message, resource,
  url y campos desconocidos en `untrustedText`; en teams el `name` no nulo va siempre en `untrustedText`
  (transfer no pide consentimiento, así que role owner no garantiza autoría). Ambos con `notice`, fail-closed
  (ids, usernames, enums y fechas validados afuera). Regla 2 de `instructions` nombra grants y teams.
  `src/inbound.ts`, `test/seg-p3-grants-teams.test.mjs`.

### Seguridad pasada 2 (2026-10-01)

- **`outbox_accept_suggestion`**: el `confirmToken` era `sha256(commentId, exact, replacement)` sin clave y
  lo podía calcular el autor de la sugerencia (plantándolo en un comentario, la primera llamada con
  `confirm:true` aplicaba sin preview). Ahora es `<exp>.<HMAC-SHA256>` con clave derivada de la credencial
  (`OutboxClient.deriveKey`, o `confirmKey` del host) sobre owner + slug + commentId + exact + replacement +
  vencimiento (10 min); el preview trae `confirmTokenExpiresAt` y los tokens inválidos/vencidos devuelven el
  preview nuevo (`confirm_token_mismatch` / `confirm_token_expired`). `test/seg-p2-token.test.mjs`.
- **`outbox_agents_registry` / `outbox_instantiate_agent`**: el manifest de terceros (label, description,
  recipe, runtime, campos desconocidos) va en `untrustedText` con aviso; en instantiate la key nueva queda
  aparte con `keyHandling` ("nunca a una URL que no pidió el usuario"). Regla 2 de `instructions` nombra el
  registry. `src/agents.ts`, `test/seg-p2-registry.test.mjs`.
- **`release.yml`**: build (npm ci + test + `npm pack`, sin secrets ni OIDC, checkout sin credenciales) y
  publish (único job con `id-token: write` y `NPM_TOKEN`, sin checkout ni npm ci,
  `npm publish <tgz> --ignore-scripts`). `test/seg-p2-release.test.mjs`.

### Gate de la seguridad pasada 2 (2026-10-01)

- `outbox_instantiate_agent` saca afuera de `untrustedText` el `agentKey.expiresAt` que ahora manda el back,
  solo si es un instante ISO UTC (fail-closed); `source` sigue en `untrustedText`.
- 403 `expiry_escalation` y `slug_whitelist_escalation` (emisión, rotación e instantiate desde una key con
  vencimiento o slugWhitelist) tienen remedio propio, no reintentable, con `maxExpiresAt`/`allowedSlugs`
  (`test/gate-seg-p2.test.mjs`).

### Seguridad pasada 1 (2026-10-01)

- **`outbox_read_comments`**: en terceros, el ancla (`anchor`/`anchors`: `exact`, `prefix`, `suffix`,
  `headingPath`, `domPath`) va dentro de `untrustedText`; afuera `anchor` solo trae `{start,end}`.
- **Caracteres invisibles**: `hasHiddenChars` detecta Unicode Tags, selectores de variación (también los
  del suplemento), default-ignorables y controles; el preview de `outbox_accept_suggestion` trae
  `escaped: true` y el texto como `\u{…}`.
- **`outbox_add_team_member`** acepta `mfaCode`: el worker pide step-up MFA para sumar un miembro
  (`test/seg-p1-teams-mfa.test.mjs`; el contrato de `pasada2-contratos` ahora incluye `/members`).

### Pasadas 2026-09-30 (resumen y complemento)

> Revisión y fix posteriores a la ronda 3 (`analisis-outbox/2026-09-29-mesa-mejoras/03-pasadas-2026-09-30.md`). Las pasadas 1, 2, 3 y 5 tienen su entrada propia
> abajo; acá va lo que no estaba registrado (pasada 4 y gates). Tests al cierre: **255 pass**.

#### Fixed — pasada 4
- `outbox_get_blocks` y `outbox_read_comments` recortan conservando lo más nuevo
  (`_truncated.dropped:'oldest'`); `outbox_get_blocks` acepta `blockId` e `includeHtml` y omite el HTML
  cuando no entra (`htmlOmitted`).
- La `idempotencyKey` (también la generada por el MCP) viaja en el error de una escritura tras un timeout
  o `idempotency_in_progress`.
- Las invariantes cross-repo fallan en CI en vez de saltearse (`test/siblings.mjs`,
  `OUTBOX_REQUIRE_SIBLINGS=1`, checkout de `out-box` en `ci.yml`).

#### Fixed — gates
- `outbox_pull` devuelve `version` (de `x-outbox-version` del mismo response); las instructions y
  `expectedVersion` piden tomarla de ahí o leerla antes del contenido (gate 4).
- `outbox_list_keys` traduce el 403 de inventario a `keys_list_forbidden`; caso propio para
  `daily_not_found`; `concurrent_update` expone `retryAfter` (gate 4).
- `record.ownerBrowser` como reporte no confiable; aviso de `previousRender` en `outbox_publish`; aviso de
  terceros de `outbox_pull` localizado; `z` exportado (gate 1). `PLAN_LIMIT_CODES` exportado, fix para
  `slug_not_allowed` y mensajes de zod bilingües (gate 2).
- `outbox_go_live` documenta `previewSkipped:'missing_share_scope'` (gate 5).
- CI: job `remote-compat` que corre el check de out-box-mcp-remote cuando cambia `src/**` (gate 1).

### Fixed — pasada 5, 2026-09-30
- **`outbox_append`: `title` y `visibility`**: la descripción (ES y EN del connector remoto) decía que se
  aplicaban "solo si se crea la página". El worker los aplica en CADA append al documento del día
  (last-write-wins). **Corregido en el gate de la pasada 5:** el worker pasó a heredar `visibility` y
  `title` del día anterior cuando el primer append del día no los manda (private si no hay día anterior);
  el texto ES/EN y el test de contrato sobre `dailyAppendRMW` reflejan esa herencia.
- **Test de slugs de ejemplo**: el port de las reservas del worker (`RESERVED_SLUG_SUFFIXES`,
  `RESERVED_SLUG_FIRST_SEGMENTS` y las colas `comments/<id>/accept|discard|resolve` y `blocks/blk_*`) ahora se
  compara contra `worker/src/lib/slug.ts`; antes era una copia a mano que nada verificaba.

### Fixed — pasada 3, 2026-09-30
- **Capabilities cacheadas tras un fallo**: `getCapabilities` guardaba para toda la sesión un `null` ante un
  blip (red, 429, 5xx, portal cautivo). Eso apagaba el reintento idempotente y el `expectedVersion` atómico.
  Ahora esos fallos no se cachean y la próxima llamada los vuelve a pedir; sí se cachean el OK y un 4xx
  definitivo (back viejo sin el endpoint).
- **Aviso de render**: `outbox_publish` nombraba `outbox_render_status` aunque el host no la registrara
  (stdio sin el toolset `library`, connector remoto). Ahora el texto depende de si la tool está en
  `tools/list`: si no está, pide revisar la página en el navegador (en el stdio, además, sugiere activar
  `library`).
- **Escaneo de secretos visible**: `outbox_publish`, `outbox_publish_from_template` y `outbox_append`
  aceptan `rejectOnSecrets` (422 `secrets_detected` sin escribir nada). Si el 200 trae `warnings.secrets`,
  se suma un aviso aparte (ES/EN) con tipo y línea, nunca el valor, que pide avisarle al usuario. El 422
  tiene su propio `fix` y trae `secrets` redactados. Se agregó la regla 10 de las instructions.
- **`hint` del back**: `describeError` lo expone como `hint` y lo usa como `fix` cuando el error no tiene un
  caso propio (salvo 401, 403 con scope, 413, 429 y 5xx). `oauth_key_not_rotatable` y `key_expired` (409)
  tienen casos propios y no reintentables. Antes el `fix` decía «releé el recurso antes de reintentar».
- **Versiones del release**: el step de `release.yml` y un test comprueban que coincidan `package.json`,
  `SERVER_VERSION` y `server.json` (`version` y `packages[].version`).

### Fixed — gate de la pasada 2, 2026-09-30
- `describeError` ante un error de red en una escritura ya no afirma que el append del daily y los
  comentarios duplican (capabilities los lista en `features.idempotencyEndpoints`).
- 403 `slug_not_allowed` (key con `slugWhitelist`) tiene su propio `fix` y línea en `formatError`.
- `PLAN_LIMIT_CODES` se exporta (lo reusa out-box-mcp-remote).
- Los mensajes custom de zod en `src/tools.ts` pasan a bilingües (`español. / English.`), como los de
  `schemas.ts`: el connector remoto los mostraba solo en español. Test guarda en `test/helpers.test.mjs`.
- `npm test`: 190 pass.

### Fixed — pasada 2 (ronda 4), 2026-09-30
- **`outbox_gen_team_key` y MFA**: la tool no aceptaba `mfaCode`, pero su error `step_up_required` le pedía
  al agente reintentar con él (zod lo descartaba y el agente quedaba en loop pidiendo códigos TOTP). Suma
  `mfaCode` al schema y al body de `POST /api/teams/:handle/keys`. Test de contrato: toda tool que pega a un
  endpoint con `requireRecentMfa` declara `mfaCode`.
- **409 reintentables**: `describeError` respeta `retryable: true` del back y tiene casos para
  `idempotency_in_progress` (esperar `Retry-After` y reintentar con la MISMA `idempotencyKey`) y
  `concurrent_update` (reintentar una vez). `send()` espera `Retry-After` (máx 2 s, hasta 5 veces) cuando un
  request con `Idempotency-Key` recibe `idempotency_in_progress`, en vez de devolver el conflicto.
  `OutboxApiError.retryAfter` guarda el header. `OutboxClient` acepta `sleep` inyectable.
- **Timeout vs marcador de idempotencia**: publish y publish-from-template pasan a
  `IDEMPOTENT_WRITE_TIMEOUT_MS` = 45 s (antes 60 s = TTL del marcador `pending` del worker, así que el
  reintento tras un timeout podía ejecutar el publish dos veces). Upload sigue en 60 s.
- **Ejemplo de slug de `outbox_append`**: era `daily/…`, namespace reservado (400 `reserved_slug`). Ahora
  `journal` / `work/log` en ambos idiomas, con la aclaración de qué está reservado.
- **413 de límites fijos** (`block_too_large`, `upload_too_large`, `anchor_too_large`, …): el `fix` ya no
  sugiere subir de plan y el error estructurado lleva `maxBytes` / `limit` / `bytes`. El consejo de plan
  queda para los códigos de plan (`html_too_large`, `storage_limit`) o con bloque CTA.
- **`server.json`**: `OUTBOX_TOOLSETS` lista el toolset `apps`. Tests: **186**.

### Fixed — pasada 1, 2026-09-30
- **Reintentos que duplicaban escrituras**: `send()` reintentaba ante una falla de red si el back
  anunciaba el flag global `features.idempotency`, pero el worker solo deduplica publish y
  publish-from-template. `outbox_append`, `outbox_create_comment` y `outbox_create_suggestion` podían
  duplicar el bloque o el comentario. Ahora cada request declara `idempotencyOp` y solo se reintenta si esa
  operación figura en `features.idempotencyEndpoints` (`OutboxClient.supportsIdempotency(op)`). Las
  descripciones, el `fix` de los errores de red y las instructions ya no prometen dedupe por clave en append
  ni en comentarios.
- **`outbox_append` y `model`**: el worker exige `model` en el primer append de cada día UTC (400
  `missing_model`) y la tool no lo aceptaba. Suma `model` (default `outbox-mcp`), `summary` y `contentType`.
- **Tags**: el schema de `outbox_publish` / `outbox_publish_from_template` pasa a máx 20 tags de 1-50
  caracteres `[A-Za-z0-9._-]` (antes 50 de 64 con cualquier carácter, que el back descartaba en silencio).
- `model` valida el charset del back (`[A-Za-z0-9_\-./:]`, máx 64). Tests: **165**.

> Todo lo posterior a 0.2.0 sigue sin release: el paquete no está publicado en npm
> (404, verificado 2026-07-18). Los ítems fechados 2026-07-18 están además **sin commitear**.

### Added — ronda 3, 2026-09-30
- `outbox_render_status {slug, user?, version?}` → `GET /api/render-report/...`: estado de render de una
  versión; `rollbackHint` solo si `suggestRollback` y el reporte es del owner; el reporte de visitantes
  va en `untrustedVisitorReport`. Toolset `library`, read-only.
- `outbox_page_data {slug, user?, after?, limit?}` → `GET /api/page-data/...`: entradas de visitantes en
  `untrustedData` (nunca `data`) + `untrustedNotice`. Toolset `library`, read-only.
- Exports `registerSandboxPlatformTools`, `annotatePageData`, `annotateRenderStatus`,
  `SANDBOX_PLATFORM_TOOLS` y `PAGE_DATA_UNTRUSTED_NOTICE` (`src/tools/sandbox-platform.ts`), con textos
  ES y EN. Con `OUTBOX_TOOLSETS=all` son **67 tools**. Tests: **156**.

### Added — Ola 2 (MCP remoto + MCP Apps), 2026-09-30
- **Registro reutilizable**: las tools se mudaron de `src/index.ts` a `src/tools.ts`
  (`registerOutboxTools(host, client, opts)`): sin estado de módulo, sin filesystem (`opts.files`), sin
  imports del SDK y con elicitation inyectada (`opts.elicit`). `src/index.ts` queda como entry stdio.
  Lo consume el Worker nuevo `out-box-mcp-remote/` (mcp.out-box.dev) con el SDK v2 y OAuth.
- **Textos en inglés** (`src/tools-en.ts`, `opts.lang: "en"`) para las 24 tools del connector remoto:
  título, descripción y cada parámetro, factuales y sin instrucciones de conducta.
- **Toolset `apps`** (fuera del default): `outbox_show_page` (visor MCP App `ui://outbox/page-viewer.html`
  con metadata, versiones, comentarios abiertos y preview aislado; `structuredContent` siempre) y
  `outbox_page_preview` (solo-app). Recurso `text/html;profile=mcp-app` autocontenido.
- **`OutboxClient`**: opciones `apiBase`, `siteBase`, `fetch` y `clientHeader` (aditivas); manda
  `Outbox-Client: mcp/<versión>` y `Outbox-Contract: 1` (ARQ-10).
- Sin filesystem, `file_path`/`overwrite` no se publican en los schemas y un `file_path` recibido da
  `files_unavailable` (accionable).

### Fixed — Ola 2, ronda 3 de review (2026-09-30)
- `outbox_show_page` respeta AX-02 como `outbox_read_comments`: el texto de terceros (body, exact,
  replacement) va solo en `untrustedText` con `notice`, y los anónimos por share se omiten salvo
  `includeAnonymous` (`omittedAnonymous`). El visor lee `untrustedText`. Antes llegaba como `body` plano.
- `outbox_page_preview` solo se registra si el host soporta recursos `ui://` (sin visor, `visibility:
  ["app"]` no se respeta y el modelo veía hasta 400k de HTML duplicando `outbox_pull`).

### Changed — Ola 2, 2026-09-30
- **zod 4** (`^4.6.5`) en lugar de zod 3 (lo pide el SDK v2 del remoto; el SDK 1.x ≥1.23 lo acepta).
  `z.record` con clave explícita. Rango del SDK corregido a `^1.29.0` (antes `^1.13.0`).
- Tests: **148** (`test/ola2-tools.test.mjs`); `parseToolsets("all")` ahora son 8 toolsets.

### Fixed — cruce entre unidades, 2026-09-30
- **Step-up MFA (PEN-03)**: el worker ahora exige MFA reciente para rotar keys, emitirlas e
  instanciar agentes; por Bearer, siempre que la cuenta tenga MFA. `outbox_rotate_key`,
  `outbox_gen_agent_key` y `outbox_instantiate_agent` aceptan `mfaCode` opcional
  (`MFA_CODE_SCHEMA`: TOTP o recovery, que el agente le pide al usuario y nunca guarda), y
  `step_up_required` sale como error retryable con su `fix`.
- **`expectedVersion` atómico**: el worker anuncia `features.expectedVersion: true` (chequeo dentro
  del DO), así que el MCP deja de hacer su chequeo local (que exigía una key con `list`). El 409
  real trae `currentVersion`/`currentEtag`; el MCP los normaliza (antes leía `current`).
- Tests: **129** (`test/mesa-regresiones.test.mjs` suma los casos de step-up y del 409).

### Changed (BREAKING, pre-lanzamiento) — mesa 2026-09-29, aplicado 2026-09-30
- **Toolsets** (`OUTBOX_TOOLSETS`, AX-08): por default solo `core` + `comments` (22 tools, ~30 KB de
  `tools/list` contra 67 KB). `all` o una lista (`core,sharing,keys,…`) habilita el resto. Toda tool
  está clasificada en `src/toolsets.ts`; una tool sin toolset hace fallar el arranque.
- **Dedupe**: se sacan `outbox_read` (idéntica a `outbox_pull`) y `outbox_open` (sin red; la URL pública
  está en las instructions). Total: **63 tools**, **14 destructivas**.
- **`outbox_accept_suggestion` es destructiva** (`destructiveHint: true`) y pide confirmación mostrando
  `exact → replacement` **completos** (sin recortar, con `exactLength`/`replacementLength` y aviso si hay
  caracteres invisibles): por elicitation si el cliente la soporta; si no, devuelve un `preview` + `confirmToken`
  y exige `confirm: true` **con ese token** (atado a commentId+exact+replacement; si la sugerencia cambia, deja
  de servir). Si no entra completa en la confirmación → `suggestion_too_long_to_confirm` (AX-02).
- **`outbox_rotate_key` exige `keyId`** (shortKeyId de 8 hex).
- **`outbox_list`**: default `limit` 20, campos compactos (`fields: "full"` para el meta completo),
  `cursor`/`prefix`, respuesta `{ count, nextCursor, hasMore, posts }` (AX-06).
- Listados y metadata en **JSON compacto**; si no entran en 25k caracteres se recortan por ítems con
  `_truncated` (JSON válido), nunca a mitad de string.
- `outbox_upload`: `contentType` acotado a png/jpeg/gif/webp (SVG lo rechaza el back) y `file_path`.
- `outbox_append`: `label` máx 64 (el back rechaza más).

### Fixed — mesa 2026-09-29
- **DEVC-01 (crítico)** — `outbox_pull`/`outbox_read` leían el sitio público y con `SANDBOX_SERVE=on`
  recibían el **shell** (`<iframe src="/raw/…">`); re-publicarlo pisaba la página. Ahora la lectura es
  `GET /api/u/:u/:slug/export?format=html` y toda respuesta con `x-outbox-shell: on` (o el iframe
  `__ob_content`) se rechaza con `shell_response`. Páginas de otro usuario compartidas (grant, unlisted,
  org) caen a `/raw/` sin el content-agent inyectado.
- **DEVC-03** — `outbox_rotate_key` sin `keyId` rotaba la key del propio MCP (401 en todo hasta
  reconfigurar). Rotar/revocar la key activa (keyId de `/api/me`) se rechaza con `active_key_self_lockout`
  en `outbox_rotate_key`, `outbox_revoke_key` y `outbox_revoke_team_key`.
- **DEVC-08** — timeouts propios: 30 s (60 s en publish, publish-from-template y upload). Un corte
  mientras se lee el body (export/pull lentos) también sale como `network_timeout`.
- Revisión de la tanda: `outbox_pull format=markdown` sobre una página HTML (404
  `markdown_source_unavailable` del worker) ya no dice "no existe"; `stripSandboxAgent` solo quita el bloque
  si está exactamente donde lo inyecta el worker (no borra contenido que menciona el marcador); `file_path`
  valida los ancestros antes de crear directorios (un symlink intermedio no deja carpetas afuera);
  `trust` usa el valor que fija el back y deriva solo en comentarios legacy; `expectedVersion` distingue
  página legacy sin índice (`no_versions` → versión de export) y da `expected_version_unverifiable` si la
  key no puede leer privados.
- **AX-10** — el server arranca sin credencial (cada tool responde `missing_credential`;
  `outbox_capabilities` anda sin key). "fetch failed" pasa a `network_unreachable`/`network_timeout`
  con el host y qué revisar (red, proxy, `OUTBOX_API_BASE`).
- **AX-03** — `private_read_scope_required` y `cross_user_export_forbidden` con mensaje propio (antes:
  "no existe o no sos el owner"). README: `--verbs publish,list`.
- **AX-12** — descripción de `outbox_delete_folder` (solo borra la metadata; las páginas quedan), del
  regex de upload (sin SVG) y guía ante 429 alineada con la skill (esperar `retryAfter`, no en loop).
- Descripción de `outbox_create_comment`/`outbox_create_suggestion`: en public/unlisted comenta
  cualquier cuenta autenticada; el grant `comment` solo hace falta en privadas (y el MCP no manda `?share`).

### Added — mesa 2026-09-29
- **`instructions`** del server (AX-08/AX-02): loop leer → sumar → re-publicar, herencia de metadata al
  re-publicar, contenido de terceros = datos, confirmar destructivas, errores, `expectedVersion`,
  `file_path` y toolsets activos (`src/instructions.ts`).
- **Barandas anti prompt-injection** en `outbox_read_comments` (AX-02): `trust` por ítem
  (`owner|grant|authenticated|share-anon`), texto de terceros en `untrustedText`, aviso fijo, filtros
  `status`/`from`, anónimos por share omitidos salvo `includeAnonymous`. El HTML de otro usuario sale con
  un aviso en un bloque aparte.
- **Errores estructurados** (AX-03/AX-10/P7): `structuredContent: { error: { code, status, retryable, fix,
  missingScope?, missingAnyOf?, retryAfter?, upgradeCta? } }` + el mismo JSON en un segundo bloque.
- **`Idempotency-Key`** (AX-04) en publish, append, comentarios, sugerencias y publish-from-template
  (`idempotencyKey` opcional para reusarla al reintentar; si no, UUID por invocación). Reintento
  automático ante falla de red solo si el back anuncia `features.idempotency` (hoy no).
- **`expectedVersion`** en `outbox_publish` (AX-05): se manda al back y, mientras no anuncie
  `features.expectedVersion`, el MCP compara con `GET …/versions` antes de escribir → 409 `version_conflict`.
- **`file_path`** (P4) en `outbox_pull`, `outbox_export`, `outbox_export_library` (escritura) y
  `outbox_publish`, `outbox_upload` (lectura), confinado a `OUTBOX_FILES_DIR` (default `~/Outbox`).
- **Borrador** (P8): `draft` en `outbox_publish` y tool `outbox_go_live` (PUT `…/draft`, destructiva).
- `outbox_pull format=markdown` (AX-07): pide `export?format=markdown`; si el back no lo soporta,
  `markdown_source_unavailable`.
- Tests: `test/harness.mjs` (back simulado + server real), `test/mesa-regresiones.test.mjs`,
  `test/arranque.test.mjs`, `test/helpers.test.mjs`. Total **110 tests** (era 46).
- CI: `.github/workflows/ci.yml` (Node 22, build, test, `npm pack --dry-run`). `release.yml` pasa a
  Node 22 y pide provenance solo si el repo es público (QA-06).

### Fixed
- **2026-09-29** — **`outbox_export format=html` fallaba siempre**: el worker responde `text/html` crudo
  y `client.req()` hacía `JSON.parse` de todo 2xx ("Unexpected token '<'"). Nuevo `OutboxClient.reqText()`
  (mismo auth/errores que `req()`, sin parsear) usado por la rama html.
- **2026-09-29** — **`outbox_export format=json` truncaba el HTML autoritativo** (`contenido`) a 25k chars
  (`ok()`): un export → editar → re-publicar pisaba la página con HTML mutilado. Ahora va por `raw()`
  sin cap, igual que `outbox_pull`/`outbox_read` (BUGS-VALIDACION #7).
- **2026-09-29** — **`prefix` de `outbox_export_library` y `limit`/`prefix` de `outbox_search`**: se
  siguen mandando con los nombres que lee el worker (`/api/list?prefix=`, `/api/u/:u/search?q&limit&prefix`)
  y además se aplican en el cliente (borde de carpeta + tope). Un worker que ignore los params ya no
  puede hacer que el backup "de una carpeta" exporte la biblioteca entera ni que search devuelva de más.
  `export_library` marca `truncated` también cuando el corte por `limit` cae a mitad de página.
- **2026-09-29** — **`since` en epoch** (`outbox_recent`, `outbox_audit`): se normaliza a ISO UTC antes
  de mandarlo (helper puro `normalizeSince` en `src/filters.ts`; epoch de 13 dígitos ms o 10 dígitos s,
  ISO con `Z`/offset o fecha sola `YYYY-MM-DD`). Antes audit daba 400 `invalid_since` y recent devolvía
  TODO (el back compara strings). Un `since` que no es fecha, o es ambiguo (`2026`, `20260601`, ISO con
  hora sin zona, `2026-02-30`), da error accionable sin llamar al back.
- **2026-09-29** — **CTA de límite de plan**: un 403/413/429 con código de límite (`daily_docs_limit`,
  `daily_updates_limit`, `keys_limit`, `html_too_large`, `storage_limit`, `rate_limited`) ya no se
  informa como "falta scope". `formatError` dice que es un límite del plan y adjunta
  `upgradeCta: {"error","limit","used","tier","upgradeTo","ctaUrl"}` (worker `lib/limit-response.ts`)
  solo cuando el body trae ese bloque. Sin bloque: 413 `html_too_large` (publish.ts) se informa como
  límite del plan con el `message` del back, sin afirmar nada del upgrade; 429 `rate_limited` anti-spam
  de comments cae al 429 genérico y conserva `retryIn`.
  Los 400 suman el `message` del back cuando viene junto a `error`.
- **2026-09-29** — Catálogo de eventos de `outbox_create_webhook`: 5 eventos del worker (sumados
  `daily.appended` y `page.viewed`; antes se rechazaban en el cliente). La descripción ya no promete
  entrega "<= 1 min" (la cola se drena cada ~5 min).
- **2026-09-29** — `package.json`: rango del SDK `^1.6.1` → `^1.13.0` (`registerTool` existe desde
  1.12.0 y el campo `title` de su config desde 1.13.0; con 1.6-1.11 el server crasheaba al arrancar).
  Lockfile sigue en 1.29.0.
- **2026-09-29** — Descripciones alineadas con el back: `outbox_search` (busca en metadata, no en el
  HTML), `outbox_export` (se exportan posts `public` ajenos), `outbox_gen_team_key` (owner o miembro
  con `canManageKeys`).

### Added
- **2026-09-29** — `outbox_revoke_team_key` (DELETE `/api/teams/:handle/keys/:keyId`, `keyId` con
  `KEY_ID_SCHEMA`, `destructiveHint: true`): el MCP podía emitir company keys pero no revocarlas.
- **2026-09-29** — `outbox_webhook_events` (GET `/api/webhooks/events`): catálogo vivo de eventos.
- **2026-09-29** — `outbox_create_grant` acepta `permissions: ["view"] | ["comment"]` (default `view`);
  el back acepta `comment` desde la capa de comentarios y las tools de comentarios lo pedían.
- **2026-09-29** — Tests de contrato (`test/contract.test.mjs`): levantan el server real (`dist/`) por
  stdio con el Client del SDK contra un back HTTP simulado y verifican verbo/path/query/body/headers y
  la respuesta de las tools arregladas. `test/client.test.mjs`: `reqText`, CTA y `normalizeSince` con
  `fetch` mockeado. Total **46 tests** (era 11). Total: **64 tools**, **12 destructivas**.
- **2026-09-29** — `package.json` declara `"mcpName": "dev.out-box/mcp"` (el registry lo exige para
  verificar paquetes npm). `server.json` migrado al schema **2025-12-11** (camelCase: `websiteUrl`,
  `registryType`, `runtimeHint`, `environmentVariables`, `isRequired`, `isSecret`; sin `status`),
  validado con ajv contra el schema oficial.
- **2026-08-26 (sin commitear)** — **Simetría de revocación (gap de seguridad)**: 3 tools nuevas
  `outbox_revoke_share` (DELETE `/api/share/:token`), `outbox_revoke_grant` (DELETE `/api/grants/:id`)
  y `outbox_revoke_key` (POST `/admin/revoke` `{ keyId }`), todas `destructiveHint: true`. Cierran la
  asimetría: antes el MCP podía ABRIR accesos (crear share/grant/key) pero no CERRARLOS. Ids validados
  con schemas hex compartidos nuevos (`SHARE_TOKEN_SCHEMA` 32 hex, `GRANT_ID_SCHEMA` 16 hex,
  `KEY_ID_SCHEMA` 8 hex = `shortKeyId`), copiados verbatim del formato del backend. Total: **62 tools**
  (era 59), **11 destructivas** (era 8). Tests 11/11 + tsc limpio.
- **2026-08-26 (sin commitear)** — **Release workflow npm** (`.github/workflows/release.yml`): publica
  `@out-box/mcp` con `npm publish --provenance --access public` al pushear un tag `v0.2.*` (corre
  `npm ci` + `npm test` antes; `prepublishOnly` re-valida). Acciones de terceros pineadas a SHA.
  `publishConfig.provenance: true` en `package.json`. Requiere `NPM_TOKEN` en secrets + el scope
  `@out-box` en npm (human-gated).
- **2026-08-26 (sin commitear)** — `server.json` (manifiesto del MCP Registry oficial,
  `registry.modelcontextprotocol.io`) con namespace `dev.out-box/mcp` verificable por DNS TXT sobre
  `out-box.dev`. Listo para `mcp-publisher` (human-gated, NO publicado).
- **2026-08-26 (sin commitear)** — Archivo `LICENSE` (MIT, Jonathan Leiva); `package.json` ya declaraba
  MIT sin el archivo.
- **2026-07-18 (sin commitear)** — Primeros tests del repo: `test/paths.test.mjs` con `node:test`
  (sin infra extra). `npm run test` = `tsc` + `node --test` contra `dist/` (se testea lo que se
  shipea). Cubren `encodeSlugPath` per-segmento y los schemas anti-traversal
  (`SLUG_SCHEMA`/`PREFIX_SCHEMA`/`USER_SCHEMA`/`TEAM_HANDLE_SCHEMA`). 7/7 verde + typecheck limpio
  (verificado 2026-07-18).
- **Teams F1** (6 tools): `outbox_create_team`, `outbox_list_teams`, `outbox_list_team_members`,
  `outbox_add_team_member`, `outbox_remove_team_member`, `outbox_gen_team_key`, más publish-as-team
  (owner de un handle de equipo).
- Paridad con el CLI: `outbox_open` (URL pública canónica sin red) y `outbox_pull` (trae el HTML como
  string para transformar).
- `outbox_pause_webhook` y `outbox_pause_schedule` (pausar/reanudar sin borrar, POST `{ paused }` —
  nacieron como PATCH; migradas a POST en `88154ac` porque el back solo acepta POST).
- `outbox_list_team_keys` (listar company keys del equipo sin exponer el secret).
- Total: **59 tools** registradas (era 56 en 0.2.0; verificado 2026-07-18 con
  `grep -c registerTool src/index.ts`).

### Changed
- **2026-08-26 (sin commitear)** — Schemas inline endurecidos con los compartidos: `owner` de
  `outbox_publish` → `TEAM_HANDLE_SCHEMA`; `fromUser` de `outbox_instantiate_agent` → `USER_SCHEMA`
  (antes `z.string().min(1).max(64)` inline, contra la regla de `AGENTS.md`). Rechazan dot-segments
  igual que el resto de user/handle. Test dedicado agregado.
- **2026-07-18 (sin commitear)** — Extracción de `src/paths.ts`: `encodeSlugPath` (encode
  per-segmento) pasa a ser LA implementación compartida — antes estaba duplicada en `index.ts` y
  reimplementada inline en `services/client.ts`.
- **2026-07-18 (sin commitear)** — `SLUG_SCHEMA` aplicado a `outbox_pull`, `outbox_open` y
  `outbox_read_comments` (tenían `z.string().min(1).max(200)` laxo inline, sin anti-traversal).
- **2026-07-18 (sin commitear)** — Endurecimiento de `USER_SCHEMA` / `TEAM_HANDLE_SCHEMA`: regex
  `[a-z0-9-]{2,32}` copiado verbatim del backend (`USERNAME_RE`); el charset sin `.` bloquea
  dot-segments (`.`/`..`) que sobreviven a `encodeURIComponent` y podían reescribir segmentos de
  URL como `/api/teams/:handle/members/:user`. `TEAM_HANDLE` de las tools de teams (antes
  `z.string().min(1).max(64)`) ahora usa `TEAM_HANDLE_SCHEMA`.
- **2026-07-18 (sin commitear)** — `PREFIX_SCHEMA` en el campo `folder` de `outbox_gen_team_key`
  (antes string laxo; viaja en el body JSON, pero valida igual que los demás prefixes).

### Fixed
- **2026-07-18 (sin commitear)** — Folders anidados: `outbox_set_folder` y `outbox_delete_folder`
  encodeaban el prefix ENTERO con `encodeURIComponent` (`clientes/solera` → `clientes%2Fsolera`,
  que el back splitea como UN segmento → `400 invalid_prefix`). Ahora usan `encodeSlugPath`
  per-segmento.
- **2026-07-14** (`88154ac`) — `SLUG_SCHEMA`/`PREFIX_SCHEMA` validan slug/prefix con el regex
  path-slug del backend + refine anti `..` (cierra path traversal desde args de tools);
  `FREE_TEXT_SCHEMA` separado para `q`/`filename` (no rompe búsquedas). `outbox_pause_webhook` y
  `outbox_pause_schedule` migradas de PATCH a POST (contrato real del back).
- **2026-07-13** (`ddd2ffe`) — `outbox_upload` mandaba base64 en JSON pero `/api/uploads` espera
  multipart/raw bytes → todo upload fallaba; ahora respeta el contrato del worker. Además `ok()`
  ya no trunca a 25 000 chars las tools de contenido autoritativo (`outbox_pull`, `outbox_read`,
  export html/backup) — el truncado corrompía round-trips y backups.
- **2026-07-11** (`4e36606`) — `outbox_instantiate_agent` manda el shape de request que el back
  exige.
- **2026-07-11** (`897107c`) — `readHtml` encodea el slug per-segmento: `encodeURIComponent` del
  slug entero convertía `/` en `%2F` y rompía `outbox_read`/`outbox_pull` para todo slug
  jerárquico.

## [0.2.0] - 2026-06-14

### Added
- Tools de schedules, `rotate_key`, `usage`, webhooks.
- Markdown publish.
- `API_CONTRACT_VERSION = "1.0.0"` en `src/constants.ts` (contrato del API).

### Fixed
- `encodeSlugPath` para slugs anidados en paths.

## [0.1.0]

### Added
- 24 tools base del MCP server (publish, list, read, append, share, grants, keys, templates…).
