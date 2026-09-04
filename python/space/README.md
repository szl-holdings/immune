---
title: IMMUNE lattice — Python kernel
emoji: ⬡
colorFrom: green
colorTo: yellow
short_description: IMMUNE Channel B — SENTRA, YAWAR, HUKLLA, NEXUS
sdk: docker
app_port: 7860
pinned: false
license: apache-2.0
---

# IMMUNE lattice (Channel B)

Python kernel for IMMUNE. Same doctrine as Channel A (`SZLHOLDINGS/immune`):
SENTRA admission, YAWAR SHA-256 receipts, HUKLLA tripwires, MESH 3-of-4, NEMO R1–R5,
NEXUS counterfactual dynamics.

- Product tab: https://a-11-oy.com/immune
- Channel A HUD: https://szlholdings-immune.hf.space
- Source: https://github.com/szl-holdings/immune (`python/`)

Do not delete this Space. Status is CONNECTING / REACHABLE / UNAVAILABLE — never a fabricated LIVE or PASS.
Λ = Conjecture 1 (not a theorem). Energy is UNAVAILABLE unless a meter is actually read.

Contract: `GET /api/immune/state` and `GET /api/immune/dashboard`.
The Hub proxy intercepts `/readyz` on some runtimes; a 502 HTML there is not kernel death.
