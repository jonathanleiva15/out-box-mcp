/**
 * Gate de la pasada 4 (2026-09-30): cambios cross-repo que dejaron los fixers del worker
 * y del plugin.
 *  - outbox_pull devuelve `version` = `x-outbox-version` del MISMO response de export
 *    (structuredContent + bloque de texto ANTES del contenido, que sigue intacto y último).
 *  - outbox_list_keys traduce el 403 de GET /api/keys (agent key acotada) a un error
 *    accionable (`keys_list_forbidden`: usá una key humana).
 *  - 404 daily_not_found: fix específico (omití `date`), no "revisá con outbox_list".
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { z } from "zod";

import { registerOutboxTools } from "../dist/tools.js";
import { OutboxClient, OutboxApiError, describeError, formatError } from "../dist/services/client.js";
import { TOOLSETS } from "../dist/toolsets.js";

const DOC = "<!doctype html><html><body><h1>Nota</h1></body></html>";
const MD = "# Nota\n\nhola\n";

function setup({ lang, routes = {} } = {}) {
  const calls = [];
  const fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: init?.method ?? "GET" });
    if (url.pathname === "/api/capabilities") return Response.json({ features: { expectedVersion: true } });
    if (url.pathname === "/api/me") return Response.json({ user: "joni" });
    const r = routes[url.pathname];
    if (r) return r(url);
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  const client = new OutboxClient("outbox_test", { apiBase: "https://api.test", siteBase: "https://site.test", fetch });
  const tools = new Map();
  registerOutboxTools({ registerTool: (n, c, h) => tools.set(n, { c, h }) }, client, {
    toolsets: new Set(TOOLSETS),
    user: "joni",
    ...(lang ? { lang } : {}),
  });
  const call = async (name, args = {}) => {
    const t = tools.get(name);
    assert.ok(t, `tool ${name} no registrada`);
    return t.h(z.object(t.c.inputSchema).parse(args));
  };
  return { call, calls };
}

const exportRoute = (headers) => (url) =>
  url.searchParams.get("format") === "markdown"
    ? new Response(MD, { headers: { "content-type": "text/markdown", ...headers } })
    : new Response(DOC, { headers: { "content-type": "text/plain; charset=utf-8", "x-outbox-shell": "off", ...headers } });

describe("outbox_pull · version del mismo response (x-outbox-version)", () => {
  test("página propia: structuredContent.version + aviso antes del contenido (último bloque intacto)", async () => {
    const { call, calls } = setup({ routes: { "/api/u/joni/nota/export": exportRoute({ "x-outbox-version": "7" }) } });
    const r = await call("outbox_pull", { slug: "nota" });
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent.version, 7);
    assert.equal(r.structuredContent.thirdParty, false);
    assert.equal(r.content.at(-1).text, DOC, "el contenido es el último bloque, sin tocar");
    assert.match(r.content[0].text, /^version: 7 /);
    assert.match(r.content[0].text, /expectedVersion/);
    // Una sola lectura: la versión sale del MISMO response, no de un GET aparte.
    assert.deepEqual(calls.map((c) => c.path), ["/api/u/joni/nota/export"]);
  });

  test("format=markdown también devuelve la versión (lang en)", async () => {
    const { call } = setup({ lang: "en", routes: { "/api/u/joni/nota/export": exportRoute({ "x-outbox-version": "3" }) } });
    const r = await call("outbox_pull", { slug: "nota", format: "markdown" });
    assert.equal(r.structuredContent.version, 3);
    assert.equal(r.content.at(-1).text, MD);
    assert.match(r.content[0].text, /^version: 3 \(the version you just read/);
  });

  test("terceros: aviso de DATOS + versión + contenido, en ese orden", async () => {
    const { call } = setup({ routes: { "/api/u/ana/nota/export": exportRoute({ "x-outbox-version": "2" }) } });
    const r = await call("outbox_pull", { slug: "nota", user: "ana" });
    assert.equal(r.content.length, 3);
    assert.match(r.content[0].text, /terceros/);
    assert.match(r.content[1].text, /^version: 2 /);
    assert.equal(r.content[2].text, DOC);
    assert.equal(r.structuredContent.thirdParty, true);
  });

  test("sin header (back viejo): sin bloque de versión, el contenido sigue solo", async () => {
    const { call } = setup({ routes: { "/api/u/joni/nota/export": exportRoute({}) } });
    const r = await call("outbox_pull", { slug: "nota" });
    assert.equal(r.content.length, 1);
    assert.equal(r.content[0].text, DOC);
    assert.equal(r.structuredContent.version, undefined);
  });

  test("header inválido se ignora (nunca un expectedVersion basura)", async () => {
    const { call } = setup({ routes: { "/api/u/joni/nota/export": exportRoute({ "x-outbox-version": "abc" }) } });
    const r = await call("outbox_pull", { slug: "nota" });
    assert.equal(r.content.length, 1);
    assert.equal(r.structuredContent.version, undefined);
  });

  test("descripciones: expectedVersion apunta a la version de outbox_pull", async () => {
    const tools = new Map();
    const client = new OutboxClient("outbox_test", { apiBase: "https://api.test", fetch: async () => Response.json({}) });
    registerOutboxTools({ registerTool: (n, c, h) => tools.set(n, { c, h }) }, client, { toolsets: new Set(TOOLSETS), user: "joni", lang: "en" });
    const ev = tools.get("outbox_publish").c.inputSchema.expectedVersion.description;
    assert.match(ev, /outbox_pull/);
    assert.match(ev, /BEFORE the content/);
  });
});

describe("outbox_list_keys · 403 de una agent key acotada", () => {
  const forbidden = () =>
    Response.json(
      {
        error: "forbidden",
        missingAnyOf: ["admin:self", "audit:self", "genkey:joni"],
        hint: "Listar las API keys de la cuenta requiere una key humana.",
      },
      { status: 403 },
    );

  test("→ keys_list_forbidden con remedio 'key humana', no el 403 crudo", async () => {
    const { call } = setup({ routes: { "/api/keys": forbidden } });
    const r = await call("outbox_list_keys");
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.error.code, "keys_list_forbidden");
    assert.equal(r.structuredContent.error.status, 403);
    assert.deepEqual(r.structuredContent.error.missingAnyOf, ["admin:self", "audit:self", "genkey:joni"]);
    assert.match(r.content[0].text, /key de agente no puede ver el inventario/);
    assert.match(r.content[0].text, /key humana/);
  });

  test("otro 403 (sin missingAnyOf) sigue el camino genérico", async () => {
    const { call } = setup({ routes: { "/api/keys": () => Response.json({ error: "org_account_not_allowed" }, { status: 403 }) } });
    const r = await call("outbox_list_keys");
    assert.equal(r.structuredContent.error.code, "org_account_not_allowed");
  });
});

describe("404 daily_not_found", () => {
  const err = new OutboxApiError(404, { error: "daily_not_found", user: "joni", slug: "journal", date: "2026-09-01" }, "/api/daily/joni/journal");

  test("describeError: fix 'omití date', no el genérico de outbox_list", () => {
    const d = describeError(err);
    assert.equal(d.code, "daily_not_found");
    assert.equal(d.date, "2026-09-01");
    assert.match(d.fix, /Omití `date`/);
    assert.doesNotMatch(d.fix, /Revisá user\/slug con outbox_list/);
  });

  test("formatError: nombra el código y la fecha", () => {
    const t = formatError(err);
    assert.match(t, /^Error 404 \(daily_not_found, 2026-09-01\): No hay bloques para esa fecha/);
  });
});

describe("409 concurrent_update con Retry-After (worker pasada 4)", () => {
  test("describeError expone retryAfter (header) y sigue retryable", () => {
    const err = new OutboxApiError(409, { error: "concurrent_update", retryable: true, retryAfter: 1 }, "/api/u/joni/x/draft", 1);
    const d = describeError(err);
    assert.equal(d.code, "concurrent_update");
    assert.equal(d.retryable, true);
    assert.equal(d.retryAfter, 1);
  });
});
