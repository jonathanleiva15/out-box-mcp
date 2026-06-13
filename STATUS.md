# STATUS.md — @out-box/mcp

> Estado de **release** honesto y verificado. Última actualización: 2026-06-12.

## Versión

- **0.1.0** — consistente en `package.json` (`"version": "0.1.0"`) y `src/constants.ts`
  (`SERVER_VERSION = "0.1.0"`).
- 40 tools registradas (21 read, 11 write, 3 comment/owner, 1 sensible, 4 destructivo).

## Estado de publicación

- **NO publicado a npm.** `license: "UNLICENSED"` en `package.json`. El paquete todavía no se
  publicó al registry.
- **Rename de paquete `@outbox/mcp` → `@out-box/mcp`: PENDIENTE DE COMMIT.**
  - El working tree ya dice `@out-box/mcp` (`package.json`, `package-lock.json`, `README.md`
    modificados).
  - `git HEAD` todavía dice `@outbox/mcp` (commit `1fed682`).
  - ⚠️ El commit/push del rename es **paso de release del usuario** — NO commitear acá.
- **AUSENTE de `capabilities.clients` del back.** El back todavía no anuncia esta vía MCP en su
  endpoint público de capabilities. Un fix en el repo `out-box` lo está agregando.

## Arquitectura de acceso (las 3 vías)

CLI (`outbox`), skill (`outbox-publish`) y MCP (este paquete) usan **la misma API key** (`outbox_*`)
y el **mismo back** (`api.out-box.dev`). No hay credenciales ni endpoints separados por vía.

## Pendientes priorizados para cerrar el release

1. **Agregar el MCP a `capabilities.clients` del back** (fix en repo `out-box` en curso).
2. **Commit + push del rename** `@outbox/mcp → @out-box/mcp` (acción del usuario, no del agente).
3. **Definir licencia** antes de publicar (`UNLICENSED` bloquea publicación pública).
4. **Publicar a npm** como `@out-box/mcp` una vez resueltos 1–3, para que `npx -y @out-box/mcp`
   funcione sin instalación local.
5. **Smoke test post-publish** con MCP Inspector (`npm run inspector`) contra una key real.
