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

# IMMUNE — Channel A kernel

Public TypeScript kernel for IMMUNE. Not an investor-demo stub. SENTRA admits,
YAWAR seals SHA-256 receipts, HUKLLA tripwires, NEXUS counterfactual dynamics.

- Product tab: https://a-11-oy.com/immune
- Channel B sibling: https://szlholdings-immune-lattice.hf.space
- Source: https://github.com/szl-holdings/immune
- NEXUS UI: `/nexus.html`

One product, two URLs. Do not delete this Space or Channel B.

Status is CONNECTING / REACHABLE / UNAVAILABLE. Never fabricate LIVE or PASS.
Λ = Conjecture 1 OPEN. Energy is UNAVAILABLE unless a meter is actually read.

## Lorenz OP (measured)

`POST /api/immune/nexus/run` with `{program:"lorenz",mode:"OP",steps:320}`
returns HTTP 201, `governed.pass=true`, hash-only YAWAR payload.

| Field | Value |
|---|---|
| coefficients | σ 10 · ρ 27.9 · β 2.67 |
| final | −7.707920173353, −10.567955419679, 21.305498529338 |
| inputHash | `c5fcc5029392a5e4f7cd65a655d5379cd65d8f915b2ee96a1db5d44e35ea2358` |
| outputHash | `4071a2f2faca744907747cb2cc82a9d841e125fa287240505f9f9a8454a399ac` |
| truth | MEASURED_SOFTWARE_SIMULATION |

Channel B produces the same hashes.

## License

Apache License 2.0. Third-party data retains upstream terms.

## What's in the image

- `immune-server.js` — Express kernel + SPA host
- `public/` — vite-built HUD including `nexus.html`
- `data/immune/` — append-only receipt + evidence chain

Listens on `PORT` (default 7860). Contract: `GET /readyz`, `GET /api/immune/state`,
`GET /api/immune/nexus/status`, `POST /api/immune/nexus/run`.
