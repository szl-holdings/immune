> **SZL Holdings** · Doctrine v11 · Λ = Conjecture 1 (advisory, never "green"/theorem) · canonical [a-11-oy.com](https://a-11-oy.com)

# IMMUNE — Verifiable AI You Can't Fake
<!-- szl:header v1 -->
<!-- badges: add this repo's CI / release / status badges here -->
[![org: szl-holdings](https://img.shields.io/badge/org-szl--holdings-black)](https://github.com/szl-holdings)
[![doctrine](https://img.shields.io/badge/doctrine-control%20before%20action%20%C2%B7%20evidence%20after-blue)](https://a-11-oy.com)

**Control before action. Evidence after.**

Part of the [szl-holdings](https://github.com/szl-holdings) estate ·
Product: [a-11-oy.com](https://a-11-oy.com) ·
Proof: [a11oy.net](https://a11oy.net)
<!-- /szl:header -->

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)

**Stage: REACHABLE · WRITE-READY · MEASURED software simulation.** IMMUNE is the
governed AI safety layer: every accepted agent action is sealed into an
append-only SHA-256 hash-linked receipt chain. Status is CONNECTING, REACHABLE,
or UNAVAILABLE — never a fabricated LIVE analog or PASS theorem. Λ = Conjecture 1 OPEN.

- **Product tab:** https://a-11-oy.com/immune
- **Channel A kernel HUD:** https://szlholdings-immune.hf.space (`SZLHOLDINGS/immune`)
- **Channel B Python COP:** https://szlholdings-immune-lattice.hf.space (`SZLHOLDINGS/immune-lattice`)
- **NEXUS plane:** https://szlholdings-immune.hf.space/nexus.html
- **Org:** https://github.com/szl-holdings · License: Apache-2.0

### Lorenz OP (measured, sealed)

Default NEXUS showcase on both Spaces. Software simulation only.

| Field | Value |
|---|---|
| program / mode | `lorenz` / `OP` |
| coefficients | σ 10 · ρ 27.9 · β 2.67 |
| steps / dt / drive / chaos / seed | 320 / 0.01 / 0.7 / 0.45 / 0.2 |
| initial | x 0.182 · y −0.046 · z 23.2 · t 0 |
| final | x −7.707920173353 · y −10.567955419679 · z 21.305498529338 · t 3.2 |
| inputHash | `c5fcc5029392a5e4f7cd65a655d5379cd65d8f915b2ee96a1db5d44e35ea2358` |
| outputHash | `4071a2f2faca744907747cb2cc82a9d841e125fa287240505f9f9a8454a399ac` |
| invariants | HOLD |
| energy | UNAVAILABLE |
| uniqueness | Conjecture 1 OPEN |
| truth | MEASURED_SOFTWARE_SIMULATION |
| Channel A/B parity | hashes match |

`POST /api/immune/nexus/run` returns HTTP 201 with `governed.pass=true` when SENTRA admits the compact YAWAR payload (hashes, not floats).

## Consolidation (do not delete either Space)

There are two Hugging Face Spaces. They are **one product, two channels** — not two immunes.

| Surface | What it is | Keep? |
|---|---|---|
| `SZLHOLDINGS/immune` | Channel A. TypeScript HUD + kernel. Already LIVE / WRITE-READY. Estate tiles, a11oy, killinchu handoff. | **Keep.** Canonical public HUD. |
| `SZLHOLDINGS/immune-lattice` | Channel B. This repo's `python/` kernel (stdlib HTTP, port 7860). | **Keep the URL.** Same receipts, same SENTRA/YAWAR/HUKLLA. |

This Grok Build COP (`src/lib/immune` TypeScript ↔ `python/immune` Python) is the kernel both channels must follow. Lattice is not a second product.

## Python kernel

```
python/
  immune/          canonical · sentra · huklla · persist · runtime · mesh · second_brain · frontier · organs · server
  tests/           unittest — boot WRITE-READY, cycle seal, DEADMAN, 575-handle brain, silhouette, MESH 3-of-4
  space/           HF hologram HUD
```

```bash
pip install -r python/requirements.txt
IMMUNE_DATA_DIR=./data/immune PYTHONPATH=python python3 -m immune.server
PYTHONPATH=python python3 -m unittest discover -s python/tests -v
```

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

## Lattice COP (RANGE / GHOST / WRAITH / ECHO / MESH / GRAPH)

Additive command surface on the live Space. Palantir object model, Anduril effector
tasking, CIA-style OSINT attribution — independently implemented under Doctrine v11.

| Tab | What it does | Honesty bound |
|---|---|---|
| **RANGE** | White-hat counter-ops (`HUNT` `ISOLATE` `PATCH` `INTERDICT` `DECEIVE` `STRIKE`) against simulated adversary infrastructure. Sweep inbound RANGE in one governed pass. | `STRIKE` is RANGE-only. Live CISA/KEV objects accept isolate / hunt / patch. No packets at the public internet. |
| **GHOST** | RANGE hunter. Kill-chain against simulated C2. `AUTHORIZE` is a one-shot SENTRA-admit then autonomous RANGE chain. Operator command `hack people` is refused by SENTRA (`no.hack.persons`) and the refusal is logged. | Civilian, inbox, and identity targeting is fail-closed. Collapse RANGE personas only. |
| **WRAITH** | First-person infiltration of RANGE C2. Exploit nodes, plant honey tokens the persona eats, extract TTP. Attempting to hack people inverts the hunt: the intent becomes evidence. | RANGE personas only. Handler nodes are labeled RANGE PERSONA, never people. No packets. |
| **ECHO** | Deception theater. The RANGE persona is shown a fabricated success (BELIEF). YAWAR holds the ground truth (honey, tarpit, receipts they do not have). | Theater is RANGE. Nothing leaves the range. No civilian targeting. |
| **MESH** | Four-organ fusion: IMMUNE, a11oy, killinchu, Khipu-1.5B. 3-of-4 BFT silhouette. | Quorum is MODELED until a live BFT observation is wired. |
| **GRAPH** | Typed object graph: campaigns, organs, receipts, CVEs, named relations. | Nothing is a blended green blob. |

Ops go through `POST /api/immune/cycle` (SENTRA → optional YAWAR receipt → HUKLLA).
The public Hugging Face Space boots a **labeled demo operator**
(`IMMUNE_DEMO_OPERATOR=1` in the demo image): process-local Ed25519 signs genesis
`SET_MODE PASS` and refreshes evidence so `/readyz` is `write_ready: true`.
The demo keypair is persisted under `IMMUNE_DATA_DIR/demo-operator.json` so a
process restart reuses the same trust root and receipt chain.
That key is **not an ATO**. Production deployments omit the flag, require
`IMMUNE_ACTION_PUBLIC_KEY`, and stay fail-closed `READ_ONLY` until a matching
signed envelope is applied. Home remains the sole `useGetImmuneState()`
authority query; ThreeScene and the controls scroll region are unchanged.


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
holds no operator private key unless `IMMUNE_DEMO_OPERATOR=1` or
`IMMUNE_ACTION_PRIVATE_KEY` is set on the server. With those flags the process
signs genesis `SET_MODE PASS` and auto-refreshes so evidence stays `VERIFIED`.
The demo operator is labeled `authority.demoOperator` and is not a production
ATO. Without them the UI accepts an already-signed envelope and is otherwise
read-only. `IMMUNE_EVIDENCE_MAX_AGE_MS` may override the default
15-minute freshness window; stale state remains observable but cannot authorize
a governed cycle.

`/readyz` remains explicit while that trust root is absent: verified immutable
runtime bytes and a clean receipt ledger may be `read_ready: true`, but the
contract stays `status: READ_ONLY`, `ready: false`, `authority_ready: false`,
and `write_ready: false` with blocker `ACTION_TRUST_ROOT_UNCONFIGURED`.
The public demo image sets `IMMUNE_DEMO_OPERATOR=1` so the live Space is
`status: READY` / `write_ready: true` after genesis.

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
