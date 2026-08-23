# Spicyspec

**An agentic delivery platform.** Idea / documentation / competition brief in → spec kit →
gated autonomous execution → **handoff package** out: a working app in dev mode with the specs,
gate records, and test evidence a production team needs to adapt and launch it.

> GitHub Actions for building whole apps — a spec-driven pipeline as the brain,
> evidence-paired verification as the moat.

## Shape

- **Control plane** — projects, pipelines, run queue, gate records, approvals, dashboards.
- **Runners** — a daemon on each team member's machine; brings its own AI provider accounts
  (Claude subscriptions are personal), polls for jobs, streams evidence back. Dial-out only.
- **Plugin surfaces** — providers (Claude/Kimi/GLM/…), agent manifests, skill & gate packs
  (frontend-checklist, backend-checklist, security-check, pentest), pipeline definitions.

Full architecture: [docs/RFC-001-founding.md](docs/RFC-001-founding.md).

## Stack

TypeScript strict · Nx monorepo · @anthropic-ai/claude-agent-sdk · Temporal (durable execution;
local dev server now, VPS/Cloud later) · Postgres+Prisma (team) / SQLite (solo) · Angular control
plane · WinSW/systemd runner services · vitest · zod.

## Status

**Phase 0 — extract.** Porting the battle-tested domain logic from the Airvia build-loop
prototype (48h unattended, 191 tasks closed, 47 machinery defects recorded and each one encoded
here as a named regression test) into typed, tested `packages/core`.

| Package | What | Status |
|---|---|---|
| `packages/core` | Pure domain logic: queue invariants, tick classification, attribution guard, gate records | porting |

## Workspace

```bash
pnpm install
pnpm nx test core        # unit tests (vitest)
pnpm nx typecheck core
```

## License

Undecided — treat as proprietary until a license file exists.
