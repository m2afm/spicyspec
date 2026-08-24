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

**Phase 3 — complete.** Domain logic ported from the Airvia build-loop prototype
(48h unattended, 191 tasks closed, 47 machinery defects — each encoded as a named regression test).
Four live proofs on real infrastructure: a single-run smoke (8/8), a three-stage rotation through
real Claude sessions (10/10, $0.25), the manager dashboard rendering a live store in a browser,
and the store contract at 9/9 against real Postgres 16 (rollback + two-runner federation).
274 tests across 12 packages.

| Package | What | Status |
|---|---|---|
| `packages/core` | Pure domain logic: queue invariants, classification, attribution, gates, account pool, evidence harvest, ledger | done |
| `packages/provider` | Vendor contract: normalized `WorkerEvent` stream | done |
| `packages/provider-claude` | Claude adapter on the Agent SDK — guardrails enforced via `canUseTool` | done |
| `packages/orchestrator` | Temporal `specRunWorkflow` + heartbeating activities | done |
| `packages/pipeline` | Declarative stage definitions + generalized packet builder | done |
| `packages/store` | `node:sqlite` state: runs, gates (+JSONL export), pool, queue | done |
| `packages/runner` | Composition root: config, snapshots, pool settle, judge wiring, CLI (init/start/seed/handoff/dashboard/service-xml) | done |
| `packages/judge` | Second-vendor honesty chain: zod verdicts, quota fall-through, absence=UNKNOWN | done |
| `packages/packs` | Gate packs: frontend/a11y/backend/security — 62 evidence-bearing checklist items | done |
| `packages/control-plane` | Managers page: read API + CSRF-guarded review + self-contained live dashboard | done |
| `packages/create-spicyspec` | `npx create-spicyspec my-project` — five commands to a running loop | done |
| `packages/notify` | ntfy.sh + webhook push — a run waiting on a human is never silent | done |
| `packages/store` (pg) | Postgres driver behind the same contract; `postgres://` storePath = team mode | done |
| runner federation | register/heartbeat/staleness in the shared store; `/api/runners` + dashboard | done |
| Angular UI upgrade, npm publish (license undecided), airvia dogfood migration | parked — founder calls | next |

## Workspace

```bash
pnpm install
pnpm nx test core        # unit tests (vitest)
pnpm nx typecheck core
```

## License

Undecided — treat as proprietary until a license file exists.
