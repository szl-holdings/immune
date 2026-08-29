> **SZL Holdings** · Doctrine v11 · Λ = Conjecture 1 (advisory, never "green"/theorem) · canonical [a-11-oy.com](https://a-11-oy.com)

# IMMUNE — Verifiable AI You Can't Fake

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)

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

## Lattice COP (RANGE / GHOST / MESH / GRAPH)

Additive command surface on the live Space. Palantir object model, Anduril effector
tasking, CIA-style OSINT attribution — independently implemented under Doctrine v11.

| Tab | What it does | Honesty bound |
|---|---|---|
| **RANGE** | White-hat counter-ops (`HUNT` `ISOLATE` `PATCH` `INTERDICT` `DECEIVE` `STRIKE`) against simulated adversary infrastructure. Sweep inbound RANGE in one governed pass. | `STRIKE` is RANGE-only. Live CISA/KEV objects accept isolate / hunt / patch. No packets at the public internet. |
| **GHOST** | RANGE hunter. Kill-chain against simulated C2. Operator command `hack people` is refused by SENTRA (`no.hack.persons`) and the refusal is logged. | Civilian, inbox, and identity targeting is fail-closed. Collapse RANGE personas only. |
| **MESH** | Four-organ fusion: IMMUNE, a11oy, killinchu, Khipu-1.5B. 3-of-4 BFT silhouette. | Quorum is MODELED until a live BFT observation is wired. |
| **GRAPH** | Typed object graph: campaigns, organs, receipts, CVEs, named relations. | Nothing is a blended green blob. |

Ops go through `POST /api/immune/cycle` (SENTRA → optional YAWAR receipt → HUKLLA).
The public Space is `READ_ONLY` without `IMMUNE_ACTION_PUBLIC_KEY`, so writes fail
closed and the UI labels the outcome `UNAVAILABLE` / `MODELED`. Home remains the
sole `useGetImmuneState()` authority query; ThreeScene and the controls scroll
region are unchanged.


## API

| Endpoint | What |
|---|---|
| `GET /readyz` | Exact source/build/runtime hash binding plus ledger integrity; reports runtime/read readiness separately from signed-authority/write readiness |
| `GET /api/immune/state` | Authoritative `VERIFIED / FAILED / UNAVAILABLE / STALE` state, signed-action receipt head, mode, tripwire, and YAWAR chain head |
| `POST /api/immune/state` | Verify and atomically apply an `immune.action.v1` Ed25519 envelope; unsigned controls are rejected |
| `POST /api/immune/cycle` | Run one governed cycle: SENTRA inspect → (if accepted) append receipt → HUKLLA evaluate |
| `POST /api/immune/reset` | Apply a signed `RESET` envelope through the same authority path |
| `GET /api/immune/ledger/latest` | Last 25 SHA-256 receipts |
| `GET /api/immune/ledger/verify` | Recompute the whole chain from disk; `ok: true` on a clean chain |
| `GET /api/immune/evidence/latest` | Last 25 HUKLLA firing records |
| `GET /api/immune/intel/{frameworks,transparency,incidents,leaders,pulse}` | Live/curated threat intel |
| `GET /api/immune/agent/frontier` | Shadow-only Decision Genome capability and truth boundary |
| `POST /api/immune/agent/frontier/evaluate` | Validate one evidence observation and return a non-executable `MODELED` recommendation |

### Signed advisory authority

Privileged advisory controls are disabled unless `IMMUNE_ACTION_PUBLIC_KEY` is
canonical base64 for the trusted raw 32-byte Ed25519 public key. Clients submit
a strict, short-lived `immune.action.v1` envelope with a unique `requestId`; the
signature covers the canonical envelope without its `signature` field.

Accepted actions and resulting state are committed together to
`data/immune/authority.sqlite` in WAL/FULL mode. Receipts are append-only,
request IDs remain single-use across restarts, and a missing trust root, read
failure, stale receipt, or chain mismatch can never render green. The public UI
holds no operator private key: it accepts an already-signed envelope and is
otherwise read-only. `IMMUNE_EVIDENCE_MAX_AGE_MS` may override the default
15-minute freshness window; stale state remains observable but cannot authorize
a governed cycle.

`/readyz` remains explicit while that trust root is absent: verified immutable
runtime bytes and a clean receipt ledger may be `read_ready: true`, but the
contract stays `status: READ_ONLY`, `ready: false`, `authority_ready: false`,
and `write_ready: false` with blocker `ACTION_TRUST_ROOT_UNCONFIGURED`.

The frontier evaluator consumes the shared
`@szl-holdings/contracts/decision-genome` schema from Platform. It does not
define a second contract, authorize an action, or claim measured detection
performance. Missing or stale provenance, future-dated evidence, and
insufficient calibration fail closed to review or withholding.
The receipt-writing evaluator shares the agent abuse budget (three accepted
requests per IP per minute and 300 accepted requests per UTC day) and returns
HTTP 409 when the governed cycle does not seal the recommendation.

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

After `pnpm install --frozen-lockfile`, run `pnpm run build`. The historical
`frontend/deploy/build-standalone.sh` command delegates to the same
cross-platform Node builder. It:

1. Builds the Vite frontend at site root (`BASE_PATH=/`).
2. Bundles `server/immune-standalone.ts` (all deps inlined) into a single `dist/immune-server.js` via esbuild.
3. Copies the built SPA to `dist/public/` and seeds the real chain into `dist/data/immune/`.

`frontend/deploy/Dockerfile` (Node 24 Alpine, non-root UID 1000, port 7860) copies that
`dist/` and runs `node immune-server.js`. See `frontend/deploy/README.md` for the exact commands.

> **Provenance note.** This repository is now independently installable,
> typecheckable, buildable, and smoke-testable. The deploy workflow always
> rebuilds from the exact merged GitHub revision, replaces the Space runtime
> whitelist, and verifies `/.well-known/szl-source.json` plus the live ledger
> before it reports success. Shared Decision Genome concepts retain their
> canonical Platform origin; the Apache-2.0 schema is mirrored locally so the
> runtime no longer depends on a private workspace link. `/readyz` binds the
> exact source and build revisions to the deployment-manifest digest, canonical
> artifact-set digest, server/UI artifact hashes, and current ledger audit.

---

*SZL Holdings · Doctrine v11 · honest by design · Apache-2.0*

---

**Explore the SZL estate:** [a11oy console](https://a-11-oy.com) · [LLM Router](https://github.com/szl-holdings/szl-router) · [Receipt format spec](https://github.com/szl-holdings/governed-receipt-spec) · [Lean proofs](https://github.com/szl-holdings/lutar-lean) · [Docs](https://github.com/szl-holdings/docs-site) · [🤗 SZLHOLDINGS](https://huggingface.co/SZLHOLDINGS)
