# Changelog — @out-box/mcp

Todos los cambios notables del MCP server de Outbox.
Formato [Keep a Changelog](https://keepachangelog.com/) + SemVer.
La versión vive en `package.json` y `src/constants.ts` (`SERVER_VERSION`), sincronizadas.

## [Unreleased]

> Todo lo posterior a 0.2.0 sigue sin release: el paquete no está publicado en npm
> (404, verificado 2026-07-18). Los ítems fechados 2026-07-18 están además **sin commitear**.

### Added
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
