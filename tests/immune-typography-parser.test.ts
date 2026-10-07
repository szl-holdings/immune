import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const frontendRequire = createRequire(new URL("../frontend/package.json", import.meta.url));
const typographyRoot = path.dirname(frontendRequire.resolve("@tailwindcss/typography/package.json"));
const typographyRequire = createRequire(path.join(typographyRoot, "package.json"));
const typography = frontendRequire("@tailwindcss/typography");
const { commonTrailingPseudos } = typographyRequire("./src/utils.js");

test("typography resolves the compatibility-qualified security parser", () => {
  assert.equal(typographyRequire("postcss-selector-parser/package.json").version, "7.1.6");
});

test("selector pseudo-element extraction preserves typography semantics", () => {
  for (const [selector, expected] of [
    ["p", [null, "p"]],
    ["h1, h2", [null, "h1, h2"]],
    ["a::before", ["::before", "a"]],
    ["a::before, b::before", ["::before", "a, b"]],
    ["a::before, b::after", [null, "a::before, b::after"]],
    [":is(h1,h2)::before", ["::before", ":is(h1,h2)"]],
    ['[data-x="a,b"] > a:hover::after', ["::after", '[data-x="a,b"] > a:hover']],
    ["a:not(.x, .y)::marker", ["::marker", "a:not(.x, .y)"]],
    ["> :first-child", [null, "> :first-child"]],
    [':where([class~="prose"])', [null, ':where([class~="prose"])']],
    ["a\\:b::before", ["::before", "a\\:b"]],
    ["a::before::marker, b::before::marker", ["::before::marker", "a, b"]],
  ]) {
    assert.deepEqual(commonTrailingPseudos(selector), expected);
  }
});

// These hashes were independently compared with the complete output from the
// previously pinned parser 6.0.10; they preserve all typography component and
// variant selectors in four representative option configurations, not only
// the currently used source classes.
test("qualified typography configurations retain their pre-upgrade CSS objects", () => {
  const cases: [Record<string, string>, string][] = [
    [{}, "5793904208732d7b819e485c6b335a2604af59583e7ecc3963df21cbb22490d8"],
    [{ className: "article" }, "937e835ef1841b313f9f5f65b92567154f95ffad98806abdf811948c6a69f884"],
    [{ target: "legacy" }, "566d85cadc5f32e1f10425a04c4d87d4a307b125c4602c356b67fe6e9f04e8bf"],
    [{ className: "story", target: "modern" }, "d233e547a0113b347df9444a1518b9d2a0619c1fb53b0841668b452a045eb9f6"],
  ];
  for (const [options, expected] of cases) {
    const plugin = typography(options);
    const output: { variants: unknown[]; components: unknown[] } = { variants: [], components: [] };
    plugin.handler({
      addVariant: (...values: unknown[]) => output.variants.push(values),
      addComponents: (value: unknown) => output.components.push(value),
      theme: () => plugin.config.theme.typography,
      prefix: (value: string) => value,
    });
    assert.equal(createHash("sha256").update(JSON.stringify(output)).digest("hex"), expected);
  }
});
