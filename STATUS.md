# STATUS — out-box-mcp — stub repo-específico

> El estado del ecosistema completo vive en `../STATUS.md` de `Outboxmain\`
> (dashboard maestro, actualizado 2026-07-18). Acá solo lo local. Historia: git log.

**Qué es**: MCP server (stdio) de Outbox — expone el back `api.out-box.dev` como tools
para agentes: publish/pull/append, versionado, comentarios/sugerencias, folders, share,
teams, webhooks, schedules. Misma API key `outbox_*` que el CLI y la skill `outbox-publish`.

**Estado** (verificado 2026-07-18): v0.2.0 · 59 tools · stdio-only · typecheck limpio ·
SIN tests automatizados · NO publicado en npm (404) — el quickstart del README falla;
publicación es human-gated.

## Pendientes locales

1. **Paridad CLI↔MCP rota** (tras Teams): faltan ~25 tools — 18 de teams (delete/transfer/
   domains/billing/org-template) + keys gen/revoke, share/grants revoke, webhooks test,
   dailies, template CRUD, agents publish. Detalle: maestro, bug P2 #5.
2. **Bugs abiertos** (detalle en maestro): folders con `encodeURIComponent` del prefix
   entero → carpetas anidadas dan 400 (P1 #2) · `outbox_pull`/`outbox_open`/
   `outbox_read_comments` con `z.string()` plano en vez de `SLUG_SCHEMA` (P2 #4).
3. **Publicar a npm** como `@out-box/mcp` (decisión abierta en el maestro; human-gated).
4. **Smoke test post-publish** con MCP Inspector (`npm run inspector`) contra key real.
5. **Tests de contrato** (hoy 0): los 3 fixes de julio (897107c, ddd2ffe, 88154ac) eran
   detectables con tests. También en el checklist del maestro.

## Gotchas vigentes

- Slugs jerárquicos: encodear **per-segmento** (`encodeSlugPath`), nunca
  `encodeURIComponent` del path entero (fix 897107c; folders aún lo hace mal → bug #2).
- Pausar webhook/schedule es **POST** `{ paused }`, no PATCH (desde 88154ac; el
  CHANGELOG viejo aún documenta PATCH).
- No truncar el output de tools de contenido crudo (`outbox_pull`): un pull recortado
  que el agente re-publica pisa la página (ddd2ffe).
