/**
 * Tests unitarios de los helpers puros y del cliente con `fetch` mockeado
 * (timeouts, reintento idempotente, shell, errores estructurados). Corren contra dist/.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OutboxClient,
  OutboxApiError,
  OutboxNetworkError,
  MissingCredentialError,
  describeError,
  formatError,
  PLAN_LIMIT_CODES,
  isSandboxShell,
  stripSandboxAgent,
} from "../dist/services/client.js";
import { fitJson, fitCount, projectPost, truncateText } from "../dist/output.js";
import { parseToolsets, isToolEnabled, DEFAULT_TOOLSETS } from "../dist/toolsets.js";
import { annotateComments, classifyTrust, hasHiddenChars, signSuggestionConfirmToken, verifySuggestionConfirmToken } from "../dist/comments.js";
import { writeFileInRoot } from "../dist/files.js";
import { buildInstructions } from "../dist/instructions.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── Cliente ──────────────────────────────────────────────────────────────────

test("readContent: usa /export?format=html y rechaza el shell (DEVC-01)", async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response('<iframe id="__ob_content" src="/raw/u/s"></iframe>', {
      status: 200,
      headers: { "content-type": "text/html", "x-outbox-shell": "on" },
    });
  };
  const c = new OutboxClient("outbox_k");
  await assert.rejects(() => c.readContent("u", "a/b", { self: true }), (e) => e.code === "shell_response");
  assert.match(seen[0], /\/api\/u\/u\/a\/b\/export\?format=html$/);
});

test("stripSandboxAgent saca exactamente el bloque que inyecta /raw", () => {
  const doc = "<html><body><p>x</p></body></html>";
  const injected = doc.replace("</body>", "\n<!-- __ob_sandbox_agent --><style>a{}</style><script>var a=1;</script>\n</body>");
  assert.equal(stripSandboxAgent(injected), doc);
  assert.equal(stripSandboxAgent(doc), doc);
});

test("regresión revisor: stripSandboxAgent NO borra contenido de una página que menciona el marcador", () => {
  // injectSandboxAgent es idempotente: si el HTML ya contiene el marcador no inyecta.
  const doc = "<html><body><p>doc sobre <!-- __ob_sandbox_agent --> interno</p><p>PARRAFO-IMPORTANTE</p><script>x()</script></body></html>";
  assert.equal(stripSandboxAgent(doc), doc);
  // Aunque tenga el formato exacto del bloque, si no está donde lo pondría el worker
  // (antes del último </body>), no se toca.
  const midDoc = "<html><body>\n<!-- __ob_sandbox_agent --><style>a{}</style><script>var a=1;</script>\n<p>DESPUES</p></body></html>";
  assert.equal(stripSandboxAgent(midDoc), midDoc);
});

test("stripSandboxAgent: mismas reglas de ubicación que el worker (</html> o al final si no hay </body>)", () => {
  const block = "\n<!-- __ob_sandbox_agent --><style>a{}</style><script>var a=1;</script>\n";
  assert.equal(stripSandboxAgent("<html><p>x</p>" + block + "</html>"), "<html><p>x</p></html>");
  assert.equal(stripSandboxAgent("<p>fragmento</p>" + block), "<p>fragmento</p>");
});

test("isSandboxShell: header o iframe __ob_content → /raw/", () => {
  assert.equal(isSandboxShell(new Headers({ "x-outbox-shell": "on" }), "<p>"), true);
  assert.equal(isSandboxShell(new Headers(), "<iframe src='/raw/u/s' id='__ob_content'>"), false);
  assert.equal(isSandboxShell(new Headers(), '<iframe id="__ob_content" src="/raw/u/s">'), true);
  assert.equal(isSandboxShell(new Headers(), "<iframe src='https://youtube.com'>"), false);
});

test("sin credencial: MissingCredentialError sin hacer fetch (AX-10)", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}");
  };
  const c = new OutboxClient(null);
  await assert.rejects(() => c.req("/api/me"), (e) => e instanceof MissingCredentialError);
  assert.equal(called, false);
  assert.equal(describeError(new MissingCredentialError()).code, "missing_credential");
});

test("timeout propio (DEVC-08): cada request lleva signal y un TimeoutError se mapea a network_timeout", async () => {
  let signal;
  globalThis.fetch = async (_url, init) => {
    signal = init.signal;
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  const c = new OutboxClient("outbox_k");
  await assert.rejects(
    () => c.req("/publish", { method: "POST", body: {}, timeoutMs: 1234 }),
    (e) => e instanceof OutboxNetworkError && e.kind === "timeout" && e.mutating === true,
  );
  assert.ok(signal instanceof AbortSignal);
  const err = new OutboxNetworkError("timeout", "api.out-box.dev", "/publish", 60000, true);
  const d = describeError(err);
  assert.equal(d.code, "network_timeout");
  assert.equal(d.retryable, true);
  assert.match(d.fix, /pudo haberse aplicado/);
  assert.match(formatError(err), /api\.out-box\.dev/);
});

test("regresión revisor (DEVC-08): un timeout MIENTRAS se lee el body sale como network_timeout, no invalid_input", async () => {
  // Server real que manda headers y deja el body colgado: AbortSignal.timeout corta
  // la lectura del body, que antes quedaba fuera del try/catch de red.
  const srv = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.write("<p>primera parte");
    // nunca termina (se cierra en el finally)
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const local = `http://127.0.0.1:${srv.address().port}`;
  globalThis.fetch = (url, init) => realFetch(local + new URL(String(url)).pathname, init);
  try {
    const c = new OutboxClient("outbox_k");
    await assert.rejects(
      () => c.reqText("/api/u/j/lento/export", { timeoutMs: 300 }),
      (e) => e instanceof OutboxNetworkError && e.kind === "timeout",
    );
    const err = await c.req("/api/u/j/lento/export", { timeoutMs: 300 }).catch((e) => e);
    const d = describeError(err);
    assert.equal(d.code, "network_timeout");
    assert.equal(d.retryable, true);
  } finally {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
});

test("reintento ante falla de red SOLO si hay idempotencyKey y el back lista la operación en features.idempotencyEndpoints", async () => {
  const mk = (supports) => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      calls.push({ u, key: init.headers["idempotency-key"] });
      if (u.endsWith("/api/capabilities")) {
        const features = { idempotency: supports, idempotencyEndpoints: supports ? ["publish", "dailyAppend"] : [] };
        return new Response(JSON.stringify({ features }), { status: 200 });
      }
      if (calls.filter((c) => c.u.endsWith("/append")).length === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    return calls;
  };
  // Con soporte: reintenta con la MISMA clave.
  let calls = mk(true);
  let c = new OutboxClient("outbox_k");
  const out = await c.req("/api/u/j/d/append", { method: "POST", body: {}, idempotencyKey: "k-12345678", retryOnNetworkError: true, idempotencyOp: "dailyAppend" });
  assert.deepEqual(out, { ok: true });
  const appends = calls.filter((x) => x.u.endsWith("/append"));
  assert.equal(appends.length, 2);
  assert.deepEqual(appends.map((a) => a.key), ["k-12345678", "k-12345678"]);
  // Sin soporte: no reintenta (un retry de una escritura ya aplicada la duplicaría).
  calls = mk(false);
  c = new OutboxClient("outbox_k");
  await assert.rejects(
    () => c.req("/api/u/j/d/append", { method: "POST", body: {}, idempotencyKey: "k-12345678", retryOnNetworkError: true, idempotencyOp: "dailyAppend" }),
    (e) => e instanceof OutboxNetworkError && e.kind === "unreachable",
  );
  assert.equal(calls.filter((x) => x.u.endsWith("/append")).length, 1);
});

test("un 4xx con body no-JSON no rompe el parseo del error", async () => {
  globalThis.fetch = async () => new Response("<!doctype html>404", { status: 404, headers: { "content-type": "text/html" } });
  const c = new OutboxClient("outbox_k");
  await assert.rejects(() => c.req("/raw/u/s"), (e) => e instanceof OutboxApiError && e.status === 404 && e.body === null);
});

test("describeError: private_read_scope_required trae missingAnyOf y fix con `list` (AX-03)", () => {
  const d = describeError(new OutboxApiError(403, { error: "private_read_scope_required" }, "/api/u/j/s/export"));
  assert.deepEqual(d.missingAnyOf, ["list", "admin:self"]);
  assert.match(d.fix, /--verbs publish,list/);
  // Si el back ya manda missingAnyOf, se respeta el del back.
  const d2 = describeError(new OutboxApiError(403, { error: "private_read_scope_required", missingAnyOf: ["list:j"] }, "/x"));
  assert.deepEqual(d2.missingAnyOf, ["list:j"]);
});

test("describeError: CTA de plan → upgradeCta y retryable solo para rate_limited", () => {
  const cta = { error: "daily_docs_limit", limit: 5, used: 5, tier: "free", upgradeTo: "pro", ctaUrl: "https://out-box.dev/pricing" };
  const d = describeError(new OutboxApiError(403, cta, "/publish"));
  assert.equal(d.upgradeCta.upgradeTo, "pro");
  assert.equal(d.retryable, false);
  const r = describeError(new OutboxApiError(429, { ...cta, error: "rate_limited", retryAfter: 30 }, "/publish"));
  assert.equal(r.retryable, true);
  assert.equal(r.retryAfter, 30);
});

// ── Output ───────────────────────────────────────────────────────────────────

test("fitJson: compacto si entra; si no, recorta ítems del array más pesado con JSON válido", () => {
  assert.equal(fitJson({ a: 1 }, 100), '{"a":1}');
  const data = { user: "j", posts: Array.from({ length: 100 }, (_, i) => ({ i, s: "x".repeat(50) })), tags: ["a"] };
  const out = fitJson(data, 2000);
  assert.ok(out.length <= 2000);
  const parsed = JSON.parse(out);
  assert.equal(parsed._truncated.field, "posts");
  assert.equal(parsed._truncated.total, 100);
  assert.equal(parsed.posts.length, parsed._truncated.shown);
  assert.equal(parsed.user, "j");
});

test("fitJson: arrays top-level y strings", () => {
  const arr = Array.from({ length: 50 }, () => "y".repeat(100));
  const parsed = JSON.parse(fitJson(arr, 1500));
  assert.ok(parsed.items.length < 50);
  assert.match(fitJson("z".repeat(50), 10), /truncad/);
  assert.equal(truncateText("abc", 10), "abc");
});

test("fitCount y projectPost", () => {
  assert.equal(fitCount([1, 2, 3], 1000, (s) => s), 3);
  assert.equal(fitCount(["x".repeat(100)], 10, (s) => s), 0);
  const p = projectPost({ slug: "a", title: "T", visibility: "public", updatedAt: "d", version: 2, tags: ["t", 3], owner: "j", url: "u", draft: true, sourceFormat: "markdown", openComments: 2 });
  assert.deepEqual(p, { slug: "a", title: "T", visibility: "public", updatedAt: "d", version: 2, tags: ["t"], draft: true, sourceFormat: "markdown", openComments: 2 });
});

// ── Toolsets / instructions ──────────────────────────────────────────────────

test("parseToolsets: default, all, combinaciones, core siempre, desconocidos avisados", () => {
  assert.deepEqual([...parseToolsets(undefined).enabled], [...DEFAULT_TOOLSETS]);
  // 8 desde la Ola 2 (toolset `apps`, MCP Apps).
  assert.equal(parseToolsets("all").enabled.size, 8);
  const p = parseToolsets("Sharing, keys  bogus");
  assert.deepEqual([...p.enabled].sort(), ["core", "keys", "sharing"]);
  assert.deepEqual(p.unknown, ["bogus"]);
  assert.throws(() => isToolEnabled("outbox_no_clasificada", new Set(["core"])), /toolset/);
});

test("buildInstructions menciona los toolsets inactivos y cómo activarlos", () => {
  const txt = buildInstructions(new Set(["core"]), "https://out-box.dev");
  assert.match(txt, /Inactivos: comments/);
  assert.match(txt, /https:\/\/out-box\.dev\/<user>\/<slug>/);
  assert.doesNotMatch(buildInstructions(parseToolsets("all").enabled, "x"), /Inactivos/);
});

// ── Comentarios ──────────────────────────────────────────────────────────────

test("classifyTrust y annotateComments sin terceros no agregan aviso", () => {
  assert.equal(classifyTrust({ commenter: "j" }, "j", "public"), "owner");
  assert.equal(classifyTrust({ commenter: "share:abcd", commenterKeyId: "share" }, "j", "public"), "share-anon");
  assert.equal(classifyTrust({ commenter: "x" }, "j", "private"), "grant");
  assert.equal(classifyTrust({ commenter: "x" }, "j", "unlisted"), "authenticated");
  const out = annotateComments({ postOwner: "j", visibility: "public", comments: [{ id: "1", commenter: "j", body: "b", status: "open" }] }, { from: "all", includeAnonymous: false, viewerIsOwner: true });
  assert.equal(out.notice, undefined);
  assert.equal(out.comments[0].body, "b");
  assert.equal(out.openCount, 1);
});

test("classifyTrust respeta el `trust` que fija el back; solo deriva en comentarios legacy", () => {
  assert.equal(classifyTrust({ commenter: "x", trust: "grant" }, "j", "public"), "grant");
  assert.equal(classifyTrust({ commenter: "x", trust: "share-anon" }, "j", "public"), "share-anon");
  // Un valor desconocido no se acepta: se deriva.
  assert.equal(classifyTrust({ commenter: "x", trust: "admin" }, "j", "public"), "authenticated");
});

test("confirmToken de sugerencia: firmado (HMAC) y atado a página + commentId + exact + replacement", () => {
  const key = "clave-de-test";
  const f = { owner: "j", slug: "factura", commentId: "c3", exact: "CBU 111", replacement: "CBU 000" };
  const now = Date.UTC(2026, 9, 1, 12, 0, 0);
  const { token: t } = signSuggestionConfirmToken(key, f, now);
  assert.match(t, /^\d{10}\.[a-f0-9]{32}$/);
  assert.equal(signSuggestionConfirmToken(key, f, now).token, t, "determinístico para el mismo instante");
  assert.equal(verifySuggestionConfirmToken(key, f, t, now), "ok");
  assert.equal(verifySuggestionConfirmToken(key, { ...f, replacement: "CBU 001" }, t, now), "mismatch");
  assert.equal(verifySuggestionConfirmToken(key, { ...f, commentId: "c4" }, t, now), "mismatch");
  assert.equal(verifySuggestionConfirmToken(key, { ...f, slug: "otra" }, t, now), "mismatch");
  assert.equal(verifySuggestionConfirmToken(key, { ...f, owner: "x" }, t, now), "mismatch");
  assert.equal(
    verifySuggestionConfirmToken(key, { ...f, exact: "CBU 11", replacement: "1CBU 000" }, t, now),
    "mismatch",
    "sin ambigüedad de concatenación",
  );
  assert.equal(hasHiddenChars("a\u200Bb"), true);
  assert.equal(hasHiddenChars("a\u202Eb"), true);
  assert.equal(hasHiddenChars("CBU 000-ATACANTE"), false);
});

test("regresión revisor: writeFileInRoot no crea directorios fuera de la raíz vía un symlink intermedio", async () => {
  const root = await mkdtemp(join(tmpdir(), "outbox-mcp-root-"));
  const outside = await mkdtemp(join(tmpdir(), "outbox-mcp-out-"));
  const prev = process.env.OUTBOX_FILES_DIR;
  process.env.OUTBOX_FILES_DIR = root;
  try {
    await symlink(outside, join(root, "link"));
    await assert.rejects(() => writeFileInRoot("link/a/b/c.html", "<p>x</p>"), (e) => e.code === "file_path_outside_root");
    assert.equal(existsSync(join(outside, "a")), false, "no quedó 'a/b' creado afuera");
    // Un subdirectorio legítimo nuevo sí se crea.
    await mkdir(join(root, "ok"), { recursive: true });
    const w = await writeFileInRoot("ok/n/d.html", "<p>x</p>");
    assert.equal(w.bytes, 8);
  } finally {
    if (prev === undefined) delete process.env.OUTBOX_FILES_DIR;
    else process.env.OUTBOX_FILES_DIR = prev;
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("pasada 2 gate: el consejo ante un error de red de una escritura no afirma que append/comentarios duplican (capabilities ya los lista en idempotencyEndpoints)", () => {
  const d = describeError(new OutboxNetworkError("timeout", "api.out-box.dev", "/api/daily/append", 45000, true));
  assert.match(d.fix, /features\.idempotencyEndpoints/);
  assert.doesNotMatch(d.fix, /append del daily y los comentarios/);
});

test("pasada 2 gate: PLAN_LIMIT_CODES se exporta (lo reusa out-box-mcp-remote) con los códigos de plan del worker", () => {
  for (const c of ["rate_limited", "daily_docs_limit", "daily_updates_limit", "keys_limit", "html_too_large", "storage_limit"]) {
    assert.ok(PLAN_LIMIT_CODES.has(c), c);
  }
});

test("pasada 2 gate: 403 slug_not_allowed (key con slugWhitelist) explica la lista de slugs, no un scope faltante", () => {
  const err = new OutboxApiError(403, { error: "slug_not_allowed", message: "slug fuera de la lista" }, "/api/u/j/x/visibility");
  const d = describeError(err);
  assert.equal(d.code, "slug_not_allowed");
  assert.equal(d.retryable, false);
  assert.match(d.fix, /slugWhitelist/);
  assert.match(formatError(err), /^Error 403 \(slug_not_allowed\): .*slugWhitelist/);
});

test("pasada 2 gate: los mensajes custom de zod (regex/refine) llevan parte en inglés (el connector remoto los muestra tal cual)", async () => {
  const { readFileSync } = await import("node:fs");
  const offenders = [];
  let seen = 0;
  for (const f of ["src/tools.ts", "src/schemas.ts"]) {
    for (const line of readFileSync(new URL(`../${f}`, import.meta.url), "utf8").split("\n")) {
      if (!/\.(regex|refine)\(/.test(line)) continue;
      const m = line.match(/,\s*"([^"]+)"\s*\)[,;]?\s*(\.optional\(\)[,;]?)?\s*$/);
      if (!m) continue;
      seen++;
      if (!/ \/ [A-Z0-9a-z]/.test(m[1]) || !/[A-Za-z]/.test(m[1].split(" / ").pop())) offenders.push(`${f}: ${m[1]}`);
    }
  }
  assert.ok(seen >= 8, `se esperaban >= 8 mensajes custom, hubo ${seen}`);
  assert.deepEqual(offenders, []);
});
