# IMMUNE Python compatibility kernel

This package provides a local Python compatibility channel for the
`szl-holdings/immune` source tree. The canonical public HUD and externally
authorized action runtime is `SZLHOLDINGS/immune`.

The Python process intentionally contains no action-authority private key. It
does not self-sign `PASS`, refresh privileged state, or accept local mode/reset
commands. Those controls fail closed with `EXTERNAL_ACTION_REQUIRED`.
`immune.action.v2` authority is admitted only by the canonical TypeScript
runtime after exact audience, source, public-key, admission-window, and signed
lease validation.

## Included compatibility capabilities

Privileged authority controls are read-only. Evaluation is not storage-free:
a refused cycle may append and persist local HUKLLA evidence so its denial is
auditable, while mode and reset operations remain unavailable.

| Layer | Behavior |
|---|---|
| SENTRA | Fail-closed intent inspection |
| YAWAR | Local append-only SHA-256 receipt verification |
| HUKLLA | T01-T10 tripwire evaluation |
| Second brain | Software-only handle search and measured silhouette |
| MESH | Modeled quorum projection |
| Frontier | Shadow Decision Genome with `executable: false` |
| NEXUS | Preserved bounded simulation engine, catalog, and read-only replay verification |

`GET /healthz` is process liveness. `GET /readyz` remains 503 when whole-system
write readiness is unavailable. NEXUS `POST /api/immune/nexus/run` checks that
readiness before performing computation; the Channel B UI disables governed
execution and displays its read-only authority boundary. Static assets, catalog,
status, and `POST /api/immune/nexus/verify` do not require privileged authority.

## Run

```bash
pip install -r python/requirements.txt
export PYTHONPATH=python
IMMUNE_DATA_DIR=./data/immune python -m immune.server
```

```bash
python -m unittest discover -s python/tests -v
```

The compatibility kernel is not the Hugging Face publisher and must not receive
`IMMUNE_ACTION_SIGNING_PKCS8_B64`. Receipt signing is separate from privileged
action authority. Optional YAWAR receipt signatures use only the existing
`IMMUNE_SIGNING_KEY` (base64 Ed25519 seed or PKCS8 DER); an absent or invalid
receipt secret leaves receipts explicitly unsigned. The process never generates,
copies, or stores a private key and never reads legacy operator-key files.
Historical receipt data remains readable, but legacy privileged state is never
restored. Replay verification compares output only, not live authority or provenance.

Doctrine v11 - Lambda = Conjecture 1 - Apache-2.0 - SZL Holdings
