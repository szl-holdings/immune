---
title: IMMUNE — Verifiable AI Defense Matrix
emoji: 🛡️
colorFrom: green
colorTo: blue
short_description: Fail-closed kernel. YAWAR seals Lorenz OP on hashes.
sdk: docker
app_port: 7860
pinned: false
license: apache-2.0
---

<p><a href="https://huggingface.co/spaces/SZLHOLDINGS/szl-command-lab"><img src="https://raw.githubusercontent.com/szl-holdings/.github/main/profile/assets/szl/logos/szl_mark_holographic.svg" alt="SZL Holdings" width="112" /></a></p>

# IMMUNE

Inspect governance-kernel state, tripwire boundaries and the source-owned NEXUS dynamics surface.

**Artifact:** Governance-kernel application · **Stage:** Action admission gated

[Explore in Command Lab](https://huggingface.co/spaces/SZLHOLDINGS/szl-command-lab) · [Build](https://github.com/szl-holdings/immune) · [Evidence](https://github.com/szl-holdings/immune/blob/54949d5a791fc3cd54d6261bdde22c861570d635/frontend/deploy/README.md)

## Before you use it

- Action authority requires the independently admitted trust lease and whole-system readiness evidence; serving this interface cannot grant itself PASS.
- Λ remains Conjecture 1. Missing ledger authority or real energy measurements remain unavailable.

<details>
<summary>Technical details and original evidence</summary>

The retained source below is exact and may contain historical observations. Its dates, use restrictions, licenses and evidence boundaries continue to apply.

<!-- SZL-PRESERVED-TECHNICAL-BODY:START -->

# IMMUNE — Channel A kernel

Public TypeScript kernel for IMMUNE. Not an investor-demo stub. SENTRA admits,
YAWAR seals SHA-256 receipts, HUKLLA tripwires, NEXUS counterfactual dynamics.

- Product tab: https://a-11-oy.com/immune
- Channel B sibling: https://szlholdings-immune-lattice.hf.space
- Source: https://github.com/szl-holdings/immune
- NEXUS UI: `/nexus.html`

One product, two URLs. Do not delete this Space or Channel B.

## Canonical NEXUS topology

- Public executable plane: this Space at `/nexus.html` and `/api/immune/nexus/*`.
- Dynamics source: `szl-holdings/nexus`; governed host: `szl-holdings/immune`.
- `betterwithage/nexus` is a private preservation mirror, not a second public product.
- Empty template probes are byte-archived before exact-SHA retirement; they are never promoted as source or runtime.

Status is CONNECTING / REACHABLE / UNAVAILABLE. Never fabricate LIVE or PASS.
Λ = Conjecture 1 OPEN. Energy is UNAVAILABLE unless a meter is actually read.

## Lorenz OP (measured)

With a current external-v2 lease and whole-system readiness, an admitted
`POST /api/immune/nexus/run` returns HTTP 201 and a hash-only YAWAR payload.
Without that authority the route returns 503 before execution. The table below
records historical software output, not proof of current write readiness.

| Field | Value |
|---|---|
| coefficients | σ 10 · ρ 27.9 · β 2.67 |
| final | −7.707920173353, −10.567955419679, 21.305498529338 |
| inputHash | `c5fcc5029392a5e4f7cd65a655d5379cd65d8f915b2ee96a1db5d44e35ea2358` |
| outputHash | `4071a2f2faca744907747cb2cc82a9d841e125fa287240505f9f9a8454a399ac` |
| truth | MEASURED_SOFTWARE_SIMULATION |

Channel B retains deterministic verification of these hashes; its privileged
action path remains read-only until a separate authority integration is released.

## License

Apache License 2.0. Third-party data retains upstream terms.

## What's in the image

- `immune-server.js` — Express kernel + SPA host
- `public/` — vite-built HUD including `nexus.html`
- `data/immune/` — append-only receipt + evidence chain
- `immune-action-trust.json` — public pin, trust epoch, owner possession proof,
  and durable-volume binding; never an action private key

Listens on `PORT` (default 7860). Contract: `GET /readyz`, `GET /api/immune/state`,
`GET /api/immune/nexus/status`, `POST /api/immune/nexus/run`.

## External authority activation

The serving image cannot sign its own PASS. Canonical publication first proves
the exact merged source and a read-only runtime. The separate owner action
workflow may then submit one short-lived `immune.action.v2` envelope, bound to
the exact source, Space revision, public key, durable store instance, and receipt
head. Missing or contradictory proof returns 503 and disables governed controls.

Production requires an owner-held Ed25519 signer with a matching public pin,
trust epoch and possession proof, plus a verified writable `/data` volume.
Deployment and operator actions share one mutation queue. The publisher sets
`IMMUNE_EXPECTED_HF_REVISION` and `HF_SPACE_REVISION` to the returned Hub commit,
reads both back twice, and independently verifies provider and runtime bytes.
See the source repository's external-authority activation guide for prerequisites
and the forward-only initial migration boundary.

<!-- SZL-PRESERVED-TECHNICAL-BODY:END -->

</details>
