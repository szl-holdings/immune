#!/usr/bin/env bash
# Cross-platform build implementation lives in scripts/build-standalone.mjs.
# This wrapper remains for operators who use the historical command.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"
exec node scripts/build-standalone.mjs
