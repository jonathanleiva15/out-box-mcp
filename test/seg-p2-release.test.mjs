/**
 * Seguridad pasada 2 (2026-10-01): release.yml publicaba con `npm publish` en el
 * mismo job que `npm ci` y con NODE_AUTH_TOKEN en el env, así que `prepublishOnly`
 * (rimraf + tsc + node --test) corría código de devDependencies con el token de
 * publish al alcance; además `id-token: write` estaba a nivel workflow. Un devDep
 * comprometido exfiltraba el automation token y publicaba un @out-box/mcp malicioso.
 *
 * Invariantes (estilo test-ts/release-workflow.test.mjs del desktop): el job que ve
 * NPM_TOKEN/NODE_AUTH_TOKEN no hace checkout ni instala, y publica con
 * --ignore-scripts; id-token:write solo en ese job; el build no tiene secrets ni
 * registry-url y hace checkout sin credenciales persistidas.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");

/** Bloque top-level (`permissions:` / `jobs:`) sin comentarios. */
function topBlock(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `${name}:`);
  if (start === -1) return "";
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

/** { nombre: bloque } de cada job de `jobs:` (indent de 2), sin comentarios. */
function jobs(text) {
  const lines = topBlock(text, "jobs").split("\n");
  const out = {};
  let current = null;
  for (const l of lines) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (m) {
      current = m[1];
      out[current] = [];
    } else if (current && !/^\s*#/.test(l)) {
      // Sin comentarios al final de línea (ej. "id-token: write # requerido por npm publish").
      out[current].push(l.replace(/\s+#\s.*$/, ""));
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join("\n")]));
}

/** Lista de violaciones del patrón seguro de publish. [] = OK. */
function releaseViolations(text) {
  const v = [];
  const top = topBlock(text, "permissions").replace(/#.*$/gm, "");
  if (/id-token\s*:\s*write/.test(top)) v.push("id-token: write a nivel workflow");
  const all = jobs(text);
  const publishers = Object.entries(all).filter(([, b]) => /npm publish/.test(b));
  if (publishers.length === 0) v.push("ningún job hace npm publish");
  for (const [name, block] of Object.entries(all)) {
    const hasToken = /NPM_TOKEN|NODE_AUTH_TOKEN/.test(block);
    const hasOidc = /id-token\s*:\s*write/.test(block);
    const installs = /\bnpm (ci|install|i)\b|\byarn\b|\bpnpm\b/.test(block);
    if ((hasToken || hasOidc) && installs) v.push(`${name}: instala dependencias con token de publish/OIDC`);
    if ((hasToken || hasOidc) && /actions\/checkout@/.test(block)) v.push(`${name}: hace checkout con token de publish/OIDC`);
    if ((hasToken || hasOidc) && /\bnpm (test|run)\b/.test(block)) v.push(`${name}: corre scripts del repo con token de publish/OIDC`);
    for (const line of block.split("\n").filter((l) => /npm publish/.test(l))) {
      if (!/--ignore-scripts/.test(line)) v.push(`${name}: npm publish sin --ignore-scripts`);
      if (!/\.tgz|\$TARBALL|\btarball\b/i.test(line)) v.push(`${name}: npm publish no publica el .tgz del build`);
    }
    if (!hasToken && /registry-url/.test(block)) v.push(`${name}: registry-url (.npmrc de publish) fuera del job de publish`);
    if (/actions\/checkout@/.test(block) && !/persist-credentials:\s*false/.test(block)) {
      v.push(`${name}: checkout sin persist-credentials: false`);
    }
    if (/npm publish/.test(block) && !/permissions:/.test(block)) v.push(`${name}: el job de publish no declara permisos propios`);
  }
  return v;
}

/** release.yml ANTES del fix (recortado a lo que importa). */
const LEGACY = `name: release
on:
  push:
    tags:
      - 'v[0-9]+.[0-9]+.[0-9]+'

permissions:
  contents: read
  id-token: write # requerido por npm publish --provenance (OIDC)

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - name: Setup Node
        uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org'
      - name: Install (npm ci)
        run: npm ci
      - name: Test (build + node --test)
        run: npm test
      - name: Publish
        run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
`;

test("el checker detecta el patrón anterior (PoC: devDep corre con el token de publish)", () => {
  const v = releaseViolations(LEGACY);
  assert.ok(v.some((x) => /id-token: write a nivel workflow/.test(x)), v.join("\n"));
  assert.ok(v.some((x) => /instala dependencias con token/.test(x)), v.join("\n"));
  assert.ok(v.some((x) => /sin --ignore-scripts/.test(x)), v.join("\n"));
  assert.ok(v.some((x) => /checkout sin persist-credentials/.test(x)), v.join("\n"));
});

test("release.yml actual: build sin secrets y publish aislado con --ignore-scripts", () => {
  assert.deepEqual(releaseViolations(RELEASE), []);
});

test("release.yml: el build testea y empaqueta; el publish solo baja el artifact", () => {
  const all = jobs(RELEASE);
  assert.ok(all.build && all.publish, `jobs: ${Object.keys(all).join(", ")}`);
  assert.match(all.build, /npm ci/);
  assert.match(all.build, /npm run clean/);
  assert.match(all.build, /npm test/);
  assert.match(all.build, /npm pack/);
  assert.match(all.build, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.doesNotMatch(all.build, /secrets\./);
  assert.doesNotMatch(all.build, /id-token/);
  assert.match(all.publish, /needs:\s*build/);
  assert.match(all.publish, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(all.publish, /id-token:\s*write/);
  assert.doesNotMatch(all.publish, /contents:\s*write/);
  // Todas las actions de terceros pineadas a SHA.
  for (const m of RELEASE.matchAll(/uses:\s*(\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, m[1]);
});

test("release.yml sigue verificando tag vs package.json, SERVER_VERSION y server.json antes de testear", () => {
  const build = jobs(RELEASE).build;
  const verify = build.indexOf("SERVER_VERSION");
  assert.ok(verify > 0);
  assert.ok(verify < build.indexOf("npm ci"));
});
