# @spicyspec/core

Pure domain logic for the Spicyspec orchestrator — no I/O, no framework, storage-agnostic.
Every module here was ported from the Airvia build-loop prototype and carries its defect
history as named regression tests (RFC-001 §1.1).

| Module | What it owns | Key prototype defects encoded |
|---|---|---|
| `queue-guard` | Queue invariants Q1–Q8 (repair/halt/warn severity discipline) + commit attribution guard | B36, B45, tick-34 mismatch |
| `gates` | Machine-readable gate records: parse, closing-gate state (absence = UNKNOWN, never PASS), serialize | prose-parse failure study |
| `classify` | Deterministic run classification (13 exit classes) + loop-of-doom detector | B8, B10, B15, B19, B29, tick-27 |

```bash
pnpm nx test @spicyspec/core
pnpm nx typecheck @spicyspec/core
```
