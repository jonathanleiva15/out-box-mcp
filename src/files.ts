/**
 * Contenido grande FUERA del contexto del agente (AX P4 / AX-12.6).
 *
 * `outbox_pull`, `outbox_export` y `outbox_export_library` metían HTML completo
 * (hasta MB, o 500 posts en un backup) en el contexto; y para publicar un archivo
 * grande el agente tenía que pegarlo entero como argumento. Con `file_path` el MCP
 * (que corre local) lee/escribe el archivo y al agente le devuelve solo un resumen.
 *
 * SEGURIDAD: el path lo elige el modelo, y el modelo puede estar leyendo contenido de
 * terceros (prompt injection). Por eso todo I/O queda confinado a UNA carpeta raíz
 * (`OUTBOX_FILES_DIR`, default `~/Outbox`):
 *   - relativos se resuelven contra la raíz; absolutos tienen que caer adentro;
 *   - sin `..` que escape, sin symlinks que salgan de la raíz (realpath);
 *   - extensiones permitidas por operación;
 *   - escribir NO pisa un archivo existente salvo `overwrite: true`.
 * Así un "publicá ~/.ssh/id_rsa como página pública" inyectado no puede leer fuera
 * de la raíz, y un "escribí esto en ~/.zshrc" no puede escribir fuera.
 */
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { OutboxToolError } from "./services/client.js";

export const WRITE_EXTENSIONS = [".html", ".htm", ".md", ".markdown", ".json", ".txt"] as const;
export const CONTENT_READ_EXTENSIONS = [".html", ".htm", ".md", ".markdown"] as const;
export const IMAGE_READ_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"] as const;

/** Tope de lectura de un archivo local (publish acepta hasta 5 MB por página). */
export const MAX_READ_BYTES = 10 * 1024 * 1024;

/** Carpeta raíz de archivos del MCP (se crea recién al escribir). */
export function filesRoot(): string {
  const env = process.env.OUTBOX_FILES_DIR?.trim();
  return resolve(env || resolve(homedir(), "Outbox"));
}

function outsideRoot(p: string): OutboxToolError {
  return new OutboxToolError(
    "file_path_outside_root",
    `El path ${JSON.stringify(p)} cae fuera de la carpeta de archivos del MCP (${filesRoot()}).`,
    "Usá un path relativo (ej. 'backups/clientes.json') o uno absoluto dentro de esa carpeta. El usuario la cambia con OUTBOX_FILES_DIR.",
  );
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" ? false : !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..");
}

/** Resuelve `p` contra la raíz y valida que quede adentro (sin tocar el disco). */
export function resolveInRoot(p: string): string {
  const root = filesRoot();
  const target = isAbsolute(p) ? resolve(p) : resolve(root, p);
  if (!isInside(root, target)) throw outsideRoot(p);
  return target;
}

function checkExtension(target: string, allowed: readonly string[]): void {
  const ext = extname(target).toLowerCase();
  if (!allowed.includes(ext)) {
    throw new OutboxToolError(
      "file_extension_not_allowed",
      `Extensión ${ext || "(ninguna)"} no permitida para esta operación.`,
      `Usá una de: ${allowed.join(", ")}.`,
    );
  }
}

async function realRoot(): Promise<string> {
  const root = filesRoot();
  try {
    return await realpath(root);
  } catch {
    return root;
  }
}

/**
 * Recorre los componentes de `dir` (relativo a `root`) mientras existan y valida que
 * cada uno resuelva dentro de `rootReal`. El primero que no existe corta el recorrido:
 * lo que falta se crea colgando de un ancestro ya validado.
 */
async function assertExistingAncestorsInside(root: string, rootReal: string, dir: string, p: string): Promise<void> {
  const rel = relative(root, dir);
  if (rel === "") return;
  let cur = root;
  for (const part of rel.split(sep)) {
    cur = join(cur, part);
    try {
      await lstat(cur);
    } catch {
      return; // no existe: desde acá se crea adentro de un ancestro válido.
    }
    let real: string;
    try {
      real = await realpath(cur);
    } catch {
      throw outsideRoot(p); // symlink roto: no se sabe adónde apunta al crearse.
    }
    if (real !== rootReal && !isInside(rootReal, real)) throw outsideRoot(p);
  }
}

/** Escribe `content` en un archivo dentro de la raíz. Devuelve el path absoluto y los bytes. */
export async function writeFileInRoot(
  p: string,
  content: string | Uint8Array,
  opts: { overwrite?: boolean; extensions?: readonly string[] } = {},
): Promise<{ path: string; bytes: number }> {
  const target = resolveInRoot(p);
  checkExtension(target, opts.extensions ?? WRITE_EXTENSIONS);
  const root = filesRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootReal = await realRoot();
  // ANTES de crear directorios: cada ancestro que YA existe tiene que resolver (post
  // symlinks) dentro de la raíz real. Si no, un `link/a/b/x.html` con `link` → afuera
  // dejaba creados `a/b` fuera de OUTBOX_FILES_DIR aunque después se rechazara la escritura.
  await assertExistingAncestorsInside(root, rootReal, dirname(target), p);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  // El directorio padre real (post-symlinks) tiene que seguir dentro de la raíz real.
  const parentReal = await realpath(dirname(target));
  if (parentReal !== rootReal && !isInside(rootReal, parentReal)) throw outsideRoot(p);
  try {
    const st = await lstat(target);
    if (st.isSymbolicLink()) throw outsideRoot(p);
    if (!opts.overwrite) {
      throw new OutboxToolError(
        "file_exists",
        `Ya existe ${target}.`,
        "Pasá overwrite: true para reemplazarlo, o elegí otro file_path.",
      );
    }
  } catch (e) {
    if (e instanceof OutboxToolError) throw e;
    // ENOENT: no existe → se crea.
  }
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  await writeFile(target, data, { mode: 0o600, flag: opts.overwrite ? "w" : "wx" });
  return { path: target, bytes: data.length };
}

/** Lee un archivo dentro de la raíz (extensiones y tamaño acotados). */
export async function readFileInRoot(
  p: string,
  opts: { extensions: readonly string[]; maxBytes?: number },
): Promise<{ path: string; data: Buffer }> {
  const target = resolveInRoot(p);
  checkExtension(target, opts.extensions);
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new OutboxToolError("file_not_found", `No existe ${target}.`, "Revisá el file_path (relativo a la carpeta de archivos del MCP).");
  }
  const rootReal = await realRoot();
  if (!isInside(rootReal, real)) throw outsideRoot(p);
  const st = await stat(real);
  const max = opts.maxBytes ?? MAX_READ_BYTES;
  if (!st.isFile()) throw new OutboxToolError("file_not_found", `${target} no es un archivo.`, "Pasá el path de un archivo.");
  if (st.size > max) {
    throw new OutboxToolError("file_too_large", `${target} pesa ${st.size} bytes (máx ${max}).`, "Reducí el archivo o subí las imágenes aparte con outbox_upload.");
  }
  return { path: real, data: await readFile(real) };
}
