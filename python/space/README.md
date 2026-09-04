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

Python kernel for IMMUNE. Same doctrine as Channel A (`SZLHOLDINGS/immune`):
SENTRA admission, YAWAR SHA-256 receipts, HUKLLA tripwires, MESH 3-of-4, NEMO R1-R5,
NEXUS counterfactual dynamics.

- Product tab: https://a-11-oy.com/immune
- Channel A HUD: https://szlholdings-immune.hf.space
- NEXUS UI: `/nexus.html`
- Source: https://github.com/szl-holdings/immune (`python/`)

Do not delete this Space. Status is CONNECTING / REACHABLE / UNAVAILABLE. Never fabricate LIVE or PASS.
Lambda = Conjecture 1 (not a theorem). Energy is UNAVAILABLE unless a meter is actually read.

Contract: `GET /api/immune/state` and `GET /api/immune/dashboard`.
The Hub proxy intercepts `/readyz` on some runtimes; a 502 HTML there is not kernel death.

## Lorenz OP parity

Same sealed hashes as Channel A:

- inputHash `c5fcc5029392a5e4f7cd65a655d5379cd65d8f915b2ee96a1db5d44e35ea2358`
- outputHash `4071a2f2faca744907747cb2cc82a9d841e125fa287240505f9f9a8454a399ac`
- 320 steps, σ 10 · ρ 27.9 · β 2.67, energy UNAVAILABLE
