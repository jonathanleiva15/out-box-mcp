/**
 * outbox_page_views (2026-10-15): el back suma `engagement`, `sources` y
 * `receipts[].lastRead` (capabilities v15). La tool los pasa tal cual y agrega
 * `readingSummary` (una línea) y `sourcesNotice` (los referrers son datos).
 * Host falso + cliente con fetch inyectado, igual que sandbox-platform-tools.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { registerOutboxTools } from "../dist/tools.js";
import { OutboxClient } from "../dist/services/client.js";
import { annotatePageViews, readingSummary, PAGE_VIEWS_SOURCES_NOTICE } from "../dist/tools/page-views.js";

function fakeHost() {
  const tools = new Map();
  return {
    tools,
    host: {
      registerTool(name, config, handler) {
        tools.set(name, { config, handler });
      },
    },
  };
}

function fakeClient(respond) {
  const calls = [];
  const client = new OutboxClient("outbox_test", {
    apiBase: "https://api.test",
    siteBase: "https://site.test",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? "GET", path: url.pathname });
      const r = respond({ path: url.pathname }) ?? { status: 404, json: { error: "not_found" } };
      return Response.json(r.json ?? {}, { status: r.status ?? 200 });
    },
  });
  return { client, calls };
}

const VIEWS = {
  user: "joni",
  slug: "propuesta",
  total: 3,
  today: 1,
  track: true,
  public: false,
  receipts: [{ user: "link:Laura · Acme", lastSeen: "2026-10-15T10:00:00.000Z", count: 2, lastRead: { at: "2026-10-15T10:05:00.000Z", activeSeconds: 125, maxScroll: 100 } }],
  firstViewedAt: "2026-10-14T09:00:00.000Z",
  firstViewer: "link:Laura · Acme",
  engagement: {
    reads: 3,
    activeSeconds: { median: 95, avg: 80.3, sampleSize: 3 },
    scrollDepth: { avgMax: 70, reached: { 25: 3, 50: 2, 75: 2, 100: 1 }, reachedPct: { 25: 100, 50: 67, 75: 67, 100: 33 } },
    recipients: [{ recipient: "Laura · Acme", at: "2026-10-15T10:05:00.000Z", activeSeconds: 125, maxScroll: 100, reads: 2 }],
  },
  sources: {
    visitors: 3,
    countries: [{ country: "AR", views: 2 }, { country: "US", views: 1 }],
    referrers: [{ host: "direct", views: 2 }, { host: "linkedin.com", views: 1 }],
  },
};

async function callViews(json, lang) {
  const h = fakeHost();
  const { client, calls } = fakeClient(({ path }) => (path.endsWith("/views") ? { json } : null));
  registerOutboxTools(h.host, client, { toolsets: new Set(["core"]), ...(lang ? { lang } : {}) });
  const t = h.tools.get("outbox_page_views");
  assert.ok(t, "outbox_page_views registrada");
  const res = await t.handler({ slug: "propuesta", user: "joni" });
  return { res, calls, config: t.config };
}

describe("outbox_page_views · lectura y fuentes", () => {
  test("pasa engagement, sources y lastRead tal cual y suma readingSummary + sourcesNotice", async () => {
    const { res, calls } = await callViews(VIEWS);
    assert.equal(res.isError, undefined);
    assert.equal(calls[0].path, "/api/u/joni/propuesta/views");
    const out = JSON.parse(res.content[0].text);
    assert.deepEqual(out.engagement, VIEWS.engagement);
    assert.deepEqual(out.sources, VIEWS.sources);
    assert.deepEqual(out.receipts[0].lastRead, VIEWS.receipts[0].lastRead);
    assert.match(out.readingSummary, /^3 lecturas medidas, tiempo activo mediano 1 min 35 s, promedio 1 min 20 s, 67% pasó la mitad, 33% llegó al final\./);
    assert.match(out.readingSummary, /Laura · Acme \(2 min 5 s, 100% scroll\)/);
    assert.equal(out.sourcesNotice, PAGE_VIEWS_SOURCES_NOTICE.es);
  });

  test("en inglés el resumen y el aviso salen en inglés", async () => {
    const { res, config } = await callViews(VIEWS, "en");
    const out = JSON.parse(res.content[0].text);
    assert.match(out.readingSummary, /^3 measured reads, median active time 1 min 35 s/);
    assert.equal(out.sourcesNotice, PAGE_VIEWS_SOURCES_NOTICE.en);
    assert.match(config.description, /engagement/);
    assert.match(config.description, /sources/);
    assert.doesNotMatch(config.description, /\b(página|lecturas|destinatario)\b/);
  });

  test("la descripción en español anuncia los campos nuevos", async () => {
    const { config } = await callViews(VIEWS);
    for (const f of ["engagement", "sources", "lastRead", "readingSummary"]) assert.ok(config.description.includes(f), f);
  });

  test("back viejo (sin engagement/sources): la respuesta queda igual", async () => {
    const old = { user: "joni", slug: "propuesta", total: 1, today: 0, track: true, public: false, receipts: [], firstViewedAt: null, firstViewer: null };
    const { res } = await callViews(old);
    assert.deepEqual(JSON.parse(res.content[0].text), old);
  });

  test("sin lecturas medidas: resumen explícito; sin referrers no hay aviso", () => {
    const out = annotatePageViews({ engagement: { reads: 0 }, sources: { visitors: 0, countries: [], referrers: [] } });
    assert.match(out.readingSummary, /Todavía no hay lecturas medidas/);
    assert.equal(out.sourcesNotice, undefined);
    assert.equal(readingSummary(undefined), null);
    assert.equal(annotatePageViews(null), null);
  });
});
