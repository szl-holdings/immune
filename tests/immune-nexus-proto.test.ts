// "__proto__" keys must be covered by nexusHash / canonicalizeForParity
// (same class as a11oy#3355). Ordinary hashes must stay unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nexusHash } from "../server/routes/immune/nexus-engine.ts";

const tampered = JSON.parse('{"amount":1,"__proto__":{"role":"admin"}}');
const plain = { amount: 1 };

test("nexusHash: __proto__ member is hashed (negative)", () => {
  assert.notEqual(nexusHash(tampered), nexusHash(plain));
});

test("nexusHash: nested and in-array __proto__ is hashed (negative)", () => {
  const nested = JSON.parse('{"a":{"__proto__":{"x":1}},"b":[{"__proto__":2}]}');
  const without = JSON.parse('{"a":{},"b":[{}]}');
  assert.notEqual(nexusHash(nested), nexusHash(without));
});

test("nexusHash: ordinary input hash unchanged (regression)", () => {
  assert.equal(
    nexusHash({ b: [2, { d: 1, c: null }], a: "x" }),
    "97939cac0bbffdcbf789ce8574619246a9addf586f27eb2e69cc621be5851de9",
  );
});
