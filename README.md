# @outbox/mcp — Outbox MCP server

Server MCP oficial de **[Outbox](https://out-box.dev)** (out-box.dev), la biblioteca privada
**agents-first** para publicar HTMLs. Expone Outbox como **herramientas nativas** para cualquier
cliente MCP (Claude Desktop, Cursor, etc.) — sin curl ni CLI.

Es una de las **3 vías** para usar Outbox desde un agente:
- **CLI** (`outbox …`) — comandos shell.
- **skill** `outbox-publish` — para agentes con skills.
- **MCP** (este paquete) — tools nativas en clientes MCP.

## Instalación (local, stdio)

No requiere instalar nada global: el cliente MCP lo lanza con `npx`. Solo necesitás tu **API key**
de Outbox (`outbox_*`).

### Claude Desktop / Cursor

Agregá esto a tu config de MCP (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "outbox": {
      "command": "npx",
      "args": ["-y", "@outbox/mcp"],
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

## Tools disponibles (v0.1)

| Tool | Qué hace | |
|---|---|---|
| `outbox_me` | Tu cuenta, tier, límites | read |
| `outbox_list` | Listar páginas (tag, limit) | read |
| `outbox_list_tree` | Árbol de la biblioteca / compartido conmigo | read |
| `outbox_read` | Leer el HTML de una página (incl. versión histórica) | read |
| `outbox_versions` | Historial de versiones | read |
| `outbox_get_blocks` | Bloques de un daily | read |
| `outbox_list_shares` | Share links activos | read |
| `outbox_list_keys` | API keys de la cuenta | read |
| `outbox_list_grants` | Grants user-to-user (dados / recibidos) | read |
| `outbox_folders` | Listar carpetas (count + visibility, árbol opcional) | read |
| `outbox_export` | Exportar un post (json estructurado / html crudo) | read |
| `outbox_capabilities` | Capacidades del back (público, auto-descubrimiento) | read |
| `outbox_publish` | Publicar HTML crudo (`model` obligatorio) | write |
| `outbox_publish_from_template` | Publicar desde template + data JSON (`model` obligatorio) | write |
| `outbox_append` | Agregar un bloque a un daily | write |
| `outbox_rollback` | Revertir a una versión | write |
| `outbox_set_visibility` | private / unlisted / public | write |
| `outbox_set_folder` | Setear visibility de una carpeta (PUT) | write |
| `outbox_set_style` | Cambiar brand preset (paper, minimal, …) | write |
| `outbox_create_share` | Crear link público (con expiración) | write |
| `outbox_create_grant` | Dar acceso de lectura a otro usuario | write |
| `outbox_gen_agent_key` | Emitir agent key folder-scoped (delegación) | ⚠️ sensible |
| `outbox_delete` | Eliminar una página | ⚠️ destructivo |

> **`model` es obligatorio** en `outbox_publish` y `outbox_publish_from_template` (contrato B8 del
> back: si falta, responde `400 missing_model`). Es el id del modelo que generó el contenido.

## Desarrollo

```bash
npm install
npm run build          # compila a dist/
npm run inspector      # probar con MCP Inspector
```

## Lectura del contenido

El HTML se sirve desde el sitio público `out-box.dev/<user>/<slug>` (no desde la API, y **sin** `/u/`).
Para páginas privadas, la key debe ser del owner.
