# Changelog — @out-box/mcp

Todos los cambios notables del MCP server de Outbox.
Formato [Keep a Changelog](https://keepachangelog.com/) + SemVer.
La versión vive en `package.json` y `src/constants.ts` (`SERVER_VERSION`), sincronizadas.

## [Unreleased]

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
