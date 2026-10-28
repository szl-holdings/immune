// Finding #7 (Appendix I): canonical.ts assigned own JSON `__proto__` keys into a
// plain `{}`, so accepted data could vanish from the hashed projection, and the TS
// and Python canonical forms disagreed on key order / numbers / Unicode.
//
// Two contracts are pinned here:
//   1. Legacy v1 (`canonicalBytes`, `hashCanonical`) stays byte-identical so every
//      existing receipt keeps verifying exactly as before. Do not "fix" these goldens.
//   2. A NEW, separately versioned strict profile (`szl.immune.canonical/v2`) fails
//      closed on `__proto__`, never drops an accepted own key, orders keys by UTF-16
//      code units, and matches the shared cross-language vectors.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as canonical from "../server/routes/immune/canonical.ts";

const { CanonicalError, canonicalBytes, hashCanonical, sha256Hex } = canonical;
// v2 surface is looked up dynamically so each requirement fails on its own before
// the profile exists (RED), instead of the whole file failing to link.
const v2 = canonical as unknown as {
  CANONICAL_V2_PROFILE: string;
  CanonicalV2Error: new (...args: never[]) => Error & { code: string };
  canonicalBytesV2(value: unknown): Buffer;
  hashCanonicalV2(value: unknown): { hash: string; bytes: Buffer; profile: string };
};

const VECTORS = JSON.parse(
  readFileSync(new URL("../contracts/immune-canonical-v2-vectors.json", import.meta.url), "utf8"),
) as {
  profile: string;
  vectors: Array<{ id: string; input: string; canonical?: string; sha256?: string; error?: string }>;
};

function v2Code(value: unknown): string {
  try {
    v2.canonicalBytesV2(value);
  } catch (error) {
    assert.ok(error instanceof CanonicalError, `expected CanonicalError, got ${String(error)}`);
    assert.ok(error instanceof v2.CanonicalV2Error, "expected CanonicalV2Error");
    return (error as Error & { code: string }).code;
  }
  return "accepted";
}

// ---------------------------------------------------------------------------
// 1. Legacy v1: byte-identical characterization (measured at base 70754c5a).
// ---------------------------------------------------------------------------

const LEGACY_GOLDEN: Array<[string, string, string]> = [
  // [id, JSON text, sha256 of legacy canonicalBytes at base]
  ["proto_obj", '{"__proto__":{"x":1},"b":2}', "0ab1a6d394cd30195f0642b67ae1180c375ffadf5dd7f39c390668b5fdb6da93"],
  ["proto_prim", '{"__proto__":7,"b":2}', "0ab1a6d394cd30195f0642b67ae1180c375ffadf5dd7f39c390668b5fdb6da93"],
  ["proto_null", '{"__proto__":null,"b":2}', "0ab1a6d394cd30195f0642b67ae1180c375ffadf5dd7f39c390668b5fdb6da93"],
  ["plain_b", '{"b":2}', "0ab1a6d394cd30195f0642b67ae1180c375ffadf5dd7f39c390668b5fdb6da93"],
  ["nested_proto", '{"a":{"__proto__":{"secret":"s"},"k":1}}', "0ec333771037945268d0b897a4d97089edbeb3e83c91dd60ded08c3dda2a5363"],
  ["ctor", '{"constructor":{"x":1},"toString":2,"prototype":3}', "4b6c7286525e106403e34c7ec1923b866ba8c30e4fa41ed3274a79d455b8e567"],
  ["intkeys", '{"10":1,"9":2,"a":3,"-1":4,"01":5,"4294967295":6,"4294967294":7}', "8a409266926668becd621dfb8f07134b691337c07cb1b08d60530cf7214ad2af"],
  ["astral", '{"\\uffff":1,"\\ud83d\\ude00":2}', "48c5d098713870a7b88be7fc0ffc0a79e912d20f80ea8a4a5604426f49add103"],
  ["lone", '{"k":"\\ud800"}', "d6b17f36548f28d623847997546200dd6e58c682c7cba09be743ca7926d7fe7e"],
  ["float_int", '{"n":1.0}', "2bfd14f43d17fc7cea24e0917a8879b4b2f880b8baeec1b9d90fbaad655e71bd"],
  ["exp", '{"n":1e2}', "b39022c4ed96525c42cd0e7ce55308533962a655f1c19d5dac2f03e9dd995b2c"],
  ["negz", '{"n":-0}', "f3013f933b9fb80ab6d995e7ad9da36f683837ba1d81e950c943d40111eac2f0"],
  ["maxsafe", '{"n":9007199254740991}', "e1da48c6a6089f06ecb4e0a2259e658e3786b2420f52baccdf929ec6460d7b41"],
];

const RECEIPT_VIEW = {
  seq: 7,
  ts: "2026-10-28T00:00:00.000Z",
  prevHash: "GENESIS",
  payload: {
    actor: "operator",
    intent: "rotate keys",
    mode: "STRICT",
    sentra: { accepted: true, signatureMatched: "intent.required" },
    claims: { execution: "SOFTWARE", identity: "MEASURED" },
    adjacent: ["TRACE", "AIREP"],
    energy_j: null,
    nexusOrgan: true,
    agent: { goal: "g", step: 1, tool: "ledger_head", args: {}, thought: "t" },
  },
};
const RECEIPT_VIEW_LEGACY_SHA256 = "d619af17b2a7c3be0541317fde369d4071b1801026848927969d80a2c511de59";

test("legacy v1 canonicalBytes stays byte-identical for existing-record shapes", () => {
  for (const [id, text, sha] of LEGACY_GOLDEN) {
    assert.equal(sha256Hex(canonicalBytes(JSON.parse(text))), sha, id);
  }
  assert.equal(hashCanonical(RECEIPT_VIEW).hash, RECEIPT_VIEW_LEGACY_SHA256);
});

test("legacy v1 characterization: own __proto__ data is outside the hashed projection", () => {
  // This is the defect, pinned so legacy verification of any existing record is not
  // silently changed. New records must use the v2 profile, which rejects it.
  const withHidden = JSON.parse('{"payload":{"__proto__":{"secret":"A"},"ok":1}}');
  const otherHidden = JSON.parse('{"payload":{"__proto__":{"secret":"B"},"ok":1}}');
  assert.ok(Object.prototype.hasOwnProperty.call(withHidden.payload, "__proto__"));
  assert.deepEqual(canonicalBytes(withHidden), canonicalBytes(otherHidden));
  assert.equal(canonicalBytes(withHidden).toString("utf8"), '{"payload":{"ok":1}}');
  // The JSON line a ledger stores still carries the hidden subtree.
  assert.match(JSON.stringify(withHidden), /"__proto__":\{"secret":"A"\}/);
});

test("legacy v1 characterization: integer-like keys are reordered by the JS engine", () => {
  assert.equal(
    canonicalBytes(JSON.parse('{"10":1,"9":2,"a":3}')).toString("utf8"),
    '{"9":2,"10":1,"a":3}',
  );
});

// ---------------------------------------------------------------------------
// 2. v2 strict profile requirements (new version tag; RED before implementation).
// ---------------------------------------------------------------------------

test("v2 profile is exported under its own version tag", () => {
  assert.equal(v2.CANONICAL_V2_PROFILE, "szl.immune.canonical/v2");
  assert.equal(VECTORS.profile, v2.CANONICAL_V2_PROFILE);
  const out = v2.hashCanonicalV2({ a: 1 });
  assert.equal(out.profile, "szl.immune.canonical/v2");
  assert.equal(out.hash, sha256Hex(out.bytes));
});

test("v2 rejects own __proto__ keys at every depth, whatever the value type", () => {
  for (const text of [
    '{"__proto__":{"x":1},"b":2}',
    '{"__proto__":7}',
    '{"__proto__":null}',
    '{"__proto__":[]}',
    '{"a":{"k":1,"__proto__":{"secret":"s"}}}',
    '[{"__proto__":{}}]',
    '{"a":[[{"b":{"__proto__":"x"}}]]}',
  ]) {
    assert.equal(v2Code(JSON.parse(text)), "proto_key", text);
  }
  // Null-prototype carrier made in code is rejected the same way.
  const bare = Object.create(null) as Record<string, unknown>;
  bare["__proto__"] = { x: 1 };
  assert.equal(v2Code({ wrap: bare }), "proto_key");
});

test("v2 never drops an accepted own key: accepted output round-trips to the input", () => {
  for (const text of [
    '{"constructor":{"x":1},"toString":2,"prototype":3,"hasOwnProperty":4,"valueOf":5}',
    '{"10":1,"9":2,"a":3,"-1":4,"01":5,"4294967295":6,"4294967294":7}',
    '{"\\uffff":1,"\\ud83d\\ude00":2,"\\u00e9":3,"z":4}',
    '{"a":{"b":{"c":[1,{"d":null}]}},"e":true}',
  ]) {
    const input = JSON.parse(text);
    const bytes = v2.canonicalBytesV2(input);
    assert.deepEqual(JSON.parse(bytes.toString("utf8")), input, text);
    assert.equal(Object.keys(JSON.parse(bytes.toString("utf8"))).length, Object.keys(input).length);
  }
});

test("v2 orders keys by UTF-16 code units, including integer-like keys", () => {
  assert.equal(
    v2.canonicalBytesV2(JSON.parse('{"10":1,"9":2,"a":3}')).toString("utf8"),
    '{"10":1,"9":2,"a":3}',
  );
  assert.equal(
    v2.canonicalBytesV2(JSON.parse('{"\\uffff":1,"\\ud83d\\ude00":2}')).toString("utf8"),
    '{"\u{1F600}":2,"￿":1}',
  );
});

test("v2 Unicode: rejects lone surrogates; limits length in UTF-16 code units", () => {
  assert.equal(v2Code({ k: "\ud800" }), "lone_surrogate");
  assert.equal(v2Code({ k: "a\udc00b" }), "lone_surrogate");
  assert.equal(v2Code({ ["\udbff"]: 1 }), "lone_surrogate");
  assert.equal(v2Code({ k: "\u{1F600}".repeat(32_768) }), "accepted");
  assert.equal(v2Code({ k: "\u{1F600}".repeat(32_769) }), "too_long");
  assert.equal(v2Code({ k: "a".repeat(65_536) }), "accepted");
  assert.equal(v2Code({ k: "a".repeat(65_537) }), "too_long");
  assert.equal(v2Code({ ["k".repeat(65_537)]: 1 }), "too_long");
});

test("v2 numeric boundaries", () => {
  assert.equal(v2.canonicalBytesV2({ n: Number.MAX_SAFE_INTEGER }).toString(), '{"n":9007199254740991}');
  assert.equal(v2.canonicalBytesV2({ n: Number.MIN_SAFE_INTEGER }).toString(), '{"n":-9007199254740991}');
  assert.equal(v2.canonicalBytesV2({ n: -0 }).toString(), '{"n":0}');
  assert.equal(v2Code({ n: 2 ** 53 }), "unsafe_integer");
  assert.equal(v2Code({ n: -(2 ** 53) }), "unsafe_integer");
  assert.equal(v2Code({ n: 1e300 }), "unsafe_integer");
  assert.equal(v2Code({ n: 1.5 }), "non_integer");
  assert.equal(v2Code({ n: 1 + 1e-9 }), "non_integer");
  assert.equal(v2Code({ n: Number.NaN }), "non_integer");
  assert.equal(v2Code({ n: Number.POSITIVE_INFINITY }), "non_integer");
  assert.equal(v2Code({ n: 10n }), "unsupported_type");
});

test("v2 fails closed on values JSON cannot carry", () => {
  class Box {
    constructor(readonly a = 1) {}
  }
  assert.equal(v2Code({ d: new Date(0) }), "non_plain_object");
  assert.equal(v2Code({ m: new Map([["a", 1]]) }), "non_plain_object");
  assert.equal(v2Code({ b: new Box() }), "non_plain_object");
  assert.equal(v2Code({ u: undefined }), "unsupported_type");
  assert.equal(v2Code({ f: () => 1 }), "unsupported_type");
  // eslint-disable-next-line no-sparse-arrays
  assert.equal(v2Code({ a: [1, , 3] }), "sparse_array");
  const getter = {};
  Object.defineProperty(getter, "g", { enumerable: true, get: () => 1 });
  assert.equal(v2Code(getter), "non_plain_object");
  const hidden = { a: 1 };
  Object.defineProperty(hidden, "h", { enumerable: false, value: 2 });
  assert.equal(v2Code(hidden), "non_plain_object");
  assert.equal(v2Code({ [Symbol("s")]: 1 }), "non_plain_object");
  const nullProto = Object.create(null) as Record<string, unknown>;
  nullProto.a = 1;
  assert.equal(v2.canonicalBytesV2(nullProto).toString(), '{"a":1}');
});

test("v2 keeps legacy size and depth bounds", () => {
  assert.equal(v2Code({ s: "x".repeat(60_000), t: Array(20).fill("y".repeat(60_000)) }), "too_large");
  let deep: unknown = 0;
  for (let i = 0; i < 33; i++) deep = [deep];
  assert.equal(v2Code(deep), "depth");
});

test("v2 equals legacy bytes for ordinary receipt-shaped data (cheap migration)", () => {
  assert.deepEqual(v2.canonicalBytesV2(RECEIPT_VIEW), canonicalBytes(RECEIPT_VIEW));
});

test("v2 matches every shared TS/Python vector", () => {
  assert.ok(VECTORS.vectors.length >= 20);
  for (const vector of VECTORS.vectors) {
    const input = JSON.parse(vector.input);
    if (vector.error) {
      assert.equal(v2Code(input), vector.error, vector.id);
      continue;
    }
    const bytes = v2.canonicalBytesV2(input);
    assert.equal(bytes.toString("utf8"), vector.canonical, vector.id);
    assert.equal(sha256Hex(bytes), vector.sha256, vector.id);
  }
});
