// Finding #1 (Appendix I) — offline only: no HTTP handler, inference, governed
// cycle or tool `.run` is executed by these tests.
//
// agent.ts dispatched `if (TOOLS[tool]) TOOLS[tool].run(args)` where TOOLS is a
// plain object literal and `tool` comes from model-generated JSON. Inherited names
// (constructor, toString, __proto__, hasOwnProperty, ...) are truthy on such an
// object, so they passed the gate and reached the `.run` lookup — after a receipt
// had already been appended for them.
//
// Narrow fix pinned here: tool resolution is own-property only. The wider authority
// design (external admission bound to tool, args digest, request, authority and
// expiry; rejection before receipt creation) is owner-gated: SPEC_agent_tool_admission.md.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as agent from "../server/routes/immune/agent";

const OWN_TOOLS = ["immune_state", "ledger_stats", "ledger_verify", "list_tripwires", "list_signatures"];
const INHERITED = [
  "constructor",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
];
const UNKNOWN = ["", "run", "desc", "IMMUNE_STATE", " immune_state", "immune_state\u0000", "ledger_stats.run"];

const route = readFileSync(new URL("../server/routes/immune/agent.ts", import.meta.url), "utf8");
const resolver = (agent as unknown as {
  resolveAgentTool?: (name: string) => { desc: string; run: unknown } | null;
}).resolveAgentTool;

test("generated output naming an inherited tool passes the step parser", () => {
  for (const tool of INHERITED) {
    const step = agent.parseModelStep(JSON.stringify({ action: { tool, args: {} } }));
    assert.equal(step?.action?.tool, tool, tool);
  }
});

test("characterization: bracket-truthiness on a plain object admits every inherited name", () => {
  // Same shape and predicate the base route used (const TOOLS = { ... }; if (TOOLS[tool])).
  const mirror: Record<string, { run: () => unknown }> = Object.fromEntries(
    OWN_TOOLS.map((name) => [name, { run: () => name }]),
  );
  for (const name of INHERITED) {
    assert.ok(mirror[name], `${name} is truthy on a plain object`);
    assert.equal(typeof (mirror[name] as { run?: unknown }).run, "undefined", `${name}.run lookup`);
  }
});

test("route dispatch never uses bracket truthiness on TOOLS", () => {
  assert.doesNotMatch(route, /if\s*\(\s*TOOLS\[\s*tool\s*\]\s*\)/);
  assert.doesNotMatch(route, /TOOLS\[\s*tool\s*\]\.run\(/);
  assert.match(route, /resolveAgentTool\(\s*tool\s*\)/);
});

test("only own tool names resolve; inherited and unknown names reach no .run", () => {
  assert.equal(typeof resolver, "function", "resolveAgentTool is exported");
  for (const name of OWN_TOOLS) {
    const entry = resolver!(name);
    assert.ok(entry, name);
    assert.equal(typeof entry.run, "function", name); // inspected, never called
  }
  for (const name of [...INHERITED, ...UNKNOWN]) {
    assert.equal(resolver!(name), null, JSON.stringify(name));
  }
});

test("inherited-name rejection survives Object.prototype pollution of `run`", () => {
  assert.equal(typeof resolver, "function", "resolveAgentTool is exported");
  const proto = Object.prototype as unknown as Record<string, unknown>;
  let called = 0;
  proto.run = () => {
    called += 1;
  };
  try {
    for (const name of [...INHERITED, ...UNKNOWN]) {
      assert.equal(resolver!(name), null, name);
    }
  } finally {
    delete proto.run;
  }
  assert.equal(called, 0);
});
