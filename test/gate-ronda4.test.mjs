/**
 * Gate de la ronda 4 (2026-10-01): coherencia cross-repo del MCP stdio.
 *   1. `requestId` del body de error del worker (lib/request-id.ts) llega al error
 *      estructurado (describeError), con charset opaco.
 *   2. Los `examples` del JSON canónico de reglas de slug del worker
 *      (out-box/worker/src/lib/slug-rules.json) se cumplen con SLUG_SCHEMA + las
 *      reglas cargadas (vectores de conformidad).
 * Corren contra dist/ (lo que se shipea).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { loadSlugRules, makeSlugRejectionReason, slugRulesCandidates } from "./slug-rules.mjs";
import { OutboxApiError, describeError } from "../dist/services/client.js";
import { SLUG_SCHEMA } from "../dist/schemas.js";

test("describeError: requestId del body de error viaja en el error estructurado", () => {
  const e = new OutboxApiError(403, { error: "forbidden", missingScope: "list:joni", requestId: "8c1f2a3b4c5d6e7f-EZE" }, "/api/list");
  const d = describeError(e);
  assert.equal(d.code, "forbidden");
  assert.equal(d.requestId, "8c1f2a3b4c5d6e7f-EZE");
});

test("describeError: requestId con caracteres fuera del charset (o no string) se descarta", () => {
  for (const rid of ["id con espacios", "x\u0000y", "a".repeat(129), 42, null]) {
    const d = describeError(new OutboxApiError(500, { error: "internal", requestId: rid }, "/api/list"));
    assert.equal("requestId" in d, false, String(rid));
  }
  assert.equal("requestId" in describeError(new OutboxApiError(500, { error: "internal" }, "/api/list")), false);
});

const canonical = slugRulesCandidates().find((f) => existsSync(f));

test("slug: los examples del JSON canónico del worker se cumplen", { skip: canonical ? false : "sin JSON canónico del worker (repo hermano)" }, () => {
  const json = JSON.parse(readFileSync(canonical, "utf8"));
  assert.ok(Array.isArray(json.examples) && json.examples.length > 0, `${canonical}: sin examples`);
  const rules = loadSlugRules();
  assert.equal(rules.source, "json");
  const reason = makeSlugRejectionReason(rules, (s) => SLUG_SCHEMA.safeParse(s).success);
  for (const ex of json.examples) {
    assert.equal(reason(ex.slug), ex.expected, `slug ${JSON.stringify(ex.slug)}`);
  }
});
