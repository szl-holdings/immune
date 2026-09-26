// Grok model pin for the xAI fallback path of the inference client.
//
// One reviewed constant: every xAI call site, disclosure and label in this
// repo derives from DEFAULT_GROK_MODEL, so no other Grok model literal exists.
//
// SZL_GROK_MODEL (server-side env only, never a VITE_/browser variable) may
// select another id, but only one that is listed in ALLOWED_GROK_MODELS: the
// pin itself plus the single rollback target. The value is trimmed; empty or
// whitespace uses the default. Anything else (a typo, an alias such as
// "grok-latest", or a well-formed but unreviewed id) resolves to null, and
// callers must fail closed with the existing honest UNAVAILABLE path and make
// no provider call. It never silently falls back to the default. Adding an id
// to ALLOWED_GROK_MODELS is itself the reviewed model change.

export const DEFAULT_GROK_MODEL = "grok-4.7";

/** The pin plus the previous live pin, kept as the single rollback target. */
export const ALLOWED_GROK_MODELS: readonly string[] = Object.freeze([DEFAULT_GROK_MODEL, "grok-4.5"]);

/**
 * Resolve the Grok model id for an xAI request.
 * Returns null when SZL_GROK_MODEL names an id outside ALLOWED_GROK_MODELS;
 * the caller must then fail closed without calling the provider.
 */
export function resolveGrokModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.SZL_GROK_MODEL;
  const requested = typeof raw === "string" ? raw.trim() : "";
  if (!requested) return DEFAULT_GROK_MODEL;
  return ALLOWED_GROK_MODELS.includes(requested) ? requested : null;
}
