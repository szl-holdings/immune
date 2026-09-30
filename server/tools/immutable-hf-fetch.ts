const HF_ORIGIN = "https://huggingface.co";
const IMMUTABLE = /^\/spaces\/SZLHOLDINGS\/immune\/resolve\/([a-f0-9]{40})\/(.+)$/u;

/** Follow only the Hub's same-origin, same-revision, same-file resolve-cache hop.
 * Runtime, GitHub and action POST requests retain redirect:error. Credentials
 * are never sent to a CDN, another repository, or a redirected action endpoint.
 */
export async function fetchWithImmutableHubRedirect(
  input: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const initial = new URL(input);
  const match = initial.origin === HF_ORIGIN && !initial.username && !initial.password
    ? IMMUTABLE.exec(initial.pathname) : null;
  const method = (init.method ?? "GET").toUpperCase();
  const options = { ...init, signal: init.signal ?? AbortSignal.timeout(20_000) };
  if (!match || !["GET", "HEAD"].includes(method)) {
    return fetchImpl(input, { ...options, redirect: "error" });
  }
  const expectedCachePath = `/api/resolve-cache/spaces/SZLHOLDINGS/immune/${match[1]}/${match[2]}`;
  let url = initial;
  for (let hop = 0; hop <= 2; hop += 1) {
    const result = await fetchImpl(url.href, { ...options, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(result.status)) return result;
    const location = result.headers.get("location");
    await result.body?.cancel();
    if (!location || hop === 2) throw new Error("immutable Hub redirect limit or location unavailable");
    const next = new URL(location, url);
    if (next.origin !== HF_ORIGIN || next.username || next.password
        || next.pathname !== expectedCachePath || next.hash) {
      throw new Error("immutable Hub redirect changed origin, repository, revision or file");
    }
    url = next;
  }
  throw new Error("immutable Hub redirect unavailable");
}
