#!/usr/bin/env bash
# Build a single, self-contained IMMUNE deploy artifact:
#   dist/immune-server.js  — bundled minimal Express server (immune router + SPA host)
#   dist/public/           — vite-built static frontend (BASE_PATH=/)
#   dist/data/immune/      — the REAL append-only receipt/evidence chain (seeded)
#
# Output is what the Dockerfile copies. Run command (verified by acceptance):
#   ( cd artifacts/immune-demo/deploy/dist && PORT=7878 node immune-server.js )
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# deploy -> immune-demo -> artifacts -> repo root
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

DEPLOY_DIR="$SCRIPT_DIR"
DIST_DIR="$DEPLOY_DIR/dist"
API_SERVER_DIR="$REPO_ROOT/artifacts/api-server"
IMMUNE_DEMO_DIR="$REPO_ROOT/artifacts/immune-demo"
ESBUILD_BIN="$API_SERVER_DIR/node_modules/.bin/esbuild"

echo "[build-standalone] repo root      : $REPO_ROOT"
echo "[build-standalone] output dist dir: $DIST_DIR"

if [ ! -x "$ESBUILD_BIN" ]; then
  echo "[build-standalone] ERROR: esbuild not found at $ESBUILD_BIN" >&2
  echo "[build-standalone]        run 'pnpm install' first." >&2
  exit 1
fi

# 1) Build the static frontend at site root (BASE_PATH=/) -> immune-demo/dist/public
#    PORT is read at vite-config load time (even for a build) so we pass a placeholder;
#    it only affects the dev/preview server, not the static output.
echo "[build-standalone] (1/5) building immune-demo static frontend (BASE_PATH=/)..."
( cd "$REPO_ROOT" && BASE_PATH=/ PORT=5173 pnpm --filter @workspace/immune-demo run build )

# 2) Fresh dist
echo "[build-standalone] (2/5) preparing clean dist dir..."
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# 3) Bundle the standalone server into ONE self-contained ESM file (deps inlined).
#    NODE_ENV is baked to "production" so the pino logger takes its transport-free
#    branch (pino-pretty workers can't be statically bundled), keeping the artifact
#    a single runnable file with no extra worker dependencies.
echo "[build-standalone] (3/5) bundling immune-standalone server (esbuild)..."
"$ESBUILD_BIN" \
  "$API_SERVER_DIR/src/immune-standalone.ts" \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node20 \
  --packages=bundle \
  --legal-comments=none \
  --define:process.env.NODE_ENV='"production"' \
  --outfile="$DIST_DIR/immune-server.js" \
  --banner:js="import { createRequire as __immuneCreateRequire } from 'node:module'; globalThis.require = globalThis.require || __immuneCreateRequire(import.meta.url);"

# 4) Copy the built static frontend next to the server (dist/public)
echo "[build-standalone] (4/5) copying static frontend into dist/public..."
if [ ! -f "$IMMUNE_DEMO_DIR/dist/public/index.html" ]; then
  echo "[build-standalone] ERROR: expected $IMMUNE_DEMO_DIR/dist/public/index.html after build" >&2
  exit 1
fi
cp -R "$IMMUNE_DEMO_DIR/dist/public" "$DIST_DIR/public"

# 5) Seed the REAL immune ledger/evidence chain so /api/immune/state shows real history.
#    These files are copied verbatim — never regenerated or tampered.
echo "[build-standalone] (5/5) seeding real immune chain into dist/data/immune..."
mkdir -p "$DIST_DIR/data/immune"
if [ -f "$API_SERVER_DIR/data/immune/ledger.jsonl" ]; then
  cp "$API_SERVER_DIR/data/immune/ledger.jsonl" "$DIST_DIR/data/immune/ledger.jsonl"
  echo "[build-standalone]   seeded ledger.jsonl"
else
  echo "[build-standalone]   WARNING: ledger.jsonl not found — server will start a fresh chain"
fi
if [ -f "$API_SERVER_DIR/data/immune/huklla_evidence.jsonl" ]; then
  cp "$API_SERVER_DIR/data/immune/huklla_evidence.jsonl" "$DIST_DIR/data/immune/huklla_evidence.jsonl"
  echo "[build-standalone]   seeded huklla_evidence.jsonl"
fi

echo ""
echo "[build-standalone] DONE."
echo "[build-standalone] Bundle : $DIST_DIR/immune-server.js"
echo "[build-standalone] Static : $DIST_DIR/public"
echo "[build-standalone] Chain  : $DIST_DIR/data/immune"
echo ""
echo "Run locally:"
echo "  ( cd \"$DIST_DIR\" && PORT=7878 node immune-server.js )"
echo "Then:  curl -s localhost:7878/api/immune/state | head -c 400"
