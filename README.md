# @out-box/mcp — Outbox MCP server

Server MCP oficial de **[Outbox](https://out-box.dev)** (out-box.dev), la biblioteca privada
**agents-first** para publicar HTMLs. Expone Outbox como **herramientas nativas** para cualquier
cliente MCP (Claude Desktop, Cursor, etc.) — sin curl ni CLI.

Es una de las **3 vías** para usar Outbox desde un agente:
- **CLI** (`outbox …`) — comandos shell.
- **skill** `outbox-publish` — para agentes con skills.
- **MCP** (este paquete) — tools nativas en clientes MCP.

## Instalación (local, stdio)

> ⚠️ **El paquete todavía NO está publicado en npm** (`@out-box/mcp` → 404, verificado 2026-07-18).
> El config con `npx -y @out-box/mcp` de más abajo **no funciona aún** — quedará como la vía
> recomendada cuando se publique. **Hoy la vía que SÍ funciona** es correr el server desde el
> repo clonado (ver "Instalación desde el repo").

Solo necesitás tu **API key** de Outbox (`outbox_*`).

### Instalación desde el repo (la vía que funciona hoy)

```bash
git clone https://github.com/jonathanleiva15/out-box-mcp.git
cd out-box-mcp
npm install
npm run build        # compila a dist/
```

Y apuntá tu config de MCP (`claude_desktop_config.json`) al build local:

```json
{
  "mcpServers": {
    "outbox": {
      "command": "node",
      "args": ["/ruta/absoluta/al/repo/out-box-mcp/dist/index.js"],
      "env": {
        "OUTBOX_API_KEY": "outbox_xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

Alternativa: `npm link` dentro del repo registra el bin `outbox-mcp` globalmente, y en el config
usás `"command": "outbox-mcp"` sin `args`.

### Claude Desktop / Cursor — vía `npx` (cuando el paquete se publique)

No requiere instalar nada global: el cliente MCP lo lanza con `npx`.

```json
{
  "mcpServers": {
    "outbox": {
      "command": "npx",
      "args": ["-y", "@out-box/mcp"],
      "env": {
        "OUTBOX_API_KEY": "outbox_xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

> 💡 **Tip de seguridad (entornos cloud/compartidos):** usá una **agent key acotada a una carpeta**
> (`outbox keys gen-agent --folder <carpeta> --verbs publish --days 30`). Si el entorno se filtra,
> el blast radius es esa sola carpeta.

## Autenticación

Precedencia de la key:
1. `OUTBOX_API_KEY` (variable de entorno) — recomendado.
2. `~/.outboxrc` — el archivo que escribe el CLI con `outbox login`.

La key **nunca** se loguea. El server **no** escribe `~/.outboxrc` (eso lo hace el CLI). En sesiones
remotas/headless el agente **no puede hacer login interactivo** → por eso la auth es por key.

### Variables de entorno

Todas son opcionales salvo la credencial (`OUTBOX_API_KEY` **o** `~/.outboxrc`).

| Variable | Default | Para qué |
|---|---|---|
| `OUTBOX_API_KEY` | — | La API key `outbox_*` (recomendado). Si está, tiene precedencia sobre `~/.outboxrc`. |
| `OUTBOX_USER` | (de `~/.outboxrc` o `/api/me`) | Username del owner, para defaultear el arg `user` de las tools sin pegarle a `/api/me`. |
| `OUTBOX_RC` | `~/.outboxrc` | Path alternativo al archivo de credencial que escribe el CLI (útil en entornos con otro `HOME`). |
| `OUTBOX_API_BASE` | `https://api.out-box.dev` | Base de la API (mutaciones, listados, gestión). |
| `OUTBOX_SITE_BASE` | `https://out-box.dev` | Base del sitio público para leer el HTML servido (`SITE_BASE/<user>/<slug>`, sin `/u/`). |

## Tools disponibles (59)

59 tools en total: **29 read**, **17 write**, **3 comment/owner**, **3 sensible**, **7 destructivo**.

| Tool | Qué hace | |
|---|---|---|
| `outbox_me` | Tu cuenta, tier, límites | read |
| `outbox_usage` | Consumo + cuota (publishes/hora-día, storage, keys) vs el tier | read |
| `outbox_list` | Listar páginas (tag, limit) | read |
| `outbox_list_tree` | Árbol de la biblioteca / compartido conmigo | read |
| `outbox_read` | Leer el HTML de una página (estado actual) | read |
| `outbox_pull` | Traer el contenido (HTML string) de una página, listo para transformar | read |
| `outbox_open` | URL pública canónica de una página (sin red) | read |
| `outbox_versions` | Historial de versiones | read |
| `outbox_get_blocks` | Bloques de un daily | read |
| `outbox_list_shares` | Share links activos | read |
| `outbox_list_keys` | API keys de la cuenta | read |
| `outbox_list_grants` | Grants user-to-user (dados / recibidos) | read |
| `outbox_folders` | Listar carpetas (count + visibility, árbol opcional) | read |
| `outbox_export` | Exportar un post (json estructurado / html crudo) | read |
| `outbox_export_library` | Exportar TODA la biblioteca como JSON (backup / portabilidad) | read |
| `outbox_capabilities` | Capacidades del back (público, auto-descubrimiento) | read |
| `outbox_read_comments` | Comentarios y sugerencias de una página (anotaciones) | read |
| `outbox_recent` | Cambios recientes de la biblioteca (`since`, `prefix`, `slug`) | read |
| `outbox_search` | Búsqueda full-text sobre tu biblioteca (`q`) | read |
| `outbox_diff` | Diff de una página entre dos versiones (`from`/`to`) | read |
| `outbox_access` | Quién puede acceder a una página y cómo (blast radius) | read |
| `outbox_audit` | Log de auditoría de la cuenta (`limit`, `since`) | read |
| `outbox_templates` | Catálogo de content-templates con sus schemas | read |
| `outbox_agents_registry` | Registry de agentes instanciables (descubrimiento) | read |
| `outbox_list_webhooks` | Event webhooks registrados (sin exponer el secret) | read |
| `outbox_list_schedules` | Schedules (cron → webhook) registrados | read |
| `outbox_list_teams` | Equipos (orgs) de los que sos miembro (handle, role) | read |
| `outbox_list_team_members` | Miembros de un equipo (user, role, canManageKeys?) | read |
| `outbox_list_team_keys` | Company keys emitidas de un equipo (sin exponer el secret) | read |
| `outbox_publish` | Publicar `html` crudo o `markdown` (`model` obligatorio) | write |
| `outbox_publish_from_template` | Publicar desde template + data JSON (`model` obligatorio) | write |
| `outbox_append` | Agregar un bloque a un daily | write |
| `outbox_set_visibility` | private / unlisted / public | write |
| `outbox_set_folder` | Setear visibility de una carpeta (PUT) | write |
| `outbox_set_style` | Cambiar brand preset (paper, minimal, …) | write |
| `outbox_create_share` | Crear link público (con expiración) | write |
| `outbox_create_grant` | Dar acceso de lectura a otro usuario | write |
| `outbox_create_comment` | Comentar / responder en un hilo (anotaciones, no edita HTML) | write |
| `outbox_upload` | Subir una imagen → URL content-addressed (scope `upload`) | write |
| `outbox_instantiate_agent` | Instanciar un agente del registry (emite agent key) | write |
| `outbox_create_webhook` | Registrar un event webhook firmado (comment/version/published) | write |
| `outbox_pause_webhook` | Pausar / reanudar un event webhook (sin borrarlo) | write |
| `outbox_create_schedule` | Crear un schedule (cron UTC → POST a tu webhook) | write |
| `outbox_pause_schedule` | Pausar / reanudar un schedule (sin borrarlo) | write |
| `outbox_create_team` | Crear un equipo/org bajo un handle propio (sos owner) | write |
| `outbox_add_team_member` | Sumar un miembro al equipo (owner-only, rol 'member') | write |
| `outbox_create_suggestion` | Proponer un cambio de texto (anchor + replacement) | comment |
| `outbox_accept_suggestion` | Aceptar una sugerencia (publica versión nueva) | owner |
| `outbox_discard_suggestion` | Descartar una sugerencia o comentario | owner |
| `outbox_gen_agent_key` | Emitir agent key folder-scoped (delegación) | ⚠️ sensible |
| `outbox_rotate_key` | Rotar una API key (revoca la vieja, emite nueva; plaintext 1 vez) | ⚠️ sensible |
| `outbox_gen_team_key` | Emitir company key del equipo (owner-only; plaintext 1 vez) | ⚠️ sensible |
| `outbox_rollback` | Revertir a una versión | ⚠️ destructivo |
| `outbox_squash` | Compactar el historial de versiones | ⚠️ destructivo |
| `outbox_delete` | Eliminar una página | ⚠️ destructivo |
| `outbox_delete_folder` | Eliminar la metadata de una carpeta | ⚠️ destructivo |
| `outbox_delete_webhook` | Borrar un event webhook | ⚠️ destructivo |
| `outbox_delete_schedule` | Borrar un schedule | ⚠️ destructivo |
| `outbox_remove_team_member` | Quitar un miembro del equipo (owner-only) | ⚠️ destructivo |

> **`model` es obligatorio** en `outbox_publish` y `outbox_publish_from_template` (contrato B8 del
> back: si falta, responde `400 missing_model`). Es el id del modelo que generó el contenido.

> **Comentarios y sugerencias** (flujo agents-first): el agente lee el texto (`outbox_read` /
> `outbox_export`), propone un cambio con `outbox_create_suggestion` (el texto exacto a reemplazar +
> el `replacement`), y el **owner** lo acepta (`outbox_accept_suggestion` o desde el widget) → se aplica
> como versión nueva atribuida. El ancla matchea por **texto visible** (tag-aware): el back compara el
> texto del anchor contra el contenido visible aunque haya tags/entidades en el medio. El HTML NUNCA se
> modifica por comentar. Un agente que NO es del owner necesita un grant `comment` (o un `?share` token).

> **`outbox_accept_suggestion` no siempre publica `vN+1`.** La respuesta es `{ ok, comment, version, noChange }`.
> Si el reemplazo **no cambia** el HTML resultante, el back aplica un **no-op guard**: devuelve
> `{ ..., noChange: true }`, marca la sugerencia como aceptada y **NO crea una versión nueva**. Solo cuando el
> HTML efectivamente cambia se publica `vN+1`.

## Desarrollo

```bash
npm install
npm run build          # compila a dist/
npm run test           # build + tests unitarios (node --test contra dist/)
npm run inspector      # probar con MCP Inspector
```

## Lectura del contenido

El HTML se sirve desde el sitio público `out-box.dev/<user>/<slug>` (no desde la API, y **sin** `/u/`).
Para páginas privadas, la key debe ser del owner.
