# Domain Leader Study — immune (fail-closed kernel, Lorenz/NEXUS measured sim)

OUROBOROS phase-3, cohort-02 tranche-2, Kimi ruling W26-C2T2-KIMI-20261123-ASK (GO, 7 bindings). PROPOSE-ONLY, DRAFT. Documentation only, no implementation in this PR.

## Current state (repo inspection 2026-11-23)
TypeScript repo; description: IMMUNE fail-closed kernel; SENTRA admits, YAWAR seals hashes; NEXUS Lorenz OP is MEASURED software simulation. Topics: ai-safety, doctrine-v11, governed-ai, lorenz, nexus. Pre-write collision probe: no existing study card, no study/impl/lap branches (receipt vibe_w26t2_collision_probe.txt).

## Domain leaders studied
| Leader | What they have | Key sources |
| --- | --- | --- |
| E. N. Lorenz (1963) | The original deterministic-chaos paper: the Lorenz system's exact equations and the founding result that deterministic systems can be nonperiodic — the canonical citation for any honest MEASURED Lorenz simulation | Lorenz, J. Atmos. Sci. 20(2):130-141, doi:10.1175/1520-0469(1963)020<0130:DNF>2.0.CO;2 (accessed 2026-11-23) |
| fast-check (dubzzz) | The reference property-based testing framework for the TS/JS ecosystem: randomly generated cases + shrinking to minimal reproductions — the leader answer for proving a fail-closed kernel actually closes under adversarial inputs | github.com/dubzzz/fast-check (accessed 2026-11-23) |

## What the leaders do better
- Lorenz 1963 defines the system precisely enough that any reimplementation is checkable against the published equations; a measured sim that does not cite parameter values and integration step cannot be compared to the canon.
- fast-check turns fail-closed claims into tests: instead of asserting the kernel rejects known-bad inputs, it generates families of them and shrinks failures to readable counterexamples.

## Gaps
- Description-measured simulation exists, but no documented citation of Lorenz 1963 parameter values or integration policy was found in card scope; without those, MEASURED cannot be externally compared.
- No documented property-based suite (fast-check class) for SENTRA admit/YAWAR seal decision surfaces.

## Ranked #1 absorb proposal (NOT implemented in this PR)
Bind the NEXUS Lorenz sim to the 1963 canon: document sigma/rho/beta parameter values + integration step + iteration policy in-repo (citing the DOI), and add a fast-check property suite that shrinks fail-closed violations to minimal counterexamples. Expected benefit: MEASURED becomes independently comparable; kernel-closing behavior becomes generated-tested, not hand-picked. Cost/risk: low; docs + test-only, additive. Validation: property suite green on fixed seed, one Lorenz trajectory cross-checked against published values. Rollback: suite removal only.

## Sources
- Lorenz 1963: https://journals.ametsoc.org/view/journals/atsc/20/2/1520-0469_1963_020_0130_dnf_2_0_co_2.xml (accessed 2026-11-23)
- fast-check: https://github.com/dubzzz/fast-check (accessed 2026-11-23)
