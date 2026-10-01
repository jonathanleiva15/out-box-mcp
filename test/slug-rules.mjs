/**
 * Reglas de slug del worker para los tests de contrato (ronda 4). No es un test (no
 * matchea *.test.mjs).
 *
 * Fuente canónica: un JSON de reglas exportado por el worker. Si existe, los tests lo
 * consumen tal cual y el port a mano de abajo NO se usa. Si todavía no existe (estado
 * al 2026-10-01), se cae al port (`PORT`), que `pasada2-contratos` sigue comparando
 * contra los literales de `out-box/worker/src/lib/slug.ts`.
 *
 * Dónde se busca el JSON (el primero que exista):
 *   1. `OUTBOX_SLUG_RULES_JSON` (ruta explícita; si está definida y falta, es error);
 *   2. `../out-box/worker/src/lib/slug-rules.json`;
 *   3. `../out-box/worker/slug-rules.json`.
 *
 * Forma esperada (se aceptan alias de nombres para no atar el test a una ortografía):
 *   {
 *     "reservedSlugSuffixes":  ["visibility", "draft", …],   // alias: reservedSuffixes, RESERVED_SLUG_SUFFIXES
 *     "reservedFirstSegments": ["daily"],                    // alias: reservedSlugFirstSegments, RESERVED_SLUG_FIRST_SEGMENTS
 *     "reservedTails": [                                     // alias: tails, tailPatterns, reservedTailPatterns
 *       { "name": "COMMENT_ACTION_TAIL_RE", "source": "(^|\\/)comments\\/…$", "flags": "i" },
 *       "(^|\\/)blocks\\/blk_[^/]*$"                          // string = source con flags "i"
 *     ]                                                      // o un objeto { NAME: {source, flags} | "source" }
 *   }
 * Un JSON que no tenga suffixes y first segments como arrays de strings hace FALLAR el
 * test (mejor un rojo explícito que reglas vacías que aceptan todo).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const MCP_ROOT = join(here, "..");

/** Port a mano de out-box/worker/src/lib/slug.ts (fallback mientras no haya JSON). */
export const PORT = Object.freeze({
  suffixes: new Set(
    "visibility draft password unlock comments reactions views stats versions diff rollback squash access export append dailies blocks agents recent search manifest delete".split(
      " ",
    ),
  ),
  firstSegments: new Set(["daily"]),
  tails: [
    /(^|\/)comments\/[a-f0-9]+\/(accept|discard|resolve)$/i, // COMMENT_ACTION_TAIL_RE
    /(^|\/)blocks\/blk_[^/]*$/i, // DAILY_BLOCK_TAIL_RE
  ],
});

/** Rutas candidatas del JSON canónico, en orden de preferencia. */
export function slugRulesCandidates(env = process.env, root = MCP_ROOT) {
  if (env.OUTBOX_SLUG_RULES_JSON) return [resolve(env.OUTBOX_SLUG_RULES_JSON)];
  return [
    join(root, "..", "out-box", "worker", "src", "lib", "slug-rules.json"),
    join(root, "..", "out-box", "worker", "slug-rules.json"),
  ];
}

function pick(obj, names) {
  for (const n of names) if (obj && Object.prototype.hasOwnProperty.call(obj, n)) return obj[n];
  return undefined;
}

function stringArray(value, label, file) {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && v.length > 0)) {
    throw new Error(`${file}: \`${label}\` tiene que ser un array no vacío de strings (reglas de slug del worker)`);
  }
  return value;
}

function toRegex(entry, file) {
  if (typeof entry === "string") return new RegExp(entry, "i");
  if (entry && typeof entry === "object" && typeof entry.source === "string") {
    // Sin g/y: con estado, `.test()` alternaría resultados entre llamadas.
    return new RegExp(entry.source, typeof entry.flags === "string" ? entry.flags.replace(/[gy]/g, "") : "i");
  }
  throw new Error(`${file}: cola reservada inválida (${JSON.stringify(entry)}): string o { source, flags }`);
}

/**
 * Normaliza el JSON del worker a `{ suffixes, firstSegments, tails }` (sets en
 * minúsculas, regex compiladas). Tira con un mensaje accionable si la forma no se
 * reconoce.
 */
export function parseSlugRules(json, file = "slug-rules.json") {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error(`${file}: tiene que ser un objeto JSON`);
  const suffixes = stringArray(
    pick(json, ["reservedSlugSuffixes", "reservedSuffixes", "RESERVED_SLUG_SUFFIXES"]),
    "reservedSlugSuffixes",
    file,
  );
  const first = stringArray(
    pick(json, ["reservedFirstSegments", "reservedSlugFirstSegments", "RESERVED_SLUG_FIRST_SEGMENTS"]),
    "reservedFirstSegments",
    file,
  );
  const rawTails = pick(json, ["reservedTails", "tails", "tailPatterns", "reservedTailPatterns"]) ?? [];
  const tailList = Array.isArray(rawTails) ? rawTails : typeof rawTails === "object" ? Object.values(rawTails) : null;
  if (!tailList) throw new Error(`${file}: \`reservedTails\` tiene que ser un array o un objeto`);
  return {
    suffixes: new Set(suffixes.map((s) => s.toLowerCase())),
    firstSegments: new Set(first.map((s) => s.toLowerCase())),
    tails: tailList.map((t) => toRegex(t, file)),
  };
}

/**
 * Reglas a usar: `{ source: "json", file, ...reglas }` si hay JSON canónico, si no
 * `{ source: "port", ...PORT }`. Con `OUTBOX_SLUG_RULES_JSON` definida y el archivo
 * ausente, tira (pidieron esa fuente explícitamente).
 */
export function loadSlugRules(env = process.env, root = MCP_ROOT) {
  const candidates = slugRulesCandidates(env, root);
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    return { source: "json", file, ...parseSlugRules(JSON.parse(readFileSync(file, "utf8")), file) };
  }
  if (env.OUTBOX_SLUG_RULES_JSON) {
    throw new Error(`OUTBOX_SLUG_RULES_JSON=${env.OUTBOX_SLUG_RULES_JSON} no existe`);
  }
  return { source: "port", file: null, ...PORT };
}

/**
 * slugRejectionReason del worker (lib/slug.ts) sobre `rules`. La FORMA la valida
 * `isValidShape` (SLUG_SCHEMA del MCP). `folder: true` = isShareableFolder (solo `_*`
 * y primer segmento reservado).
 */
export function makeSlugRejectionReason(rules, isValidShape) {
  return function slugRejectionReason(slug, { folder = false } = {}) {
    if (!isValidShape(slug)) return "invalid_slug";
    const segs = slug.split("/");
    if (segs.some((s) => s.startsWith("_"))) return "reserved_slug";
    if (rules.firstSegments.has(segs[0].toLowerCase())) return "reserved_slug";
    if (folder) return null;
    if (rules.suffixes.has(segs.at(-1).toLowerCase())) return "reserved_slug";
    if (rules.tails.some((re) => re.test(slug))) return "reserved_slug";
    return null;
  };
}
