/**
 * Regresiones de contrato MCP ↔ worker (2026-09-30, pasada 1):
 *  - El retry automático ante falla de red depende de `features.idempotencyEndpoints`,
 *    no del flag global `features.idempotency`: el worker lo anuncia aunque el append
 *    del daily y los comentarios NO deduplican, y el retry duplicaba bloque/comentario.
 *  - outbox_append acepta y manda `model` (el worker lo exige en el primer append de
 *    cada día UTC → 400 missing_model).
 *  - El schema de tags coincide con normalizeTags del worker (máx 20, 1-50 chars,
 *    [A-Za-z0-9._-]); antes el back descartaba en silencio lo que el MCP aceptaba.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { z } from "zod";

import { registerOutboxTools } from "../dist/tools.js";
import { OutboxClient, OutboxNetworkError } from "../dist/services/client.js";
import { buildInstructions } from "../dist/instructions.js";
import { TOOLSETS } from "../dist/toolsets.js";

/** Capabilities como las publica HOY el worker (capabilities.ts v8). */
const CAPS_V8 = { features: { idempotency: true, idempotencyEndpoints: ["publish", "publishFromTemplate"] } };

/**
 * Back falso: el PRIMER POST a cada path "se aplica" pero la respuesta se pierde
 * (TypeError de red, como un corte tras el commit). Cuenta cuántos POST llegan.
 */
function lossyBack(caps) {
  const posts = [];
  const seen = new Set();
  const fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/capabilities") return Response.json(caps);
    if (url.pathname === "/api/me") return Response.json({ user: "joni" });
    if ((init?.method ?? "GET") === "POST") {
      let body;
      try {
        body = init.body ? JSON.parse(init.body) : undefined;
      } catch {
        body = undefined;
      }
      posts.push({ path: url.pathname, key: init.headers["idempotency-key"], body });
      if (!seen.has(url.pathname)) {
        seen.add(url.pathname);
        throw new TypeError("fetch failed");
      }
      return Response.json({ ok: true });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  return { fetch, posts };
}

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

function setup(caps, lang) {
  const back = lossyBack(caps);
  const client = new OutboxClient("outbox_test", { apiBase: "https://api.test", siteBase: "https://site.test", fetch: back.fetch });
  const h = fakeHost();
  registerOutboxTools(h.host, client, { toolsets: new Set(TOOLSETS), user: "joni", ...(lang ? { lang } : {}) });
  const call = async (name, args) => {
    const t = h.tools.get(name);
    assert.ok(t, `tool ${name} no registrada`);
    const parsed = z.object(t.config.inputSchema).parse(args);
    return t.handler(parsed);
  };
  return { ...back, client, tools: h.tools, call };
}

describe("retry ante falla de red: solo operaciones en features.idempotencyEndpoints", () => {
  test("outbox_append / create_comment / create_suggestion NO reintentan si el back no los deduplica", async () => {
    const s = setup(CAPS_V8);
    const a = await s.call("outbox_append", { slug: "daily/hoy", html: "<p>x</p>" });
    assert.equal(a.isError, true);
    assert.equal(s.posts.filter((p) => p.path.endsWith("/append")).length, 1, "append duplicado por el retry");

    const s2 = setup(CAPS_V8);
    await s2.call("outbox_create_comment", { slug: "pagina", body: "hola" });
    assert.equal(s2.posts.filter((p) => p.path.endsWith("/comments")).length, 1, "comentario duplicado por el retry");

    const s3 = setup(CAPS_V8);
    await s3.call("outbox_create_suggestion", { slug: "pagina", exact: "a", replacement: "b" });
    assert.equal(s3.posts.filter((p) => p.path.endsWith("/comments")).length, 1, "sugerencia duplicada por el retry");
  });

  test("outbox_publish y publish_from_template SÍ reintentan (el back los deduplica) con la MISMA clave", async () => {
    const s = setup(CAPS_V8);
    const r = await s.call("outbox_publish", { slug: "p", html: "<p>x</p>", model: "m" });
    assert.notEqual(r.isError, true);
    const pubs = s.posts.filter((p) => p.path === "/publish");
    assert.equal(pubs.length, 2);
    assert.equal(pubs[0].key, pubs[1].key);

    const s2 = setup(CAPS_V8);
    const r2 = await s2.call("outbox_publish_from_template", { template: "t", data: {}, slug: "p", model: "m" });
    assert.notEqual(r2.isError, true);
    assert.equal(s2.posts.filter((p) => p.path === "/api/publish-from-template").length, 2);
  });

  test("cuando el back empiece a listar dailyAppend / comment, el retry se activa solo", async () => {
    const caps = { features: { idempotency: true, idempotencyEndpoints: ["publish", "publishFromTemplate", "dailyAppend", "comment"] } };
    const s = setup(caps);
    const a = await s.call("outbox_append", { slug: "daily/hoy", html: "<p>x</p>" });
    assert.notEqual(a.isError, true);
    assert.equal(s.posts.filter((p) => p.path.endsWith("/append")).length, 2);
    const s2 = setup(caps);
    await s2.call("outbox_create_comment", { slug: "pagina", body: "hola" });
    assert.equal(s2.posts.filter((p) => p.path.endsWith("/comments")).length, 2);
  });

  test("client: el flag global sin la lista de endpoints no habilita el retry", async () => {
    const back = lossyBack({ features: { idempotency: true } });
    const c = new OutboxClient("outbox_k", { apiBase: "https://api.test", fetch: back.fetch });
    await assert.rejects(
      () => c.req("/publish", { method: "POST", body: {}, idempotencyKey: "k-12345678", retryOnNetworkError: true, idempotencyOp: "publish" }),
      (e) => e instanceof OutboxNetworkError,
    );
    assert.equal(back.posts.length, 1);
    // Sin idempotencyOp tampoco (no hay forma de saber si el endpoint deduplica).
    const back2 = lossyBack(CAPS_V8);
    const c2 = new OutboxClient("outbox_k", { apiBase: "https://api.test", fetch: back2.fetch });
    await assert.rejects(() => c2.req("/publish", { method: "POST", body: {}, idempotencyKey: "k-12345678", retryOnNetworkError: true }));
    assert.equal(back2.posts.length, 1);
    assert.equal(await c2.supportsIdempotency("publish"), true);
    assert.equal(await c2.supportsIdempotency("dailyAppend"), false);
    assert.equal(await c2.supportsIdempotency("comment"), false);
  });

  test("las descripciones de append y comentarios no prometen dedupe por idempotencyKey (es y en)", () => {
    for (const lang of [undefined, "en"]) {
      const s = setup(CAPS_V8, lang);
      for (const name of ["outbox_append", "outbox_create_comment", "outbox_create_suggestion"]) {
        const cfg = s.tools.get(name).config;
        const keyDesc = cfg.inputSchema.idempotencyKey.description ?? "";
        assert.doesNotMatch(keyDesc, /el back no la duplica|not applied twice/i, `${name} (${lang ?? "es"})`);
        assert.match(keyDesc, /idempotencyEndpoints/, `${name} (${lang ?? "es"})`);
        assert.doesNotMatch(cfg.description, /reusá el mismo idempotencyKey/i, `${name} (${lang ?? "es"})`);
      }
      // publish sí deduplica: su descripción puede seguir prometiéndolo.
      assert.match(s.tools.get("outbox_publish").config.inputSchema.idempotencyKey.description, /duplica|twice/i);
    }
    const ins = buildInstructions(new Set(TOOLSETS), "https://site.test");
    assert.doesNotMatch(ins, /o repetila con el MISMO idempotencyKey\./);
    assert.match(ins, /idempotencyEndpoints/);
  });
});

describe("outbox_append manda `model` (400 missing_model en el primer append del día)", () => {
  function okBack() {
    const posts = [];
    const client = new OutboxClient("outbox_test", {
      apiBase: "https://api.test",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if ((init?.method ?? "GET") === "POST") posts.push({ path: url.pathname, body: JSON.parse(init.body) });
        return Response.json({ ok: true });
      },
    });
    const h = fakeHost();
    registerOutboxTools(h.host, client, { toolsets: new Set(["core"]), user: "joni" });
    const call = (args) => {
      const t = h.tools.get("outbox_append");
      return t.handler(z.object(t.config.inputSchema).parse(args));
    };
    return { posts, call, tools: h.tools };
  }

  test("sin model manda el default del MCP; con model/summary/contentType los pasa al body", async () => {
    const s = okBack();
    await s.call({ slug: "daily/hoy", html: "<p>x</p>" });
    assert.equal(s.posts[0].body.model, "outbox-mcp");
    await s.call({ slug: "daily/hoy", html: "<p>y</p>", model: "claude-opus-5-5", summary: "notas", contentType: "notes" });
    assert.equal(s.posts[1].body.model, "claude-opus-5-5");
    assert.equal(s.posts[1].body.summary, "notas");
    assert.equal(s.posts[1].body.contentType, "notes");
  });

  test("el schema acepta model y rechaza uno que el back daría por invalid_model", () => {
    const schema = z.object(okBack().tools.get("outbox_append").config.inputSchema);
    assert.equal(schema.safeParse({ slug: "d", html: "x", model: "gpt-4o" }).success, true);
    assert.equal(schema.safeParse({ slug: "d", html: "x", model: "modelo con espacios" }).success, false);
    assert.equal(schema.safeParse({ slug: "d", html: "x", model: "m".repeat(65) }).success, false);
  });
});

describe("tags alineados con normalizeTags del worker", () => {
  for (const name of ["outbox_publish", "outbox_publish_from_template"]) {
    test(`${name}: rechaza lo que el back descartaría en silencio`, () => {
      const h = fakeHost();
      registerOutboxTools(h.host, new OutboxClient("outbox_test", { fetch: async () => Response.json({}) }), {
        toolsets: new Set(TOOLSETS),
        user: "joni",
      });
      const tags = h.tools.get(name).config.inputSchema.tags;
      assert.equal(tags.safeParse(["Proyecto-Alpha", "q3.2026", "a_b"]).success, true);
      assert.equal(tags.safeParse(["proyecto alpha"]).success, false, "espacio");
      assert.equal(tags.safeParse(["ñandú"]).success, false, "charset");
      assert.equal(tags.safeParse(["x".repeat(51)]).success, false, "> 50 chars");
      assert.equal(tags.safeParse(Array.from({ length: 21 }, (_, i) => `t${i}`)).success, false, "> 20 tags");
      assert.equal(tags.safeParse(Array.from({ length: 20 }, (_, i) => `t${i}`)).success, true);
    });
  }
});
