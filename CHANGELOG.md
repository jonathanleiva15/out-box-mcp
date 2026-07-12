# Changelog — @out-box/mcp

Todos los cambios notables del MCP server de Outbox.
Formato [Keep a Changelog](https://keepachangelog.com/) + SemVer.
La versión vive en `package.json` y `src/constants.ts` (`SERVER_VERSION`), sincronizadas.

## [Unreleased]

### Added
- **Teams F1** (6 tools): `outbox_create_team`, `outbox_list_teams`, `outbox_list_team_members`,
  `outbox_add_team_member`, `outbox_remove_team_member`, `outbox_gen_team_key`, más publish-as-team
  (owner de un handle de equipo).
- Paridad con el CLI: `outbox_open` (URL pública canónica sin red) y `outbox_pull` (trae el HTML como
  string para transformar).
- `outbox_pause_webhook` y `outbox_pause_schedule` (pausar/reanudar sin borrar, PATCH `{ paused }`).
- `outbox_list_team_keys` (listar company keys del equipo sin exponer el secret).
- Total: **59 tools** registradas (era 56 en 0.2.0).

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
