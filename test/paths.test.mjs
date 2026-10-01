/**
 * Tests unitarios mínimos (node:test, sin infra extra — `npm run test`).
 * Corren contra dist/ (el script `test` compila primero con tsc), así se testea
 * exactamente lo que se shipea.
 *
 * Cubren los 2 bugs P1/P2 + follow-up del reviewer:
 *  - prefijo/slug anidado se encodea PER-SEGMENTO (los `/` se conservan; nunca %2F)
 *  - SLUG_SCHEMA / PREFIX_SCHEMA rechazan path traversal (`..`)
 *  - USER_SCHEMA / TEAM_HANDLE_SCHEMA rechazan dot-segments (`..`) que
 *    sobreviven encodeURIComponent y reescribirían segmentos de URL
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { encodeSlugPath } from "../dist/paths.js";
import {
  SLUG_SCHEMA,
  PREFIX_SCHEMA,
  USER_SCHEMA,
  TEAM_HANDLE_SCHEMA,
  SHARE_TOKEN_SCHEMA,
  GRANT_ID_SCHEMA,
  KEY_ID_SCHEMA,
} from "../dist/schemas.js";

test("encodeSlugPath conserva los '/' de un prefijo anidado (per-segmento, nunca %2F)", () => {
  assert.equal(encodeSlugPath("clientes/solera"), "clientes/solera");
  assert.equal(encodeSlugPath("clientes/solera/q3"), "clientes/solera/q3");
  assert.ok(!encodeSlugPath("a/b/c").includes("%2F"));
});

test("encodeSlugPath encodea chars especiales DENTRO del segmento, no el separador", () => {
  assert.equal(encodeSlugPath("a b/c#d"), "a%20b/c%23d");
  assert.equal(encodeSlugPath("solo-un-segmento"), "solo-un-segmento");
});

test("SLUG_SCHEMA rechaza path traversal", () => {
  assert.equal(SLUG_SCHEMA.safeParse("../x").success, false);
  assert.equal(SLUG_SCHEMA.safeParse("a/../b").success, false);
  assert.equal(SLUG_SCHEMA.safeParse("..").success, false);
  assert.equal(SLUG_SCHEMA.safeParse("./x").success, false);
});

test("SLUG_SCHEMA acepta slugs jerárquicos válidos", () => {
  assert.equal(SLUG_SCHEMA.safeParse("briefings/hoy").success, true);
  assert.equal(SLUG_SCHEMA.safeParse("clientes/solera/q3").success, true);
});

test("PREFIX_SCHEMA rechaza traversal, %2F pre-encodeado y slashes colgantes", () => {
  assert.equal(PREFIX_SCHEMA.safeParse("../x").success, false);
  assert.equal(PREFIX_SCHEMA.safeParse("clientes%2Fsolera").success, false);
  assert.equal(PREFIX_SCHEMA.safeParse("/clientes").success, false);
  assert.equal(PREFIX_SCHEMA.safeParse("clientes/").success, false);
  assert.equal(PREFIX_SCHEMA.safeParse("clientes/solera").success, true);
});

test("USER_SCHEMA y TEAM_HANDLE rechazan dot-segments ('..') y chars fuera del charset", () => {
  for (const schema of [USER_SCHEMA, TEAM_HANDLE_SCHEMA]) {
    assert.equal(schema.safeParse("..").success, false);
    assert.equal(schema.safeParse(".").success, false);
    assert.equal(schema.safeParse("../otro").success, false);
    assert.equal(schema.safeParse("jona/..").success, false);
    assert.equal(schema.safeParse("jon.doe").success, false); // punto excluido del charset
    assert.equal(schema.safeParse("a/b").success, false); // sin '/' en usernames/handles
    assert.equal(schema.safeParse("Jona").success, false); // backend solo acepta minúsculas
  }
});

test("USER_SCHEMA y TEAM_HANDLE aceptan usernames/handles canónicos del backend", () => {
  for (const schema of [USER_SCHEMA, TEAM_HANDLE_SCHEMA]) {
    assert.equal(schema.safeParse("jonathanleiva15").success, true);
    assert.equal(schema.safeParse("procontacto").success, true);
    assert.equal(schema.safeParse("a-b-2").success, true);
  }
});

// ── Schemas inline endurecidos: `owner` (outbox_publish) → TEAM_HANDLE_SCHEMA y
//    `fromUser` (outbox_instantiate_agent) → USER_SCHEMA. Ambos usan las regex
//    compartidas, así que rechazan dot-segments igual que el resto de user/handle.
test("owner/fromUser (TEAM_HANDLE_SCHEMA / USER_SCHEMA) rechazan dot-segments y traversal", () => {
  for (const schema of [TEAM_HANDLE_SCHEMA, USER_SCHEMA]) {
    assert.equal(schema.safeParse("..").success, false);
    assert.equal(schema.safeParse("../admin").success, false);
    assert.equal(schema.safeParse("org/..").success, false);
    assert.equal(schema.safeParse("a.b").success, false); // punto fuera del charset
    assert.equal(schema.safeParse("procontacto").success, true); // handle real sigue pasando
  }
});

// ── Hex-id schemas (revoke): mismo formato exacto que emite el worker. Los que
//    van en la URL (share token, grant id) NO pueden contener '/', '.' ni '%'.
test("SHARE_TOKEN_SCHEMA acepta 32 hex y rechaza longitudes/charset/traversal inválidos", () => {
  assert.equal(SHARE_TOKEN_SCHEMA.safeParse("a".repeat(32)).success, true);
  assert.equal(SHARE_TOKEN_SCHEMA.safeParse("0123456789abcdef0123456789abcdef").success, true);
  assert.equal(SHARE_TOKEN_SCHEMA.safeParse("a".repeat(31)).success, false); // corto
  assert.equal(SHARE_TOKEN_SCHEMA.safeParse("a".repeat(33)).success, false); // largo
  assert.equal(SHARE_TOKEN_SCHEMA.safeParse("A".repeat(32)).success, false); // mayúsculas
  assert.equal(SHARE_TOKEN_SCHEMA.safeParse("g".repeat(32)).success, false); // no-hex
  assert.equal(SHARE_TOKEN_SCHEMA.safeParse("../" + "a".repeat(29)).success, false); // traversal
  assert.equal(SHARE_TOKEN_SCHEMA.safeParse("a".repeat(30) + "%2").success, false);
});

test("GRANT_ID_SCHEMA acepta 16 hex y rechaza el resto", () => {
  assert.equal(GRANT_ID_SCHEMA.safeParse("0123456789abcdef").success, true);
  assert.equal(GRANT_ID_SCHEMA.safeParse("a".repeat(16)).success, true);
  assert.equal(GRANT_ID_SCHEMA.safeParse("a".repeat(15)).success, false);
  assert.equal(GRANT_ID_SCHEMA.safeParse("a".repeat(32)).success, false); // no es un share token
  assert.equal(GRANT_ID_SCHEMA.safeParse("../x/../../y/../z").success, false);
  assert.equal(GRANT_ID_SCHEMA.safeParse("XYZ0123456789abc").success, false);
});

test("KEY_ID_SCHEMA acepta 8 hex (shortKeyId) y rechaza el resto", () => {
  assert.equal(KEY_ID_SCHEMA.safeParse("0123abcd").success, true);
  assert.equal(KEY_ID_SCHEMA.safeParse("a".repeat(8)).success, true);
  assert.equal(KEY_ID_SCHEMA.safeParse("a".repeat(7)).success, false);
  assert.equal(KEY_ID_SCHEMA.safeParse("a".repeat(9)).success, false);
  assert.equal(KEY_ID_SCHEMA.safeParse("ABCDEF01").success, false); // mayúsculas
  assert.equal(KEY_ID_SCHEMA.safeParse("zzzzzzzz").success, false); // no-hex
});
