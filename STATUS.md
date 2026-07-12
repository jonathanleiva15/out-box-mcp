# STATUS.md — @out-box/mcp

> Estado de **release** honesto y verificado. Última actualización: 2026-07-12.

## Versión

- **0.2.0** — consistente en `package.json` (`"version": "0.2.0"`) y `src/constants.ts`
  (`SERVER_VERSION = "0.2.0"`).
- **59 tools registradas.** (incluye `outbox_pull` y `outbox_open`, las tools
  read-only que acompañan los comandos `pull`/`open` del CLI: `outbox_pull` trae el
  HTML como string para transformar, `outbox_open` deriva la URL pública canónica sin
  pegarle al back.) Bump 0.1.0 → 0.2.0 (2026-06-14): se cerró la paridad
  con el CLI sumando **schedules** (`outbox_create_schedule` / `outbox_list_schedules`
  / `outbox_delete_schedule`, cron → webhook), **rotación de keys**
  (`outbox_rotate_key`, POST /api/keys/rotate, scope `genkey`) y **consumo/cuota**
  (`outbox_usage`, GET /api/me/usage). Paridad CLI ↔ MCP total. Incluye además la capa
  de **comentarios/sugerencias** del roadmap batch 1 (`outbox_read_comments`,
  `outbox_create_comment`, `outbox_create_suggestion`, `outbox_accept_suggestion`,
  `outbox_discard_suggestion`).

## Estado de publicación

- **NO publicado a npm.** El paquete todavía no se publicó al registry.
- **Licencia: `MIT`** (`license: "MIT"` en `package.json`). Ya no bloquea la publicación pública.
- **Rename de paquete `@outbox/mcp` → `@out-box/mcp`: ✅ COMPLETADO.**
  - Ya commiteado: `package.json`, `package-lock.json` y `README.md` dicen `@out-box/mcp`
    (verificado contra HEAD).
  - Falta solo publicar a npm con el nombre nuevo (ver pendientes).
- **AUSENTE de `capabilities.clients` del back.** El back todavía no anuncia esta vía MCP en su
  endpoint público de capabilities. Un fix en el repo `out-box` lo está agregando.

## Arquitectura de acceso (las 3 vías)

CLI (`outbox`), skill (`outbox-publish`) y MCP (este paquete) usan **la misma API key** (`outbox_*`)
y el **mismo back** (`api.out-box.dev`). No hay credenciales ni endpoints separados por vía.

## Pendientes priorizados para cerrar el release

1. **Agregar el MCP a `capabilities.clients` del back** (fix en repo `out-box` en curso).
2. ~~**Commit + push del rename** `@outbox/mcp → @out-box/mcp`~~ ✅ resuelto: ya en HEAD.
3. ~~**Definir licencia**~~ ✅ resuelto: `MIT` en `package.json`.
4. **Publicar a npm** como `@out-box/mcp` una vez resuelto 1, para que `npx -y @out-box/mcp`
   funcione sin instalación local.
5. **Smoke test post-publish** con MCP Inspector (`npm run inspector`) contra una key real.
