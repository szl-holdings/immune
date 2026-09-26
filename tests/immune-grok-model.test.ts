import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  ALLOWED_GROK_MODELS,
  DEFAULT_GROK_MODEL,
  resolveGrokModel,
} from "../server/routes/immune/grok-model";
import { chatComplete, inferenceConfigured, inferenceInfo } from "../server/routes/immune/inference";

// No live provider call is ever made here: global fetch is replaced by a stub
// for every test and the "key" below is a placeholder, not a credential.
const ENV_KEYS = [
  "XAI_API_KEY",
  "SZL_GROK_MODEL",
  "INFERENCE_BASE_URL",
  "INFERENCE_API_KEY",
  "INFERENCE_MODEL",
] as const;
const PLACEHOLDER_KEY = "test-placeholder-not-a-key";

const savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; body: any }> = [];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  fetchCalls = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    fetchCalls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: null }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = realFetch;
});

const MSG = [{ role: "user" as const, content: "ping" }];

test("pin is grok-4.7 with grok-4.5 as the single rollback target", () => {
  assert.equal(DEFAULT_GROK_MODEL, "grok-4.7");
  assert.deepEqual([...ALLOWED_GROK_MODELS], ["grok-4.7", "grok-4.5"]);
  assert.ok(Object.isFrozen(ALLOWED_GROK_MODELS));
});

test("resolveGrokModel: unset and blank use the default; allowlisted override is honoured (trimmed)", () => {
  assert.equal(resolveGrokModel({}), DEFAULT_GROK_MODEL);
  assert.equal(resolveGrokModel({ SZL_GROK_MODEL: "" }), DEFAULT_GROK_MODEL);
  assert.equal(resolveGrokModel({ SZL_GROK_MODEL: "   " }), DEFAULT_GROK_MODEL);
  assert.equal(resolveGrokModel({ SZL_GROK_MODEL: "grok-4.5" }), "grok-4.5");
  assert.equal(resolveGrokModel({ SZL_GROK_MODEL: "  grok-4.5\n" }), "grok-4.5");
});

test("resolveGrokModel: unlisted, alias or malformed ids fail closed (null), never the default", () => {
  for (const bad of ["grok-4.6", "grok-latest", "grok-4.7-latest", "GROK-4.7", "grok 4.7", "llama-3.3-70b-versatile"]) {
    assert.equal(resolveGrokModel({ SZL_GROK_MODEL: bad }), null, bad);
  }
});

test("xAI path sends DEFAULT_GROK_MODEL by default and discloses it", async () => {
  process.env.XAI_API_KEY = PLACEHOLDER_KEY;
  assert.equal(inferenceConfigured(), true);
  assert.deepEqual(inferenceInfo(), { configured: true, provider: "xAI", model: "grok-4.7" });

  const r = await chatComplete(MSG);
  assert.equal(r.content, "ok");
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://api.x.ai/v1/chat/completions");
  assert.equal(fetchCalls[0].body.model, "grok-4.7");
  // xAI rejects these on reasoning models; this path must never send them.
  for (const forbidden of ["stop", "presence_penalty", "frequency_penalty"]) {
    assert.equal(forbidden in fetchCalls[0].body, false, forbidden);
  }
});

test("blank SZL_GROK_MODEL uses the default on the xAI path", async () => {
  process.env.XAI_API_KEY = PLACEHOLDER_KEY;
  process.env.SZL_GROK_MODEL = "  ";
  await chatComplete(MSG);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].body.model, "grok-4.7");
  assert.equal(inferenceInfo().model, "grok-4.7");
});

test("SZL_GROK_MODEL rollback target grok-4.5 is honoured and disclosed", async () => {
  process.env.XAI_API_KEY = PLACEHOLDER_KEY;
  process.env.SZL_GROK_MODEL = "grok-4.5";
  assert.equal(inferenceInfo().model, "grok-4.5");
  await chatComplete(MSG);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].body.model, "grok-4.5");
});

test("well-formed but unlisted SZL_GROK_MODEL (grok-4.6) fails closed with zero provider calls", async () => {
  process.env.XAI_API_KEY = PLACEHOLDER_KEY;
  process.env.SZL_GROK_MODEL = "grok-4.6";
  assert.equal(inferenceConfigured(), false);
  assert.deepEqual(inferenceInfo(), { configured: false, provider: null, model: null });
  await assert.rejects(chatComplete(MSG), /inference not configured/);
  assert.equal(fetchCalls.length, 0);
});

test("missing XAI_API_KEY fails closed with zero provider calls", async () => {
  assert.equal(inferenceConfigured(), false);
  assert.deepEqual(inferenceInfo(), { configured: false, provider: null, model: null });
  await assert.rejects(chatComplete(MSG), /inference not configured/);
  assert.equal(fetchCalls.length, 0);
});

test("configured INFERENCE_* path is unaffected by SZL_GROK_MODEL", async () => {
  process.env.INFERENCE_BASE_URL = "https://api.groq.com/openai/v1/";
  process.env.INFERENCE_API_KEY = PLACEHOLDER_KEY;
  process.env.INFERENCE_MODEL = "llama-3.3-70b-versatile";
  process.env.XAI_API_KEY = PLACEHOLDER_KEY;
  process.env.SZL_GROK_MODEL = "grok-4.6";
  assert.deepEqual(inferenceInfo(), {
    configured: true,
    provider: "Groq",
    model: "llama-3.3-70b-versatile",
  });
  await chatComplete(MSG);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(fetchCalls[0].body.model, "llama-3.3-70b-versatile");
});

test("partial INFERENCE_* config with an xAI key discloses the Grok model actually called", async () => {
  process.env.INFERENCE_MODEL = "llama-3.3-70b-versatile";
  process.env.XAI_API_KEY = PLACEHOLDER_KEY;
  assert.equal(inferenceInfo().model, "grok-4.7");
  await chatComplete(MSG);
  assert.equal(fetchCalls[0].body.model, "grok-4.7");
});
