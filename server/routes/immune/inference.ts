// OpenAI-compatible inference client for the live governed agent.
//
// Honesty + cost contract: configuration comes ONLY from env — no keys in the
// repo. "Our inference" is whatever SZL points these at (default intent: the
// org's cheap+fast Groq llama-3.3-70b). When unconfigured, inferenceConfigured()
// is false and callers must surface UNAVAILABLE rather than fabricate output.
//
//   INFERENCE_BASE_URL   e.g. https://api.groq.com/openai/v1
//   INFERENCE_API_KEY    bearer token (HF Space secret — never committed)
//   INFERENCE_MODEL      e.g. llama-3.3-70b-versatile

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function inferenceConfigured(): boolean {
  if (process.env.XAI_API_KEY) return true;
  return Boolean(
    process.env.INFERENCE_BASE_URL &&
      process.env.INFERENCE_API_KEY &&
      process.env.INFERENCE_MODEL,
  );
}

function providerLabel(): string {
  const url = (process.env.INFERENCE_BASE_URL || "").toLowerCase();
  if (url.includes("groq")) return "Groq";
  if (url.includes("openai")) return "OpenAI";
  if (url.includes("together")) return "Together";
  if (url.includes("anthropic")) return "Anthropic";
  if (url.includes("x.ai") || (!url && process.env.XAI_API_KEY)) return "xAI";
  try {
    return new URL(process.env.INFERENCE_BASE_URL || "").host || "custom";
  } catch {
    return process.env.XAI_API_KEY ? "xAI" : "custom";
  }
}

export function inferenceInfo(): {
  configured: boolean;
  provider: string | null;
  model: string | null;
} {
  const configured = inferenceConfigured();
  const groqModel = process.env.INFERENCE_MODEL ?? null;
  return {
    configured,
    provider: configured ? providerLabel() : null,
    model: configured ? groqModel ?? (process.env.XAI_API_KEY ? "grok-4.5" : null) : null,
  };
}

export interface ChatResult {
  content: string;
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null;
}

export async function chatComplete(
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {},
): Promise<ChatResult> {
  if (!inferenceConfigured()) {
    throw new Error("inference not configured");
  }
  const groqReady = Boolean(
    process.env.INFERENCE_BASE_URL && process.env.INFERENCE_API_KEY && process.env.INFERENCE_MODEL,
  );
  const base = groqReady
    ? (process.env.INFERENCE_BASE_URL as string).replace(/\/$/, "")
    : "https://api.x.ai/v1";
  const key = groqReady ? process.env.INFERENCE_API_KEY : process.env.XAI_API_KEY;
  const model = groqReady ? process.env.INFERENCE_MODEL : "grok-4.5";
  const url = `${base}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 25_000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: opts.maxTokens ?? 400,
        temperature: opts.temperature ?? 0.2,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`inference HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const json: any = await resp.json();
    const content: string = json?.choices?.[0]?.message?.content ?? "";
    const u = json?.usage ?? null;
    return {
      content,
      usage: u
        ? {
            promptTokens: u.prompt_tokens,
            completionTokens: u.completion_tokens,
            totalTokens: u.total_tokens,
          }
        : null,
    };
  } finally {
    clearTimeout(timeout);
  }
}
