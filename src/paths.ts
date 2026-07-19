/**
 * Helpers PUROS de construcción de paths de URL (sin I/O, sin config, sin zod).
 * Extraídos de index.ts / services/client.ts para tener una sola implementación
 * y poder testearlos unitariamente (ver test/paths.test.mjs).
 */

/**
 * Codifica un slug/prefix jerárquico (ej: `clientes/solera`) segmento por
 * segmento. `encodeURIComponent` sobre el path ENTERO convierte `/` en `%2F` y
 * el worker lo rechaza (400 invalid_slug / invalid_prefix: el back splitea el
 * pathname crudo sin decodificar — ver folder.ts / serve.ts). Igual que el CLI:
 * split → encode → join, conservando los `/` como separadores de path.
 */
export function encodeSlugPath(slug: string): string {
  return slug.split("/").map(encodeURIComponent).join("/");
}
