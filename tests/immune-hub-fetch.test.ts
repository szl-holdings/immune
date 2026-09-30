import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithImmutableHubRedirect } from "../server/tools/immutable-hf-fetch";

const revision = "a".repeat(40);
const origin = "https://huggingface.co";
const url = `${origin}/spaces/SZLHOLDINGS/immune/resolve/${revision}/public/app.js`;
const cache = `/api/resolve-cache/spaces/SZLHOLDINGS/immune/${revision}/public/app.js`;

test("immutable Hub read follows the observed same-origin exact-file cache redirect", async () => {
  const calls: string[] = [];
  const response = await fetchWithImmutableHubRedirect(url, {headers:{Authorization:"Bearer test-only"}}, async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.redirect, "manual");
    assert.equal(new URL(String(input)).origin, origin);
    return calls.length === 1 ? new Response(null, {status:307, headers:{location:cache+"?etag=verified-by-caller"}}) : new Response("exact file bytes");
  });
  assert.equal(await response.text(), "exact file bytes");
  assert.equal(calls.length, 2);
});

test("redirected immutable reads cannot move credentials to a different trust boundary", async () => {
  for (const target of [
    "https://example.com/file", "http://huggingface.co"+cache,
    cache.replace(revision, "b".repeat(40)), cache.replace("immune/", "other/"),
    cache.replace("app.js", "other.js"), "https://user:pass@huggingface.co"+cache,
  ]) {
    let calls=0;
    await assert.rejects(fetchWithImmutableHubRedirect(url, {}, async()=>{
      calls++; return new Response(null,{status:307,headers:{location:target}});
    }), /changed origin, repository, revision or file/);
    assert.equal(calls,1);
  }
});

test("redirect loops are bounded and action/runtime requests never follow redirects", async()=>{
  let calls=0;
  await assert.rejects(fetchWithImmutableHubRedirect(url,{},async()=>{
    calls++;return new Response(null,{status:307,headers:{location:cache}});
  }),/redirect limit/);
  assert.equal(calls,3);
  for(const [request,method] of [[url,"POST"],["https://szlholdings-immune.hf.space/api/immune/actions","POST"],["https://api.github.com/repos/szl-holdings/immune/commits/main","GET"]]){
    await fetchWithImmutableHubRedirect(request,{method},async(_input,init)=>{
      assert.equal(init?.redirect,"error"); return new Response("{}");
    });
  }
});
