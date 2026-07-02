---
title: IMMUNE Investor Demo
sdk: docker
app_port: 7860
pinned: false
license: other
---

# IMMUNE — Verifiable AI you can't fake

A self-contained deployment of the IMMUNE investor demo: a single Node process that
serves the static UI **and** the real IMMUNE API (`/api/immune/*`) — the append-only
SHA-256 receipt chain, the SENTRA admission gate, the HUKLLA tripwires, and the
live/reference threat-intelligence feeds (Sigstore Rekor, MITRE ATLAS, OWASP LLM Top 10).

Nothing here is faked. Receipts, hashes, and the chain verifier run for real; every
externally-sourced datum carries an honest provenance label (LIVE / REFERENCE /
UNAVAILABLE).

## What's in the image

- `immune-server.js` — minimal Express server (immune router + SPA host), all Node
  dependencies inlined by esbuild (no `npm install` at image build time).
- `public/` — the vite-built static frontend.
- `data/immune/` — the **real** append-only receipt + evidence chain, seeded at build.

The server mounts only the immune router at `/api/immune` (no Bingle/Mulé/auth/DB) and
falls back to `index.html` for all non-API routes (SPA). It listens on `PORT` (default
`7860`).

## Build the artifact

From the repository root (requires `pnpm install` to have run):

```bash
bash artifacts/immune-demo/deploy/build-standalone.sh
```

This:
1. builds the static frontend with `BASE_PATH=/` into `dist/public`,
2. bundles `src/immune-standalone.ts` into a single `dist/immune-server.js`,
3. copies the static frontend and the real receipt chain into `dist/`.

## Run it locally

```bash
( cd artifacts/immune-demo/deploy/dist && PORT=7878 node immune-server.js )
```

Verify:

```bash
curl -s localhost:7878/api/immune/state          # 200 with the real ledger count + lastHash
curl -s localhost:7878/api/immune/ledger/verify  # 200, ok:true over the real chain
curl -s localhost:7878/                           # the static demo UI
```

## Build & run the Docker image

The build context is **this `deploy/` directory**, and `dist/` must already exist
(run `build-standalone.sh` first):

```bash
cd artifacts/immune-demo/deploy
bash build-standalone.sh
docker build -t immune-demo .
docker run --rm -p 7860:7860 immune-demo
```

Then open http://localhost:7860 and hit `http://localhost:7860/api/immune/state`.

## Hugging Face Space (Docker SDK)

Push the contents of this `deploy/` directory (the `Dockerfile`, this `README.md`, and
the built `dist/`) to a Docker Space. The metadata header above (`sdk: docker`,
`app_port: 7860`) tells the Space how to build and expose the container. The ledger data
directory is made writable for the Space's non-root user so the chain can keep appending.
