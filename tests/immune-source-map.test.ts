import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const rootRequire = createRequire(new URL("../package.json", import.meta.url));
const frontendRequire = createRequire(new URL("../frontend/package.json", import.meta.url));
const viteRequire = createRequire(rootRequire.resolve("vite"));
const tailwindViteRequire = createRequire(frontendRequire.resolve("@tailwindcss/vite"));
const parents = [
  ["postcss", createRequire(viteRequire.resolve("postcss"))],
  ["@tailwindcss/node", createRequire(tailwindViteRequire.resolve("@tailwindcss/node"))],
] as const;

const basicMap = { version: 3, sources: ["input.css"], names: [], mappings: "AAAA" };
const indexedMap = (line: number, map: object = basicMap) => ({
  version: 3, sections: [{ offset: { line, column: 0 }, map }],
});

for (const [parent, parentRequire] of parents) {
  const { SourceMapConsumer, SourceMapGenerator } = parentRequire("source-map-js");

  test(`${parent} resolves source-map-js with the CVE-2026-93749 fix`, () => {
    assert.equal(parentRequire("source-map-js/package.json").version, "1.2.2");
  });

  test(`${parent} rejects invalid and excessive indexed source-map offsets`, () => {
    for (const line of [-1, 0.5, Infinity, NaN]) {
      assert.throws(() => new SourceMapConsumer(indexedMap(line)), /non-negative integers/);
    }
    assert.throws(() => new SourceMapConsumer(indexedMap(10_000_001)), /must not exceed/);
    assert.throws(
      () => new SourceMapConsumer(indexedMap(6_000_000, indexedMap(6_000_000))),
      /including offsets of nested sections/,
    );
  });

  test(`${parent} retains ordinary source-map round trips`, () => {
    const generator = new SourceMapGenerator({ file: "output.css" });
    generator.addMapping({ source: "input.css", original: { line: 3, column: 2 }, generated: { line: 2, column: 4 } });
    generator.setSourceContent("input.css", "a { color: red }");
    const consumer = new SourceMapConsumer(generator.toJSON());
    assert.deepEqual(consumer.originalPositionFor({ line: 2, column: 4 }), {
      source: "input.css", line: 3, column: 2, name: null,
    });
    assert.equal(consumer.sourceContentFor("input.css"), "a { color: red }");
    const indexed = new SourceMapConsumer(indexedMap(2));
    const positions: number[] = [];
    indexed.eachMapping((mapping: { generatedLine: number }) => positions.push(mapping.generatedLine));
    assert.deepEqual(positions, [3]);
  });
}
