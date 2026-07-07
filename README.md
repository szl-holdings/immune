> **SZL Holdings** · Doctrine v11 · Λ = Conjecture 1 (advisory, never "green"/theorem) · canonical [a-11-oy.com](https://a-11-oy.com)

# IMMUNE — Verifiable AI You Can't Fake

**Stage: LIVE · MEASURED.** IMMUNE is the governed AI safety layer: every accepted
agent action is sealed into an append-only, SHA-256 hash-linked receipt chain, and
every externally-sourced datum carries an honest `LIVE / REFERENCE / UNAVAILABLE`
provenance label. Nothing here is fabricated.

- **Live demo:** https://szlholdings-immune.hf.space (Hugging Face Docker Space `SZLHOLDINGS/immune`)
- **Org:** https://github.com/szl-holdings · License: Apache-2.0

---

## What it demonstrates

IMMUNE sits between an AI agent's *intent* and its *execution* and proves, cryptographically,
that the governance actually happened:

| Layer | Codename | What it does |
|---|---|---|
| Admission gate | **SENTRA / GATE** | Inspects every intent for forbidden patterns (token exfiltration, shell escapes) and required fields. No fabricated green lights. |
| Receipt chain | **YAWAR** | Append-only SHA-256 ledger — each accepted action is hashed over canonical bytes and linked to the previous entry (`prevHash → hash`). Tamper any entry and re-verification breaks at that seq. |
| Tripwires | **HUKLLA** | 10 watchers aligned to the OWASP LLM Top 10 and MITRE ATLAS. A violation flips the system into **DEADMAN** (kill-switch) mode. |
| Threat intel | — | Live public feeds (Sigstore Rekor transparency log, NVD CVEs, GitHub/HF ecosystem) labelled `LIVE / REFERENCE / UNAVAILABLE` per source. |

The receipt chain is the same principle public transparency logs use, applied to every
AI-agent action.

## API

| Endpoint | What |
|---|---|
| `GET /api/immune/state` | Current mode, active tripwire, deadman flag, ledger count + lastHash |
| `POST /api/immune/state` | Set mode (`PASS` / `SENTRA_REJECT` / `DEADMAN`) + tripwire |
| `POST /api/immune/cycle` | Run one governed cycle: SENTRA inspect → (if accepted) append receipt → HUKLLA evaluate |
| `POST /api/immune/reset` | Clear DEADMAN |
| `GET /api/immune/ledger/latest` | Last 25 SHA-256 receipts |
| `GET /api/immune/ledger/verify` | Recompute the whole chain from disk; `ok: true` on a clean chain |
| `GET /api/immune/evidence/latest` | Last 25 HUKLLA firing records |
| `GET /api/immune/intel/{frameworks,transparency,incidents,leaders,pulse}` | Live/curated threat intel |

## Repository layout

```
frontend/            React + Vite + Tailwind SPA ("cyber-HUD" UI, three.js + framer-motion)
  src/               App entry, Home page, panels (Controls, Audit, Intel, Pulse, Leaders), 3D scene
  deploy/            Dockerfile + build-standalone.sh + deploy README (assembles the HF Space image)
server/              Minimal standalone Express app for the demo
  immune-standalone.ts   Mounts ONLY /api/immune + serves the built SPA (no DB/auth/Bingle/Mulé)
  routes/immune/         canonical · sentra · huklla · ledger · state · intel · index
data/immune/         The REAL seeded receipt/evidence chain (ledger.jsonl, huklla_evidence.jsonl)
LEDGER_FIELD_KEYS.md Frozen ledger field-key decision (why `sentra` stays an internal hash-input key)
```

## Build & deploy (the live Hugging Face Space)

The self-contained image is assembled by `frontend/deploy/build-standalone.sh`, which:

1. Builds the Vite frontend at site root (`BASE_PATH=/`).
2. Bundles `server/immune-standalone.ts` (all deps inlined) into a single `dist/immune-server.js` via esbuild.
3. Copies the built SPA to `dist/public/` and seeds the real chain into `dist/data/immune/`.

`frontend/deploy/Dockerfile` (node:20-alpine, non-root UID 1000, port 7860) copies that
`dist/` and runs `node immune-server.js`. See `frontend/deploy/README.md` for the exact commands.

> **Provenance note.** Canonical development of IMMUNE happens inside the SZL Holdings pnpm
> monorepo (the frontend imports the shared `@workspace/*` client/zod libraries there). This
> repository is IMMUNE's public source-of-truth mirror and the home its live Space points to;
> the `deploy/` scripts run in that monorepo context. This is documented honestly rather than
> implying a hidden generator.

---

*SZL Holdings · Doctrine v11 · honest by design · Apache-2.0*
