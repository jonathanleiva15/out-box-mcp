/**
 * Esquemas Zod compartidos del Outbox MCP server.
 *
 * Constraints reusadas verbatim por muchas tools (slug/path, prefix de carpeta,
 * recurso a compartir, username del owner). Antes vivían inline en cada una de las
 * 54 tools (ej. `z.string().min(1).max(200)` repetido 28 veces), lo que abría la
 * puerta a que una tool quedara con un límite distinto por accidente. Centralizar
 * acá fija una sola fuente de verdad; cada tool sigue agregando su `.describe(...)`
 * (y `.optional()` cuando corresponda) sobre la base, así el shape de `inputSchema`
 * no cambia.
 */
import { z } from "zod";

/** Slug/path jerárquico de una página o recurso (ej. 'briefings/hoy'). */
export const SLUG_SCHEMA = z.string().min(1).max(200);

/** Prefix de una carpeta (ej. 'clientes/solera'). Misma forma que un slug. */
export const PREFIX_SCHEMA = z.string().min(1).max(200);

/** Username del owner (para defaultear/acotar `user` en las tools). */
export const USER_SCHEMA = z.string().min(1).max(64);
