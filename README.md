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

**External action authority requires a witnessed v2 deployment and operator lease.**
IMMUNE seals admitted transitions into an append-only SHA-256 receipt chain.
Runtime availability is CONNECTING, REACHABLE, or UNAVAILABLE; write readiness
requires current source, deployment, ledger, durable state, and external authority
to agree. Historical self-signed v1 PASS states do not establish v2 readiness.
NEXUS results remain measured software simulations. Λ = Conjecture 1 OPEN.

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

`POST /api/immune/nexus/run` returns HTTP 201 with `governed.pass=true` only while
whole-system write readiness and SENTRA admission both pass. It returns 503
without execution when authority is unavailable. The table records a historical
software result, not current authority or deployment proof.

## Consolidation (do not delete either Space)

There are two Hugging Face Spaces. They are **one product, two channels** — not two immunes.

| Surface | What it is | Keep? |
|---|---|---|
| `SZLHOLDINGS/immune` | Channel A. TypeScript HUD + kernel; v2 governed writes require verified external authority and durable state. | **Keep.** Canonical public HUD. |
| `SZLHOLDINGS/immune-lattice` | Channel B. Privileged-control read-only Python kernel; catalog, verification, and historical receipts remain usable. Refused cycles may persist HUKLLA evidence. | **Keep the URL.** No independent action authority is claimed. |

This Grok Build COP (`src/lib/immune` TypeScript ↔ `python/immune` Python) is the kernel both channels must follow. Lattice is not a second product.

## Python kernel

Channel B readiness reports `RECEIPT_LEDGER_EMPTY` for an empty ledger whose
integrity check passes, and `RECEIPT_LEDGER_INTEGRITY_FAILED` for a corrupt ledger.
Both conditions keep `/readyz` at HTTP 503; external action authority is still
required before governed writes can become ready.
Unreadable or malformed persisted runtime bundles also fail ledger integrity;
they are retained for repair and cannot be overwritten by refused-cycle persistence.

```
python/
  immune/          canonical · sentra · huklla · persist · runtime · mesh · second_brain · frontier · organs · server
  tests/           unittest — fail-closed boot, refused writes, NEXUS verification, brain, silhouette, MESH
  space/           HF hologram HUD
```

```bash
pip install -r python/requirements.txt
IMMUNE_DATA_DIR=./data/immune PYTHONPATH=python python3 -m immune.server
PYTHONPATH=python python3 -m unittest discover -s python/tests -v
```

---

## What it demonstrates

IMMUNE checks an agent's intent before admitted execution and retains hash-linked
evidence. Current runtime and external authority must be verified separately;
source code or a historical receipt alone does not prove present enforcement.

| Layer | Codename | What it does |
|---|---|---|
| Admission gate | **SENTRA / GATE** | Inspects every intent for forbidden patterns (token exfiltration, shell escapes) and required fields. No fabricated green lights. |
| Receipt chain | **YAWAR** | Append-only SHA-256 ledger — each accepted action is hashed over canonical bytes and linked to the previous entry (`prevHash → hash`). Tamper any entry and re-verification breaks at that seq. |
| Tripwires | **HUKLLA** | 10 watchers aligned to the OWASP LLM Top 10 and MITRE ATLAS. A violation flips the system into **DEADMAN** (kill-switch) mode. |
| Threat intel | — | Live public feeds (Sigstore Rekor transparency log, NVD CVEs, GitHub/HF ecosystem) labelled `LIVE / REFERENCE / UNAVAILABLE` per source. |

The receipt chain is the same principle public transparency logs use, applied to every
AI-agent action.

## Lattice COP (RANGE / GHOST / WRAITH / ECHO / MESH / GRAPH)

Additive command surface in the public HUD. Its modeled object and effector
concepts are independently implemented under Doctrine v11. In an external-v2
deployment, write availability is governed by `/readyz` and the current
authority lease; the observed pre-v2 runtime is not that witness.

| Tab | What it does | Honesty bound |
|---|---|---|
| **RANGE** | White-hat counter-ops (`HUNT` `ISOLATE` `PATCH` `INTERDICT` `DECEIVE` `STRIKE`) against simulated adversary infrastructure. Sweep inbound RANGE in one governed pass. | `STRIKE` is RANGE-only. Live CISA/KEV objects accept isolate / hunt / patch. No packets at the public internet. |
| **GHOST** | RANGE hunter. Kill-chain against simulated C2. `AUTHORIZE` is a one-shot SENTRA-admit then autonomous RANGE chain. Operator command `hack people` is refused by SENTRA (`no.hack.persons`) and the refusal is logged. | Civilian, inbox, and identity targeting is fail-closed. Collapse RANGE personas only. |
| **WRAITH** | First-person infiltration of RANGE C2. Exploit nodes, plant honey tokens the persona eats, extract TTP. Attempting to hack people inverts the hunt: the intent becomes evidence. | RANGE personas only. Handler nodes are labeled RANGE PERSONA, never people. No packets. |
| **ECHO** | Deception theater. The RANGE persona is shown a fabricated success (BELIEF). YAWAR holds the ground truth (honey, tarpit, receipts they do not have). | Theater is RANGE. Nothing leaves the range. No civilian targeting. |
| **MESH** | Four-organ fusion: IMMUNE, a11oy, killinchu, Khipu-1.5B. 3-of-4 BFT silhouette. | Quorum is MODELED until a live BFT observation is wired. |
| **GRAPH** | Typed object graph: campaigns, organs, receipts, CVEs, named relations. | Nothing is a blended green blob. |

When `/readyz` reports `write_ready: true`, governed operations go through
`POST /api/immune/cycle` (SENTRA → optional YAWAR receipt → HUKLLA).
Otherwise the write path fails closed.
The external-v2 runtime image contains **no action-authority private key** and
never signs its own `PASS`. A configured canonical-main artifact contains only
public trust material: `IMMUNE_ACTION_PUBLIC_KEY`, the trust epoch, matching
Ed25519 possession proof, and the declared durable-volume binding. It never
contains the action signing key and starts with writes disabled (`READ_ONLY`
when runtime/read evidence is valid; otherwise `NOT_READY`). A separate manual owner
workflow may submit one short-admission, source-bound `immune.action.v2`
envelope after it proves protected main, the live source revision, runtime
integrity, audience, and public-key ID all agree. Home independently consumes
`/api/immune/state` and `/readyz`; governed-cycle controls require a fresh
exact binding across both responses. ThreeScene and the controls scroll region
remain authority-projection consumers.


## API

| Endpoint | What |
|---|---|
| `GET /readyz` | Exact source/build/runtime hash binding plus ledger integrity; reports runtime/read readiness separately from signed-authority/write readiness |
| `GET /api/immune/state` | Authoritative `VERIFIED / FAILED / UNAVAILABLE / STALE` state, signed-action receipt head, mode, tripwire, and YAWAR chain head |
| `POST /api/immune/state` | Verify and atomically apply a strict `immune.action.v2` Ed25519 envelope; v1 and unsigned controls are rejected |
| `POST /api/immune/cycle` | While whole-system `write_ready: true`, run one governed cycle: SENTRA inspect → (if accepted) append receipt → HUKLLA evaluate; otherwise HTTP 503 |
| `POST /api/immune/reset` | Apply a signed `RESET` envelope through the same authority path |
| `GET /api/immune/ledger/latest` | Last 25 SHA-256 receipts |
| `GET /api/immune/ledger/verify` | Recompute the whole chain from disk; `ok: true` on a clean chain |
| `GET /api/immune/evidence/latest` | Last 25 HUKLLA firing records |
| `GET /api/immune/intel/{frameworks,transparency,incidents,leaders,pulse}` | Live/curated threat intel |
| `GET /api/immune/agent/frontier` | Shadow-only Decision Genome capability and truth boundary |
| `POST /api/immune/agent/frontier/evaluate` | Validate one evidence observation and return a non-executable `MODELED` recommendation |

### Signed advisory authority

Privileged advisory controls are disabled unless `IMMUNE_ACTION_PUBLIC_KEY` is
canonical base64 for the trusted raw 32-byte Ed25519 public key and the exact
public trust epoch, possession proof, and durable-volume binding are qualified.
A public key alone does not establish an operational signer. Clients submit
a strict `immune.action.v2` envelope with a unique `requestId`; the signature
covers the canonical envelope without its `signature` field. The exact
audience is `hf-space:SZLHOLDINGS/immune`, and the exact source is
`szl-holdings/immune` plus the deployed lowercase 40-hex Git revision.
`trustEpoch`, a persisted random `authorityInstanceId`,
`expectedRevision`, and `expectedReceiptHash` are also signed. The server
compares that head binding under the SQLite write lock, so an older valid
`PASS` cannot arrive after and override a newer `DEADMAN`.
`expiresAt` is a command-admission deadline capped at five minutes.
`validUntil` is a separately signed state lease: `PASS` and `RESET` are
capped at 15 minutes, while fail-closed modes are capped at 24 hours. The
server rechecks both deadlines after acquiring the write lock. The signed
`actor` is a claim by the key holder, not a second identity attestation.

Accepted actions and resulting state are committed together under the keyed
database `/data/immune/authority-v2-<keyId>-<trustEpoch>.sqlite` in WAL/FULL mode.
The same database persists its random `authorityInstanceId`; losing or
replacing the database changes that instance ID and invalidates captured
envelopes. Production refuses to initialize action authority unless `/data`
is exactly one independently observed, writable provider bucket volume. The v1
database, if present, is inactive audit evidence and is never admitted into the
v2 authority epoch. Receipts are append-only, request IDs are single-use, and a
missing trust root, source drift, read failure, stale lease, CAS mismatch, or
chain mismatch can never render green. Exact receipt lookup by request ID and
envelope digest lets the owner workflow reconcile an applied action even if
the POST response is lost.

The deployed public pin is not a mutable development default. The build embeds an
exact `immune-action-trust.json` artifact containing the public key, public
`trustEpoch`, declared durable-storage binding, and an Ed25519 possession
proof over the repository/Space binding. That immutable artifact is the public
evidence that an owner-controlled matching signer existed at release time; a
placeholder pin or an unrelated private key cannot satisfy it.

The current canonical publisher preserves the bounded existing-Space contract:
it does not create Spaces, change visibility or settings, write Space variables,
or perform unbounded deletion. Its publication-boundary receipt records that
bounded operation; it is not a v2 authority activation or release attestation.
The required exact deployment-revision binding (`IMMUNE_EXPECTED_HF_REVISION`
and `HF_SPACE_REVISION`) must be independently provisioned and qualified under
a separate authorized activation procedure. This repair does not write those
values. The runtime trusts neither an undocumented `SPACE_REVISION` fallback
nor a deployment revision recovered from an older authority envelope.

Local source/tests/build, canonical publication, and v2 activation are separate
gates. This local repair does not claim deployment or current operational
authority. The canonical publisher's source checks and boundary receipt remain
unchanged; they do not substitute for the stronger activation contract. V2
activation remains **BLOCKED** until a separate qualification establishes an
exact-source release attestation, matching owner-held signer/public proof,
independently observed writable `/data` volume, and restart-persistent state.
Before signing or submitting an action, the owner workflow must require
terminal successful hosted CI and qualified canonical deployment evidence at
the same protected-main SHA, then re-verify immutable Hub artifacts, public key
ID and `trustEpoch`, live source/runtime binding, durable volume, and the exact
authority receipt head. It re-reads protected `main` again before POST.
`IMMUNE_ACTION_SIGNING_PKCS8_B64` is exposed only to that final signing step
and is never sent to Hugging Face.

If the POST response is lost or ambiguous, the workflow reads the receipt back
by both `requestId` and envelope digest. A matching receipt is success without
resending; an absent or contradictory receipt is a terminal fail-closed result,
not permission to replay the action.

`/readyz` remains explicit while that trust root is absent: verified immutable
runtime bytes and a clean receipt ledger may be `read_ready: true`, but the
contract stays `status: READ_ONLY`, `ready: false`, `authority_ready: false`,
and `write_ready: false` with blocker `ACTION_TRUST_ROOT_UNCONFIGURED`.
With a public pin but no current external action, the blocker is
`ACTION_AUTHORITY_UNAVAILABLE` or `ACTION_AUTHORITY_STALE`. Only an exact
current-source, externally signed `PASS` lease plus independently verified
durable YAWAR/HUKLLA storage can make the Space
`status: READY` / `write_ready: true`.

Hugging Face ephemeral storage does not establish global replay durability or
restart persistence. Production action authority remains unavailable, and
`PASS` cannot be submitted, until exactly one writable bucket volume is
provider-observed at `/data`. A release/source attestation is separate from
action authority; an action signature does not turn
`cryptographic_release_receipt` green.

Production evidence appends target `/data/immune/evidence`, never the image-local
seed. Before activation, the owner must preserve and migrate the exact existing
`ledger.jsonl` and `huklla_evidence.jsonl` bytes into that persistent directory,
verify the chain, and witness those same receipts after container replacement.
This change does not copy, reset, overwrite, or declare a new genesis for a live
chain. Missing/ephemeral evidence storage is explicitly
`RECEIPT_LEDGER_DURABILITY_UNVERIFIED`; an empty chain remains blocked. Action
SQLite persistence alone is insufficient evidence of whole-system durability.

The bounded publisher has no automatic rollback or settings-write path. A
failed or ambiguous publication is a terminal failure/uncertainty, not authority
activation. No failure may restore in-Space action self-signing. Any future
recovery requires its own exact-source review and authorization; this repair
does not grant one or mint a successful v2 release attestation.

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

## Build and canonical publication

After `pnpm install --frozen-lockfile`, run `pnpm run build`. The historical
`frontend/deploy/build-standalone.sh` command delegates to the same
cross-platform Node builder. It:

1. Builds the Vite frontend at site root (`BASE_PATH=/`).
2. Bundles `server/immune-standalone.ts` (all deps inlined) into a single `dist/immune-server.js` via esbuild.
3. Copies the built SPA to `dist/public/` and seeds the real chain into `dist/data/immune/`.

`frontend/deploy/Dockerfile` (Node 24 Alpine, non-root UID 1000, port 7860) copies that
`dist/` and runs `node immune-server.js`. See `frontend/deploy/README.md` for the exact commands.

> **Provenance note.** Installation, typecheck, build, and smoke tests establish
> local software evidence only. Canonical publication rebuilds from the exact
> merged GitHub revision and preserves the bounded publisher guards. Its
> publication-boundary receipt does not establish v2 authority, persistent
> restart safety, or current write readiness. Those require independently
> witnessed immutable Hub bytes, source binding, ledger and durable-state
> verification, and the external activation contract above. Shared Decision Genome concepts retain their
> canonical Platform origin; the Apache-2.0 schema is mirrored locally so the
> runtime no longer depends on a private workspace link. `/readyz` binds the
> exact source and build revisions to the deployment-manifest digest, canonical
> artifact-set digest, server/UI artifact hashes, and current ledger audit.

---

*SZL Holdings · Doctrine v11 · honest by design · Apache-2.0*

---

**Explore the SZL estate:** [a11oy console](https://a-11-oy.com) · [LLM Router](https://github.com/szl-holdings/szl-router) · [Receipt format spec](https://github.com/szl-holdings/governed-receipt-spec) · [Lean proofs](https://github.com/szl-holdings/lutar-lean) · [Docs](https://github.com/szl-holdings/docs-site) · [🤗 SZLHOLDINGS](https://huggingface.co/SZLHOLDINGS)
