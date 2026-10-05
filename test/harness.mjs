/**
 * Harness compartido para tests de contrato: back HTTP simulado + server MCP real
 * (dist/index.js) por stdio con el Client del SDK. No es un test (no matchea
 * *.test.mjs): lo importan los archivos de test que necesitan su propia instancia
 * (toolsets, sin credencial, cliente con elicitation, OUTBOX_FILES_DIR propio).
 */
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_ENTRY = join(here, "..", "dist", "index.js");

/** Identidad por default de GET /api/me: la key activa del MCP es `feedbeef`. */
export const DEFAULT_ME = {
  user: "jonathan",
  keyId: "feedbeef",
  type: "agent",
  scopes: ["publish:jonathan", "list:jonathan"],
  authSource: "key",
};

/**
 * @param {object} opts
 * @param {Record<string,string>} [opts.env]    env extra del server (se mergea).
 * @param {boolean} [opts.withKey=true]         false = arrancar SIN credencial.
 * @param {object} [opts.me]                    respuesta de GET /api/me.
 * @param {object|null} [opts.capabilities]     respuesta de GET /api/capabilities (null = 404).
 * @param {(req)=>object} [opts.elicit]         si está, el cliente declara elicitation y responde con esto.
 * @param {string} [opts.apiBase]               forzar OUTBOX_API_BASE (ej. host inalcanzable).
 */
export async function startHarness(opts = {}) {
  const state = {
    calls: [],
    respond: () => ({ status: 404, json: { error: "not_found" } }),
    elicitations: [],
  };
  const me = opts.me ?? DEFAULT_ME;
  const capabilities = opts.capabilities === undefined ? null : opts.capabilities;

  const http = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      const url = new URL(req.url, "http://mock");
      const ct = req.headers["content-type"] ?? "";
      let body;
      if (buf.length > 0) {
        body = ct.startsWith("application/json") ? JSON.parse(buf.toString("utf8")) : buf;
      }
      const call = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body,
      };
      // Identidad y capabilities fijas por instancia (el MCP las cachea por proceso):
      // no se registran en `calls` para que el orden de los tests no importe.
      if (call.method === "GET" && call.path === "/api/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(me));
        return;
      }
      if (call.method === "GET" && call.path === "/api/capabilities" && !opts.recordCapabilities) {
        if (capabilities === null) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not_found" }));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(capabilities));
        }
        return;
      }
      state.calls.push(call);
      const r = state.respond(call) ?? { status: 404, json: { error: "not_found" } };
      const status = r.status ?? 200;
      const headers = { ...(r.headers ?? {}) };
      if (r.text !== undefined) {
        res.writeHead(status, { "content-type": r.contentType ?? "text/html; charset=utf-8", ...headers });
        res.end(r.text);
      } else {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(r.json ?? {}));
      }
    });
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${http.address().port}`;

  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    OUTBOX_USER: "jonathan",
    OUTBOX_API_BASE: opts.apiBase ?? base,
    OUTBOX_SITE_BASE: base,
    OUTBOX_RC: join(here, "no-existe.outboxrc"),
    // La suite cubre los textos en español del stdio; el default (inglés) tiene su test.
    OUTBOX_LANG: "es",
    ...(opts.withKey === false ? {} : { OUTBOX_API_KEY: "outbox_test_harness_key" }),
    ...(opts.env ?? {}),
  };
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], env, stderr: "pipe" });
  const client = new Client(
    { name: "harness", version: "0.0.0" },
    opts.elicit ? { capabilities: { elicitation: {} } } : undefined,
  );
  if (opts.elicit) {
    client.setRequestHandler("elicitation/create", async (req) => {
      state.elicitations.push(req.params);
      return opts.elicit(req.params);
    });
  }
  await client.connect(transport);

  async function call(name, args = {}) {
    try {
      const r = await client.callTool({ name, arguments: args });
      return {
        isError: Boolean(r.isError),
        text: r.content?.[0]?.text ?? "",
        content: r.content ?? [],
        structured: r.structuredContent,
      };
    } catch (e) {
      return { isError: true, text: String(e?.message ?? e), content: [], structured: undefined };
    }
  }

  return {
    client,
    base,
    call,
    get calls() {
      return state.calls;
    },
    get elicitations() {
      return state.elicitations;
    },
    reset() {
      state.calls = [];
      state.elicitations = [];
      state.respond = () => ({ status: 404, json: { error: "not_found" } });
    },
    set respond(fn) {
      state.respond = fn;
    },
    async close() {
      await client.close();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}
