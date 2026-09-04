# IMMUNE NEXUS Consolidation

## Decision

NEXUS is consolidated into **IMMUNE** as the bounded **Counterfactual Dynamics Plane**.
It is not a sixth public product, an autonomous effector, a physical chip, or a
replacement for the standalone source repository.

- **Public product:** IMMUNE
- **Capability plane:** NEXUS
- **Source/provenance repository:** `szl-holdings/nexus`
- **Imported source revision:** `617fb49f061c9eb369c4d879a7c29af64c08e72e`
- **Operational routes:** `/api/immune/nexus/*`
- **Human interface:** `/nexus.html`
- **Authority:** simulation only; zero external calls and zero external effectors

## Why the consolidation is coherent

IMMUNE already governs intent through SENTRA, seals accepted actions through the
YAWAR receipt chain, evaluates HUKLLA tripwires, and exposes deterministic audit
readback. NEXUS contributes a distinct capability that IMMUNE did not previously
have: bounded nonlinear and neuromorphic **software dynamics** for deterministic
stress, replay, and counterfactual rehearsal.

The combined path is:

```text
strict request schema
        ↓
IMMUNE write-readiness
        ↓
SENTRA pre-admission
        ↓
NEXUS deterministic software execution
        ↓
finite/bound invariants
        ↓
SENTRA authority recheck
        ↓
YAWAR input/output receipt
        ↓
HUKLLA evidence record
        ↓
deterministic replay verification
```

No route accepts source code, shell text, URLs, target hosts, credentials, or an
external action. The NEXUS plane cannot open sockets, invoke subprocesses, mutate
hardware, or task an effector.

## Executable capability

Both runtime channels implement the same six programs:

| Program | Role inside IMMUNE | Executable boundary |
|---|---|---|
| Lorenz | chaotic-attractor stress surface | bounded deterministic integration |
| Harmonic | oscillator and sign-change witness | bounded deterministic integration |
| Van der Pol | nonlinear self-excited dynamics | bounded deterministic integration |
| Duffing | forced nonlinear counterfactual | bounded deterministic integration |
| Lotka–Volterra | coupled-system dynamics | positive-quadrant invariant |
| NEMO | five-organ AdEx dynamics and WILLAY optical field | software simulation; 20-cell bounded state |

Modes are `IC`, `OP`, `HALT`, and `REP`. Standard programs permit at most 2,400
steps per request; NEMO permits at most 400. The returned trail is decimated to a
bounded maximum. Input and output are SHA-256 addressed.

## Cross-language parity

The TypeScript and Python engines implement the same numeric operation order and
hash a nine-decimal canonical projection. The immutable vectors in
`contracts/immune-nexus-parity-v1.json` require all six TypeScript output hashes
to equal all six Python output hashes for the same source-bound inputs.

This closes a major prior weakness: the two IMMUNE channels no longer merely use
similar terminology; they produce the same deterministic NEXUS witness.

## API

| Method | Route | Contract |
|---|---|---|
| `GET` | `/api/immune/nexus/status` | source pin, limits, controls, current IMMUNE readiness |
| `GET` | `/api/immune/nexus/catalog` | six programs and four modes |
| `POST` | `/api/immune/nexus/run` | pre-admit, execute, verify invariants, receipt, evidence |
| `POST` | `/api/immune/nexus/verify` | deterministic read-only replay of an output hash |
| `GET` | `/api/immune/nexus/receipts/{requestId}` | exact accepted-run receipt readback |

`requestId` is idempotent. Reusing it with the same actor and input returns the
existing receipt after deterministic recomputation. Reusing it with a different
actor or input fails as `NEXUS_REQUEST_ID_COLLISION`.

## Truth labels

- Execution: `MEASURED_SOFTWARE_SIMULATION`
- Replay: `DERIVED_REPLAY`
- Optional caller-axis aggregate: `MODELED_FROM_CALLER_AXES`
- Energy: `UNAVAILABLE`
- Λ uniqueness: `Conjecture 1 OPEN`
- Physical chip: `false`
- External calls: `0`
- External effectors: `false`

## What remains in the NEXUS repository

The NEXUS repository remains the source and experimental laboratory for its
browser instrument, Web Audio experience, analog patches, and research lineage.
IMMUNE imports only the deterministic bounded engine required for governed
rehearsal. This avoids copying the entire product shell or creating competing
runtime authorities.

The standalone NEXUS Space must remain available until all retirement gates pass:

1. the IMMUNE branch is merged through protected main;
2. TypeScript/Python parity vectors are green;
3. the deployed IMMUNE source revision is exact;
4. `/api/immune/nexus/status`, `/run`, `/verify`, and receipt readback pass live;
5. one accepted run survives an IMMUNE process restart and verifies from YAWAR;
6. the current NEXUS source and Space are preserved by revision and receipt;
7. the standalone Space is converted to an explicit migration tombstone or archived;
8. no unique secret, dataset, or user artifact is stranded.

Deletion before those gates is prohibited.

## Production hardening still required beyond the public demo

This change makes NEXUS executable and governed inside the current IMMUNE runtime.
It does not fabricate enterprise identity or durable infrastructure. Production
promotion still requires:

- OIDC-derived actor identity rather than caller-asserted actor text;
- tenant-scoped durable state and receipts;
- managed backup/restore and restart-persistence proof;
- distributed rate limiting;
- SLOs, telemetry, alerts, and incident ownership;
- key rotation and revocation tests;
- exact deployed-source and live-route receipts.

Those controls belong to the shared production substrate. They are not reasons to
leave NEXUS as a duplicate product.
