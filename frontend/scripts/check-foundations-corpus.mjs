#!/usr/bin/env node
/**
 * Foundations honesty guard.
 *
 * IMMUNE's "Mathematical Foundations" panel is only allowed to serve formulas
 * that trace back, verbatim, to a committed snapshot of the canonical
 * szl-holdings corpus. This guard enforces that doctrine:
 *
 *   render  ⊆  src/data/foundations.sources.json  ⊆  corpus/<repo>.md
 *
 * For every served entry it checks that (a) the source repo has a committed
 * corpus snapshot and (b) the entry's `anchor` string appears verbatim in it.
 * A served formula that is NOT in the corpus is a bug, not a feature.
 *
 * This lives INSIDE the IMMUNE artifact on purpose. It is NOT the szl-holdings
 * a11oy repo guard and must never be relocated there.
 *
 * Dependency-free: run with plain `node`.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CORPUS_DIR = join(ROOT, "corpus");
const MANIFEST = join(ROOT, "src", "data", "foundations.sources.json");

const VALID_MATURITY = new Set(["PROVEN", "CONJECTURE", "METHOD"]);

/** Read a committed corpus snapshot, or null if the repo has none. */
function loadCorpus(repo) {
  const p = join(CORPUS_DIR, `${repo}.md`);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** Validate one manifest entry against the corpus. Returns a list of errors. */
export function checkEntry(entry, loadText = loadCorpus) {
  const errs = [];
  const { id, repo, anchor, maturity } = entry ?? {};
  if (!id) errs.push("entry missing id");
  if (!repo) errs.push(`[${id}] missing repo`);
  if (!anchor) errs.push(`[${id}] missing anchor`);
  if (!VALID_MATURITY.has(maturity)) errs.push(`[${id}] invalid maturity: ${maturity}`);
  if (repo && anchor) {
    const text = loadText(repo);
    if (text === null) {
      errs.push(`[${id}] source repo "${repo}" has no committed corpus snapshot (corpus/${repo}.md missing)`);
    } else if (!text.includes(anchor)) {
      errs.push(`[${id}] anchor not found verbatim in corpus/${repo}.md: "${anchor}"`);
    }
  }
  return errs;
}

function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const errors = [];
  const seen = new Set();

  for (const entry of manifest) {
    if (seen.has(entry.id)) errors.push(`duplicate id: ${entry.id}`);
    seen.add(entry.id);
    errors.push(...checkEntry(entry));
  }

  // Negative self-test: the guard MUST reject a fabricated anchor. If it does
  // not, the honesty check itself is broken and this run fails loudly.
  const shouldFail = checkEntry({
    id: "__selftest__",
    repo: "lutar-lean",
    anchor: "this_formula_does_not_exist_in_any_repo",
    maturity: "PROVEN",
  });
  if (shouldFail.length === 0) {
    errors.push("SELF-TEST FAILED: guard accepted a fabricated anchor — the honesty check is broken");
  }

  if (errors.length) {
    console.error(`\n\u2717 Foundations honesty guard FAILED (${errors.length} problem(s)):`);
    for (const e of errors) console.error("  - " + e);
    console.error("\nA served formula that does not exist in the canonical corpus is a bug, not a feature.");
    process.exit(1);
  }

  console.log(
    `\u2713 Foundations honesty guard passed: ${manifest.length} served formulas all trace verbatim to a committed corpus snapshot.`,
  );
}

// Only run when invoked directly (allows importing checkEntry for reuse).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
