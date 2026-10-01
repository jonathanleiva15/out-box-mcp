/**
 * MCP App "visor de página" (Ola 2, extensión io.modelcontextprotocol/ui).
 *
 * `outbox_show_page` declara `_meta.ui.resourceUri = PAGE_VIEWER_URI` y el host
 * (claude.ai, Claude Desktop, …) renderiza este HTML en un iframe sandbox propio.
 * El HTML es AUTOCONTENIDO (sin CDN, sin fetch externo): el puente host↔app es un
 * JSON-RPC mínimo sobre postMessage escrito a mano siguiendo el spec de ext-apps
 * (ui/initialize, ui/notifications/tool-result, tools/call, ui/message,
 * ui/open-link, ui/request-display-mode). Sin dependencia de
 * @modelcontextprotocol/ext-apps en runtime: el mismo recurso sirve al stdio y al
 * remoto (los dos sobre el SDK v2 desde la ronda 4).
 *
 * SEGURIDAD (regla dura del plan, plugin-claude.md §4c y §6):
 * - El HTML del usuario NUNCA se inyecta en el documento de la app: el preview va en
 *   un iframe HIJO `srcdoc` con `sandbox=""` (sin allow-scripts ni allow-same-origin)
 *   más una CSP que bloquea scripts y red. El contenido de la página no puede hablar
 *   con el puente ni llamar tools.
 * - La app solo acepta mensajes cuyo `event.source` es `window.parent` (el host).
 * - Las acciones destructivas (rollback, aceptar sugerencias) NO se ejecutan desde la
 *   app: se le pide al chat con `ui/message` y el modelo llama la tool, que lleva
 *   `destructiveHint` → el host pide confirmación. La app solo llama tools read-only
 *   (outbox_page_preview).
 * - Todo texto (títulos, comentarios de terceros) se pinta con textContent, nunca
 *   innerHTML.
 */

export const PAGE_VIEWER_URI = "ui://outbox/page-viewer.html";

/** MIME de un recurso MCP App (ext-apps RESOURCE_MIME_TYPE). */
export const MCP_APP_MIME = "text/html;profile=mcp-app";

/** Versión del protocolo de MCP Apps que habla el puente (ext-apps LATEST_PROTOCOL_VERSION). */
export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

/** Tope del HTML que `outbox_page_preview` le pasa al visor (el resto se corta con aviso). */
export const PREVIEW_MAX_CHARS = 400_000;

/**
 * CSP que se antepone al HTML del preview (además del sandbox del iframe hijo):
 * sin scripts, sin red salvo imágenes/estilos https (la página del usuario suele
 * traer imágenes y fuentes), sin formularios ni navegación.
 */
export const PREVIEW_CSP =
  "default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https:; font-src https: data:; media-src https:; form-action 'none'; base-uri 'none'";

export const PAGE_VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Outbox page</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: var(--color-background-primary, #ffffff);
    --bg2: var(--color-background-secondary, #f4f4f2);
    --fg: var(--color-text-primary, #1c1c1a);
    --fg2: var(--color-text-secondary, #5c5c58);
    --border: var(--color-border-primary, #dcdcd6);
    --danger: var(--color-text-danger, #b3261e);
    --radius: var(--border-radius-md, 8px);
    --font: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
  }
  [data-theme="dark"] {
    --bg: var(--color-background-primary, #1c1c1a);
    --bg2: var(--color-background-secondary, #262624);
    --fg: var(--color-text-primary, #f2f2ee);
    --fg2: var(--color-text-secondary, #b0b0aa);
    --border: var(--color-border-primary, #3a3a36);
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 var(--font); color: var(--fg); background: var(--bg); }
  main { padding: 12px 14px; }
  header { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
  h1 { font-size: 16px; font-weight: 650; margin: 0; flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .meta { color: var(--fg2); font-size: 12px; margin: 4px 0 10px; }
  .badge { border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; font-size: 12px; color: var(--fg2); }
  nav { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 10px; }
  nav button { background: none; border: 0; border-bottom: 2px solid transparent; padding: 8px 10px; color: var(--fg2); font: inherit; cursor: pointer; min-height: 44px; }
  nav button[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--fg); }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .btn { border: 1px solid var(--border); background: var(--bg2); color: var(--fg); border-radius: var(--radius); padding: 6px 12px; font: inherit; cursor: pointer; min-height: 36px; }
  .btn:disabled { opacity: .5; cursor: default; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { border-bottom: 1px solid var(--border); padding: 8px 0; display: flex; gap: 8px; align-items: center; justify-content: space-between; }
  li .txt { min-width: 0; overflow-wrap: anywhere; }
  .muted { color: var(--fg2); font-size: 12px; }
  .warn { color: var(--danger); font-size: 12px; }
  iframe { width: 100%; height: 420px; border: 1px solid var(--border); border-radius: var(--radius); background: #fff; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--bg2); padding: 10px; border-radius: var(--radius); max-height: 420px; overflow: auto; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <header>
    <h1 id="title">Loading page…</h1>
    <span class="badge" id="visibility" hidden></span>
  </header>
  <div class="meta" id="meta"></div>
  <div class="actions" id="topActions">
    <button class="btn" id="open" disabled>Open in Outbox</button>
    <button class="btn" id="fullscreen">Full screen</button>
  </div>
  <nav role="tablist">
    <button role="tab" aria-selected="true" data-tab="preview">Preview</button>
    <button role="tab" aria-selected="false" data-tab="versions">Versions</button>
    <button role="tab" aria-selected="false" data-tab="comments">Comments</button>
  </nav>
  <section data-panel="preview">
    <div class="actions">
      <button class="btn" id="loadPreview" disabled>Load preview</button>
      <button class="btn" id="textOnly" disabled>Text only</button>
    </div>
    <p class="muted" id="previewNote">The preview renders the stored HTML without scripts, in an isolated frame.</p>
    <iframe id="frame" title="Page preview" sandbox="" referrerpolicy="no-referrer" hidden></iframe>
    <pre id="text" hidden></pre>
  </section>
  <section data-panel="versions" hidden><ul id="versions"></ul></section>
  <section data-panel="comments" hidden><ul id="comments"></ul></section>
  <p class="warn" id="error" hidden></p>
</main>
<script>
(function () {
  "use strict";
  var PREVIEW_CSP = ${JSON.stringify(PREVIEW_CSP)};
  var nextId = 1;
  var pending = {};
  var state = { data: null, previewHtml: null };

  function $(id) { return document.getElementById(id); }
  function el(tag, text, cls) {
    var n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  }
  function showError(msg) { var e = $("error"); e.textContent = msg; e.hidden = !msg; }

  // ── Puente JSON-RPC con el host (solo window.parent) ──
  function post(msg) { window.parent.postMessage(msg, "*"); }
  function request(method, params) {
    var id = nextId++;
    post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      setTimeout(function () {
        if (pending[id]) { delete pending[id]; reject(new Error("timeout: " + method)); }
      }, 60000);
    });
  }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); }

  window.addEventListener("message", function (ev) {
    if (ev.source !== window.parent) return; // ignora al iframe hijo y a cualquier otro
    var m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && !m.method) {
      var p = pending[m.id];
      if (!p) return;
      delete pending[m.id];
      if (m.error) p.reject(new Error(m.error.message || "error")); else p.resolve(m.result);
      return;
    }
    if (m.method === "ui/notifications/tool-result") { onToolResult(m.params || {}); return; }
    if (m.method === "ui/notifications/host-context-changed") { applyContext(m.params || {}); return; }
    if (m.method === "ui/resource-teardown" && m.id !== undefined) { post({ jsonrpc: "2.0", id: m.id, result: {} }); return; }
    if (m.id !== undefined && m.method) {
      post({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
    }
  });

  function applyContext(ctx) {
    if (ctx.theme) document.documentElement.setAttribute("data-theme", ctx.theme);
    var vars = ctx.styles && ctx.styles.variables;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        if (/^--[a-z0-9-]+$/.test(k) && typeof vars[k] === "string") document.documentElement.style.setProperty(k, vars[k]);
      });
    }
  }

  function reportSize() {
    notify("ui/notifications/size-changed", { width: document.body.scrollWidth, height: document.body.scrollHeight });
  }

  // ── Render ──
  function onToolResult(result) {
    var sc = result.structuredContent;
    if (result.isError || !sc || !sc.page) {
      showError((sc && sc.error && (sc.error.fix || sc.error.message)) || "Could not load the page.");
      return;
    }
    showError("");
    state.data = sc;
    var page = sc.page;
    // Página ajena (seg p4): title/summary/tags vienen en untrustedText. Solo textContent.
    var authored = page.untrustedText || page;
    $("title").textContent = authored.title || page.slug;
    var vis = $("visibility");
    vis.textContent = page.draft ? "draft" : page.visibility;
    vis.hidden = false;
    var bits = [page.user + "/" + page.slug];
    if (sc.thirdParty) bits.push("third-party page");
    if (page.version) bits.push("v" + page.version);
    if (page.updatedAt) bits.push("updated " + page.updatedAt);
    $("meta").textContent = bits.join(" · ");
    $("open").disabled = !page.url;
    $("loadPreview").disabled = false;
    $("textOnly").disabled = false;
    renderVersions(sc);
    renderComments(sc);
    reportSize();
  }

  function askChat(text) {
    request("ui/message", { role: "user", content: [{ type: "text", text: text }] }).catch(function (e) { showError(e.message); });
  }

  function renderVersions(sc) {
    var ul = $("versions");
    ul.textContent = "";
    var list = (sc.versions && sc.versions.items) || [];
    if (sc.versions && sc.versions.error) ul.appendChild(el("li", sc.versions.error, "muted"));
    if (!list.length && !(sc.versions && sc.versions.error)) ul.appendChild(el("li", "No version history.", "muted"));
    list.forEach(function (v) {
      var li = el("li");
      var txt = el("div", null, "txt");
      var vt = v.untrustedText || v;
      txt.appendChild(el("div", "v" + v.version + (v.current ? " (current)" : "") + (vt.title ? " · " + vt.title : "")));
      txt.appendChild(el("div", [v.createdAt, vt.model].filter(Boolean).join(" · "), "muted"));
      li.appendChild(txt);
      // En una página ajena no hay rollback posible: sin botón.
      if (!v.current && !sc.thirdParty) {
        var b = el("button", "Ask to restore", "btn");
        // Destructivo: NO se llama outbox_rollback desde la app. Se le pide al chat y
        // el host confirma la tool (destructiveHint).
        b.addEventListener("click", function () {
          askChat("Restore my Outbox page " + sc.page.user + "/" + sc.page.slug + " to version " + v.version + " (outbox_rollback). Confirm with me first.");
        });
        li.appendChild(b);
      }
      ul.appendChild(li);
    });
  }

  function renderComments(sc) {
    var ul = $("comments");
    ul.textContent = "";
    var c = sc.comments || {};
    if (c.error) ul.appendChild(el("li", c.error, "muted"));
    var items = c.items || [];
    if (!items.length && !c.error) ul.appendChild(el("li", "No open comments.", "muted"));
    items.forEach(function (it) {
      var li = el("li");
      var txt = el("div", null, "txt");
      txt.appendChild(el("div", (it.kind === "suggestion" ? "Suggestion" : "Comment") + " · " + (it.commenter || "unknown") + " · trust: " + it.trust, "muted"));
      // Texto de terceros (untrustedText, AX-02) o del owner (plano): solo textContent
      // (dato, nunca markup ni instrucción).
      var t = it.untrustedText || it;
      if (it.untrustedText) txt.appendChild(el("div", "Third-party text", "muted"));
      if (t.body) txt.appendChild(el("div", t.body));
      if (it.kind === "suggestion") {
        txt.appendChild(el("div", "Replace: " + (t.exact || ""), "muted"));
        txt.appendChild(el("div", "With: " + (t.replacement || ""), "muted"));
      }
      li.appendChild(txt);
      if (it.kind === "suggestion" && !sc.thirdParty) {
        var b = el("button", "Ask to review", "btn");
        b.addEventListener("click", function () {
          askChat("Review suggestion " + it.id + " on my Outbox page " + sc.page.user + "/" + sc.page.slug + " and show me exact → replacement before accepting (outbox_accept_suggestion).");
        });
        li.appendChild(b);
      }
      ul.appendChild(li);
    });
    if (c.total > items.length) ul.appendChild(el("li", (c.total - items.length) + " more not shown.", "muted"));
    if (c.omittedAnonymous) ul.appendChild(el("li", c.omittedAnonymous + " anonymous (share link) comments hidden.", "muted"));
  }

  function loadPreview() {
    var page = state.data && state.data.page;
    if (!page) return Promise.resolve(null);
    if (state.previewHtml !== null) return Promise.resolve(state.previewHtml);
    $("loadPreview").disabled = true;
    return request("tools/call", { name: "outbox_page_preview", arguments: { slug: page.slug, user: page.user } })
      .then(function (r) {
        var sc = r && r.structuredContent;
        if (!sc || typeof sc.html !== "string") throw new Error("Preview unavailable.");
        state.previewHtml = sc.html;
        if (sc.truncated) $("previewNote").textContent = "Preview truncated (" + sc.bytes + " characters stored).";
        return sc.html;
      })
      .catch(function (e) { showError(e.message); $("loadPreview").disabled = false; return null; });
  }

  $("loadPreview").addEventListener("click", function () {
    loadPreview().then(function (html) {
      if (html === null) return;
      var frame = $("frame");
      frame.setAttribute("sandbox", "");
      frame.srcdoc = '<meta http-equiv="Content-Security-Policy" content="' + PREVIEW_CSP + '">' + html;
      frame.hidden = false;
      $("text").hidden = true;
      reportSize();
    });
  });
  $("textOnly").addEventListener("click", function () {
    loadPreview().then(function (html) {
      if (html === null) return;
      // DOMParser no ejecuta scripts ni carga recursos: solo extrae el texto.
      var doc = new DOMParser().parseFromString(html, "text/html");
      Array.prototype.forEach.call(doc.querySelectorAll("script,style,noscript,template"), function (n) { n.remove(); });
      $("text").textContent = (doc.body && doc.body.textContent || "").replace(/\\n{3,}/g, "\\n\\n").trim();
      $("text").hidden = false;
      $("frame").hidden = true;
      reportSize();
    });
  });
  $("open").addEventListener("click", function () {
    var page = state.data && state.data.page;
    if (page && page.url) request("ui/open-link", { url: page.url }).catch(function (e) { showError(e.message); });
  });
  $("fullscreen").addEventListener("click", function () {
    request("ui/request-display-mode", { mode: "fullscreen" }).catch(function () {});
  });
  Array.prototype.forEach.call(document.querySelectorAll("nav button"), function (b) {
    b.addEventListener("click", function () {
      Array.prototype.forEach.call(document.querySelectorAll("nav button"), function (o) { o.setAttribute("aria-selected", String(o === b)); });
      Array.prototype.forEach.call(document.querySelectorAll("[data-panel]"), function (p) { p.hidden = p.getAttribute("data-panel") !== b.getAttribute("data-tab"); });
      reportSize();
    });
  });

  request("ui/initialize", {
    appInfo: { name: "outbox-page-viewer", version: "1.0.0" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    protocolVersion: ${JSON.stringify(MCP_APPS_PROTOCOL_VERSION)}
  }).then(function (res) {
    applyContext((res && res.hostContext) || {});
    notify("ui/notifications/initialized", {});
    reportSize();
  }).catch(function (e) { showError("Host handshake failed: " + e.message); });
})();
</script>
</body>
</html>
`;
