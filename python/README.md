# IMMUNE Python kernel

Aligned 1:1 with the live TypeScript runtime in `src/lib/immune`
(this Grok Build COP) and published from [szl-holdings/immune](https://github.com/szl-holdings/immune).

**This is the kernel.** Hugging Face dual-channel:

| Space | Role | Do not delete |
|---|---|---|
| [SZLHOLDINGS/immune](https://huggingface.co/spaces/SZLHOLDINGS/immune) | Channel A — TypeScript HUD + kernel (already LIVE / WRITE-READY) | Keep. Canonical public HUD. |
| [SZLHOLDINGS/immune-lattice](https://huggingface.co/spaces/SZLHOLDINGS/immune-lattice) | Channel B — this Python kernel (stdlib HTTP, port 7860) | Keep URL. Same doctrine, same receipts. |

Do **not** delete either Space. Bookmarks, a11oy estate tiles, and killinchu handoff all point at `immune`. Lattice is the Python channel of **this** kernel, not a second product.

## Why this was not on the Hub yet

The Grok Build COP lives in TypeScript. The Hub Space `SZLHOLDINGS/immune` deploys the Express/Vite bundle from GitHub. `SZLHOLDINGS/immune-lattice` was a thin unsigned stdlib stub and was not booting. This package is the missing Python kernel: live Ed25519 operator, YAWAR hash chain, SENTRA, HUKLLA, MESH, second-brain silhouette, frontier shadow.

## Contract

| Layer | What |
|---|---|
| SENTRA | Fail-closed admission (`no.hack.persons`, token exfil, shell escape) |
| YAWAR | Append-only SHA-256 receipts, Ed25519-signed |
| HUKLLA | T01–T10 tripwires, DEADMAN freeze |
| Operator | `immune:live-operator` — **not** demo-operator |
| Second brain | 575 SOFTWARE handles, MEASURED silhouette |
| MESH | 3-of-4 BFT over immune / a11oy / killinchu / khipu |
| Frontier | Shadow Decision Genome, `executable: false` |

## Run

```bash
pip install -r python/requirements.txt
IMMUNE_DATA_DIR=./data/immune python -m immune.server
# GET  /readyz
# POST /api/immune/cycle  {"actor":"immune:live-operator","intent":"observe inbound"}
```

```bash
python -m unittest discover -s python/tests -v
```

Doctrine v11 · Λ = Conjecture 1 · Apache-2.0 · SZL Holdings
