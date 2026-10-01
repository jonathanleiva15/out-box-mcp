# STATUS — out-box-mcp — stub repo-específico

> El estado del ecosistema completo vive en `../STATUS.md` de `Outboxmain\`
> (dashboard maestro, actualizado 2026-10-01, ronda 4). Acá solo lo local. Historia: git log.

**Qué es**: MCP server (stdio) de Outbox — expone el back `api.out-box.dev` como tools
para agentes: publish/pull/append, versionado, comentarios/sugerencias, folders, share,
teams, webhooks, schedules. Misma API key `outbox_*` que el CLI y la skill `outbox-publish`.

**Estado** (verificado 2026-10-01, ronda 4): v0.2.0 (sin release) · **67 tools** en 8 toolsets (default
`core,comments` = 22 tools; `apps` = visor MCP App; `library` suma `outbox_render_status` y
`outbox_page_data`) · 32 read, 14 destructivas · binario stdio + registro
reutilizable (`src/tools.ts`, lo usa el MCP remoto `../out-box-mcp-remote/`) · **SDK v2**
(`@modelcontextprotocol/server` 2.2.0, ronda 4; Node 20+) + **zod 4** · `instructions` declaradas · typecheck limpio · **362 tests: 361 pass, 1 skip intencional** (unitarios + contrato contra back
simulado; gate final de la ronda 4, 2026-10-01. El skip es el port a mano de las reglas de slug, que no
corre porque existe el JSON canónico del worker. El gate cross-repo con los números de cada paquete
vive en `../analisis-outbox/2026-09-29-mesa-mejoras/05-ronda4-2026-10-01.md` §2) · NO publicado en npm (404) — el quickstart del README falla; publicación es human-gated.

Ronda 3 (2026-09-30): `outbox_render_status` (vigía de render, `rollbackHint` solo con reporte del owner)
y `outbox_page_data` (entradas de visitantes en `untrustedData`) en el toolset `library`; el MCP remoto
no las expone (no están en su `TOOL_SCOPE`).

Ola 2 (2026-09-30): `registerOutboxTools(host, client, opts)` (sin estado de módulo, sin fs, sin SDK),
textos EN para el remoto (`src/tools-en.ts`), `OutboxClient` con `apiBase`/`siteBase`/`fetch`/`clientHeader`
inyectables y header `Outbox-Client: mcp/<v>` + `Outbox-Contract: 1` (ARQ-10), toolset `apps` con
`outbox_show_page` + `outbox_page_preview` (MCP App `ui://outbox/page-viewer.html`, también por stdio).

Tanda 2026-09-30 (mesa 2026-09-29): lectura canónica por `/export` y rechazo del shell (DEVC-01),
guardas de auto-bloqueo de keys (DEVC-03), timeouts (DEVC-08), barandas anti prompt-injection en
comentarios + `accept_suggestion` destructiva con confirmación completa y `confirmToken` (AX-02), errores estructurados (AX-03/10),
`Idempotency-Key` (AX-04, el worker todavía no la usa), `expectedVersion` (AX-05), `outbox_list` paginado
y compacto (AX-06), instructions + toolsets + dedupe read/open (AX-08), `file_path` (P4), borrador
`draft` + `outbox_go_live` (P8), arranque sin credencial (AX-10). Cruce del 2026-09-30: `mfaCode` en
rotate/gen-agent/instantiate (step-up PEN-03) y 409 con `currentVersion` normalizado.

## Pendientes locales

1. **Paridad CLI↔MCP**: faltan teams (delete/transfer/domains/billing/groups/org-template,
   `PATCH members`), `comments/:id/resolve`, `webhooks/:id/test`, dailies (list, borrar bloque),
   template CRUD, `PUT /api/u/:u/agents`, shares update/passphrase, `keys/revoke-bulk`.
2. **Publicar a npm** como `@out-box/mcp` (human-gated) + `mcp-publisher` con `server.json`
   (ya en schema 2025-12-11) y verificación DNS de `dev.out-box`. Provenance: el workflow la pide solo
   si el repo es público (hoy es privado).
3. **Smoke test post-publish** con MCP Inspector (`npm run inspector`) contra key real.
4. **Idempotencia vs worker**: resuelto del lado del MCP (pasada 1, 2026-09-30): el cliente reintenta
   solo las operaciones que el back lista en `features.idempotencyEndpoints` (`supportsIdempotency(op)`).
   Hoy append y comentarios no se reintentan; se activan solos cuando el worker cablee `withIdempotency`
   ahí y los liste como `dailyAppend` / `comment` (AX-04, pendiente del worker). Ya resueltos en
   el código del worker (sin deployar): `features.expectedVersion` + 409 atómico, `export?format=markdown`
   (AX-07), la herencia de metadata al re-publicar (AX-01) y el rollback que no re-expone (conviene que
   `outbox_rollback` muestre `notRestored` y ofrezca `restoreVisibility`). Mientras `api.out-box.dev`
   sirva el build viejo, nada de eso está vivo.
5. **Versión**: subir 0.2.0 → 0.3.0 antes del release (cambios incompatibles: tools eliminadas,
   `keyId` obligatorio en rotate, forma nueva de `outbox_list`, `confirmToken`). Decidir si el repo
   pasa a público (provenance) y el default de toolsets (`core,comments`).
6. **Ola 2 (resto)**: el stdio ya corre sobre el SDK v2 (ronda 4) pero sirve solo la era 2025
   (`initialize`, transporte cableado a mano). Servir 2026-07-28 por stdio (`serveStdio`) exige pasar la
   elicitation de `outbox_accept_suggestion` a `inputRequired` (multi-round-trip): con `elicitInput`
   push-style tira en la era nueva. Falta `outputSchema` en lecturas, `resource_link`, `outbox_connect`
   por device flow (después de PEN-02) y textos EN del resto de toolsets. `outbox_pull` por trozos ya
   está (opt-in con `offset`/`maxChars`).
   El visor MCP App no está probado en un host real (Claude): ver `../out-box-mcp-remote/STATUS.md`.
7. Menores: validar `OUTBOX_API_BASE`/`SITE_BASE` (https) y usar el `apiBase` del rc;
   `API_CONTRACT_VERSION` muerta; ids de webhook/schedule con `z.string()`; evals placeholder (P12:
   harness real con miniflare).

## Gotchas vigentes

- Slugs jerárquicos: encodear **per-segmento** (`encodeSlugPath`), nunca
  `encodeURIComponent` del path entero (fix 897107c; folders también, ya corregido).
- Pausar webhook/schedule es **POST** `{ paused }`, no PATCH (desde 88154ac).
- **Leer contenido = `/api/u/:u/:slug/export?format=html`**, nunca el sitio público (shell sandbox).
  Respuesta con `x-outbox-shell: on` → error `shell_response`.
- No truncar el output de tools de contenido crudo (`outbox_pull`, `outbox_export` json y html,
  `outbox_export_library`): un contenido recortado que el agente re-publica pisa la página. Para
  contenido grande, `file_path`.
- Endpoints que no responden JSON en 2xx → `client.reqText()`, nunca `client.req()`.
- `since` siempre por `normalizeSince` (el back compara ISO como string). Solo acepta formas no
  ambiguas: `YYYY-MM-DD`, ISO con `Z`/offset, epoch de 13 (ms) o 10 (s) dígitos.
- `upgradeCta` solo si el body trae el bloque (`upgradeTo` + `tier`): el 413 `html_too_large` de
  publish y el 429 `rate_limited` anti-spam de comments NO lo traen.
- Filtros que el back podría ignorar (`prefix`, `limit`) se re-aplican en el cliente.
- Toda tool nueva va en `TOOL_TOOLSET` (`src/toolsets.ts`) o el server no arranca.
