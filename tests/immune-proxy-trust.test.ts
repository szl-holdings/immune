import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import express from "express";

const require = createRequire(import.meta.url);
// Test the copy Express actually loads, not an unrelated direct dependency.
const expressRequire = createRequire(require.resolve("express"));
const proxyAddr = expressRequire("proxy-addr");

test("Express resolves the reviewed proxy-addr security patch", () => {
  assert.equal(expressRequire("proxy-addr/package.json").version, "2.0.8");
});

test("short mapped-IPv6 prefixes never trust IPv4 peers", () => {
  // CVE-2026-90711 / GHSA-jqcg-44mw-7w3h. A short IPv6 prefix is not an IPv4 subnet.
  for (const prefix of [8, 16, 32, 95]) {
    for (const ranges of [[`::ffff:10.0.0.0/${prefix}`], [`::ffff:10.0.0.0/${prefix}`, "127.0.0.1/8"]]) {
      const trust = proxyAddr.compile(ranges);
      for (const peer of ["203.0.113.9", "10.0.0.42", "::ffff:203.0.113.9", "::ffff:10.0.0.42"]) {
        assert.equal(trust(peer), false, `${ranges.join(",")} must not trust ${peer}`);
      }
    }
  }
});

test("an untrusted peer cannot supply the accepted forwarded client address", () => {
  for (const peer of ["203.0.113.9", "::ffff:203.0.113.9"]) {
    const request = { socket: { remoteAddress: peer }, headers: { "x-forwarded-for": "10.0.0.42" } };
    for (const ranges of [["::ffff:10.0.0.0/8"], ["::ffff:10.0.0.0/8", "127.0.0.1/8"]]) {
      assert.equal(proxyAddr(request, proxyAddr.compile(ranges)), peer);
    }
  }
});

test("a correctly sized mapped subnet preserves its narrow IPv4 boundary", () => {
  const trust = proxyAddr.compile("::ffff:10.0.0.0/104");
  for (const peer of ["10.0.0.42", "::ffff:10.0.0.42"]) assert.equal(trust(peer), true);
  for (const peer of ["203.0.113.9", "::ffff:203.0.113.9", "2001:db8::1"]) assert.equal(trust(peer), false);
});

test("plain IPv4 trust ranges remain compatible", () => {
  const trust = proxyAddr.compile("10.0.0.0/8");
  assert.equal(trust("10.0.0.42"), true);
  assert.equal(trust("::ffff:10.0.0.42"), true);
  assert.equal(trust("203.0.113.9"), false);
});

test("native IPv6 ranges do not accidentally admit IPv4 or mapped peers", () => {
  const trust = proxyAddr.compile(["2001:db8::/32", "::ffff:10.0.0.0/8"]);
  assert.equal(trust("2001:db8::42"), true);
  for (const peer of ["2001:db9::42", "203.0.113.9", "::ffff:203.0.113.9"]) assert.equal(trust(peer), false);
});

test("the existing Express one-hop proxy configuration remains one-hop", () => {
  const app = express();
  app.set("trust proxy", 1);
  const trust = app.get("trust proxy fn");
  assert.equal(trust("127.0.0.1", 0), true);
  assert.equal(trust("203.0.113.9", 1), false);
  const request = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { "x-forwarded-for": "198.51.100.42, 203.0.113.9" },
  };
  assert.equal(proxyAddr(request, trust), "203.0.113.9");
});
