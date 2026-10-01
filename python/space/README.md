---
title: IMMUNE lattice
emoji: 🛡️
colorFrom: green
colorTo: yellow
short_description: Channel B Python kernel. Lorenz OP hashes match Channel A.
sdk: docker
app_port: 7860
pinned: false
license: apache-2.0
---

# IMMUNE lattice (Channel B)

Read-only Python compatibility channel for IMMUNE. Same doctrine as Channel A (`SZLHOLDINGS/immune`):
SENTRA admission, YAWAR SHA-256 receipts, HUKLLA tripwires, MESH 3-of-4, NEMO R1-R5,
NEXUS counterfactual dynamics.

- Product tab: https://a-11-oy.com/immune
- Channel A HUD: https://szlholdings-immune.hf.space
- NEXUS UI: `/nexus.html`
- Source: https://github.com/szl-holdings/immune (`python/`)

Do not delete this Space. Status is CONNECTING / REACHABLE / UNAVAILABLE. Never fabricate LIVE or PASS.
Lambda = Conjecture 1 (not a theorem). Energy is UNAVAILABLE unless a meter is actually read.

Read contract: `GET /api/immune/state` and `GET /api/immune/dashboard`.
`GET /healthz` reports process liveness, not action authority. `GET /readyz`
returns 503 while authority or whole-system readiness is unavailable; a proxy
failure or a non-JSON response must also leave governed controls disabled.

Channel B does not possess a privileged action-signing key, seal genesis PASS,
or renew action authority. Mode and reset requests return
`EXTERNAL_ACTION_REQUIRED`; refused cycles may append local HUKLLA denial
evidence, but cannot seal governed YAWAR receipts. Receipt signing is a separate
local compatibility capability and must not be presented as action authority.

The NEXUS engine and cross-language parity vectors remain available. Static UI,
status, catalog, and deterministic replay verification are read-only uses;
`POST /api/immune/nexus/run` requires fresh whole-system write readiness and
returns 503 before computation on Channel B. External v2 actions belong to the
canonical TypeScript runtime, not this process.

## Lorenz OP parity

Same sealed hashes as Channel A:

- inputHash `c5fcc5029392a5e4f7cd65a655d5379cd65d8f915b2ee96a1db5d44e35ea2358`
- outputHash `4071a2f2faca744907747cb2cc82a9d841e125fa287240505f9f9a8454a399ac`
- 320 steps, σ 10 · ρ 27.9 · β 2.67, energy UNAVAILABLE
