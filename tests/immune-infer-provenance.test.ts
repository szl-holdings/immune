// POST /infer authorship provenance. Offline: fetch is mocked, no provider is
// ever contacted, and the seal cycle is a recorder (no ledger write).
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import type { GovernedCycleResult, GovernedIntent } from "../server/routes/immune/cycle";
import {
  LOCAL_COMPOSE_MODEL,
  LOCAL_COMPOSE_PROVIDER,
  governedAnswer,
  localCompose,
} from "../server/routes/immune/infer-answer";
import { inferenceInfo } from "../server/routes/immune/inference";

const ENV_KEYS = ["XAI_API_KEY", "INFERENCE_BASE_URL", "INFERENCE_API_KEY", "INFERENCE_MODEL"] as const;
const PROMPT = "What is YAWAR and did SZL fine-tune the weights?";
const REMOTE_TEXT =
  "YAWAR is the append-only receipt bus; integrity is MEASURED. Λ is Conjecture 1 OPEN. SZL did not fine-tune these weights; this is a wrapper.";

const savedEnv = new Map<string, string | undefined>();
const realFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; body: any }> = [];

function useXai(): void {
  process.env.XAI_API_KEY = "test-key-not-a-real-credential";
}

function useGroq(): void {
  process.env.INFERENCE_BASE_URL = "https://api.groq.com/openai/v1";
  process.env.INFERENCE_API_KEY = "test-key-not-a-real-credential";
  process.env.INFERENCE_MODEL = "llama-3.3-70b-versatile";
}

function mockFetch(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    fetchCalls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return respond();
  }) as typeof fetch;
}

function completion(content: unknown, usage: Record<string, number> | null = null): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content, reasoning_content: "thinking tokens only" } }],
        usage,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

function recordingSeal(): {
  calls: Array<{ intent: GovernedIntent; extra?: Record<string, unknown> }>;
  seal: (intent: GovernedIntent, extra?: Record<string, unknown>) => Promise<GovernedCycleResult>;
} {
  const calls: Array<{ intent: GovernedIntent; extra?: Record<string, unknown> }> = [];
  return {
    calls,
    seal: async (intent, extra) => {
      calls.push({ intent, extra });
      return { pass: true, mode: "ARMED", deadman: false, receipt: null, payloadBytes: 0 } as unknown as GovernedCycleResult;
    },
  };
}

function assertLocalCompose(
  answer: Awaited<ReturnType<typeof governedAnswer>>,
  sealed: ReturnType<typeof recordingSeal>,
  remote: string,
): void {
  assert.equal(answer.provider, LOCAL_COMPOSE_PROVIDER);
  assert.equal(answer.model, LOCAL_COMPOSE_MODEL);
  assert.equal(answer.raw, localCompose(PROMPT));
  assert.deepEqual(answer.usage, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  assert.equal(sealed.calls.length, 1);
  assert.equal(sealed.calls[0].extra?.provider, LOCAL_COMPOSE_PROVIDER);
  assert.notEqual(sealed.calls[0].extra?.provider, remote);
  assert.doesNotMatch(JSON.stringify(sealed.calls[0].extra), new RegExp(remote, "i"));
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  fetchCalls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("HTTP 200 with empty content is labelled local compose, not xAI, in answer and seal", async () => {
  useXai();
  mockFetch(completion("", { prompt_tokens: 90, completion_tokens: 280, total_tokens: 370 }));
  const sealed = recordingSeal();
  const answer = await governedAnswer(PROMPT, sealed.seal);
  assert.equal(fetchCalls.length, 1, "the provider was attempted exactly once");
  assertLocalCompose(answer, sealed, "xAI");
  assert.doesNotMatch(answer.model, /grok/i);
});

test("HTTP 200 with whitespace-only content is labelled local compose, not xAI", async () => {
  useXai();
  mockFetch(completion("  \n\t  "));
  const sealed = recordingSeal();
  const answer = await governedAnswer(PROMPT, sealed.seal);
  assert.equal(fetchCalls.length, 1);
  assertLocalCompose(answer, sealed, "xAI");
});

test("HTTP 200 with null content or no choices is labelled local compose", async () => {
  useXai();
  mockFetch(completion(null));
  const nullSeal = recordingSeal();
  assertLocalCompose(await governedAnswer(PROMPT, nullSeal.seal), nullSeal, "xAI");

  mockFetch(() => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
  const emptySeal = recordingSeal();
  assertLocalCompose(await governedAnswer(PROMPT, emptySeal.seal), emptySeal, "xAI");
});

test("empty content from an INFERENCE_* provider is not attributed to that provider", async () => {
  useGroq();
  mockFetch(completion(""));
  const sealed = recordingSeal();
  const answer = await governedAnswer(PROMPT, sealed.seal);
  assert.equal(fetchCalls.length, 1);
  assertLocalCompose(answer, sealed, "Groq");
  assert.doesNotMatch(answer.model, /llama/i);
});

test("HTTP 200 with content keeps the configured provider/model label and usage", async () => {
  useXai();
  mockFetch(completion(REMOTE_TEXT, { prompt_tokens: 90, completion_tokens: 40, total_tokens: 130 }));
  const sealed = recordingSeal();
  const answer = await governedAnswer(PROMPT, sealed.seal);
  const info = inferenceInfo();
  assert.equal(info.provider, "xAI");
  assert.ok(info.model, "configured xAI path reports a model");
  assert.equal(answer.provider, "xAI");
  assert.equal(answer.model, info.model);
  assert.equal(answer.raw, REMOTE_TEXT);
  assert.deepEqual(answer.usage, { promptTokens: 90, completionTokens: 40, totalTokens: 130 });
  assert.equal(sealed.calls[0].extra?.provider, "xAI");
});

test("provider HTTP error and network failure are labelled local compose", async () => {
  useXai();
  mockFetch(() => new Response("upstream overloaded", { status: 503 }));
  const httpSeal = recordingSeal();
  assertLocalCompose(await governedAnswer(PROMPT, httpSeal.seal), httpSeal, "xAI");

  mockFetch(() => {
    throw new TypeError("fetch failed");
  });
  const netSeal = recordingSeal();
  assertLocalCompose(await governedAnswer(PROMPT, netSeal.seal), netSeal, "xAI");
});

test("unconfigured inference never calls fetch and is labelled local compose", async () => {
  mockFetch(completion(REMOTE_TEXT));
  const sealed = recordingSeal();
  const answer = await governedAnswer(PROMPT, sealed.seal);
  assert.equal(fetchCalls.length, 0);
  assertLocalCompose(answer, sealed, "xAI");
});

test("the provider request keeps max_tokens 280 and temperature 0.2", async () => {
  useXai();
  mockFetch(completion(REMOTE_TEXT));
  await governedAnswer(PROMPT, recordingSeal().seal);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://api.x.ai/v1/chat/completions");
  assert.equal(fetchCalls[0].body.max_tokens, 280);
  assert.equal(fetchCalls[0].body.temperature, 0.2);
  assert.equal(fetchCalls[0].body.model, inferenceInfo().model);
});

test("the sealed answer is the NEMO-gated text of the authored raw answer", async () => {
  useXai();
  mockFetch(completion(""));
  const sealed = recordingSeal();
  const answer = await governedAnswer(PROMPT, sealed.seal);
  assert.deepEqual(sealed.calls[0].intent, { actor: "immune:nemo-seal", intent: "seal nemo-gated answer" });
  assert.equal(sealed.calls[0].extra?.ok, answer.verdict.ok);
  assert.equal(sealed.calls[0].extra?.rewritten, answer.verdict.rewritten);
  assert.match(answer.text, /Governed compose \(SOFTWARE, not an LLM/);
});
