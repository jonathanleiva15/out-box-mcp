# STATUS.md — @out-box/mcp

> Estado de **release** honesto y verificado. Última actualización: 2026-06-14.

## Versión

- **0.2.0** — consistente en `package.json` (`"version": "0.2.0"`) y `src/constants.ts`
  (`SERVER_VERSION = "0.2.0"`).
- **54 tools registradas.** (48 de la línea Teams v2 + las 6 tools de equipos/org de
  Teams F1, que ya vivían en el código aunque el README listaba 48; ahora el doc
  refleja las 54 reales.) Bump 0.1.0 → 0.2.0 (2026-06-14): se cerró la paridad
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
- **Rename de paquete `@outbox/mcp` → `@out-box/mcp`: PENDIENTE DE COMMIT.**
  - El working tree ya dice `@out-box/mcp` (`package.json`, `package-lock.json`, `README.md`
    modificados).
  - ⚠️ El commit/push del rename es **paso de release del usuario** — NO commitear acá.
- **AUSENTE de `capabilities.clients` del back.** El back todavía no anuncia esta vía MCP en su
  endpoint público de capabilities. Un fix en el repo `out-box` lo está agregando.

## Arquitectura de acceso (las 3 vías)

CLI (`outbox`), skill (`outbox-publish`) y MCP (este paquete) usan **la misma API key** (`outbox_*`)
y el **mismo back** (`api.out-box.dev`). No hay credenciales ni endpoints separados por vía.

## Pendientes priorizados para cerrar el release

1. **Agregar el MCP a `capabilities.clients` del back** (fix en repo `out-box` en curso).
2. **Commit + push del rename** `@outbox/mcp → @out-box/mcp` (acción del usuario, no del agente).
3. ~~**Definir licencia**~~ ✅ resuelto: `MIT` en `package.json`.
4. **Publicar a npm** como `@out-box/mcp` una vez resueltos 1–2, para que `npx -y @out-box/mcp`
   funcione sin instalación local.
5. **Smoke test post-publish** con MCP Inspector (`npm run inspector`) contra una key real.
