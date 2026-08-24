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
| `packages/runner` | Composition root: config, snapshots, pool settle, judge wiring, CLI (init/start/seed/handoff/dashboard/service-xml/install-autostart) | done |
| `packages/judge` | Second-vendor honesty chain: zod verdicts, quota fall-through, absence=UNKNOWN | done |
| `packages/packs` | Gate packs: frontend/a11y/backend/security — 62 evidence-bearing checklist items | done |
| `packages/control-plane` | Managers page: read API + CSRF-guarded review + self-contained live dashboard | done |
| `packages/create-spicyspec` | `npx create-spicyspec my-project` — five commands to a running loop | done |
| `packages/notify` | ntfy.sh + webhook push — a run waiting on a human is never silent | done |
| `packages/store` (pg) | Postgres driver behind the same contract; `postgres://` storePath = team mode | done |
| runner federation | register/heartbeat/staleness in the shared store; `/api/runners` + dashboard | done |
| Angular UI upgrade, npm publish (license undecided), airvia dogfood migration | parked — founder calls | next |

## Leave it running overnight

The loop is meant to be left alone. One command registers the operating system to keep it
alive — a Windows Scheduled Task, a systemd **user** timer, or a launchd agent, whichever
this machine has:

```bash
spicyspec-runner install-autostart --config spicyspec.runner.json   # --interval-minutes 3
```

From then on the OS runs one supervision sweep at boot-or-logon **and** every 3 minutes,
forever. Each sweep restarts whatever is missing — the Temporal dev server, the runner
worker, the dashboard — and repairs the states no crash caused: a rotation that was
cancelled, a stop flag no human set. Worst-case outage is one interval.

- **Logs:** `.spicyspec/logs/supervisor.log` — the sweep's own transcript.
- **Did it heal?** the control room's health panel, and the `health:events` rows in the store.
- **Undo:** the same command with `--uninstall`.
- **It is not elevated** and does not need to be. Details, and when to add WinSW on top:
  [docs/dev-setup.md](docs/dev-setup.md#boot-survival-which-of-the-two-and-why).

Written after a real night: the founder left the loop running, and found it dead for ~8
hours. Two causes — a stop flag the agent armed and never cleared, and *nothing supervising
the processes*. Both are what a sweep now looks for.

## Workspace

```bash
pnpm install
pnpm nx test core        # unit tests (vitest)
pnpm nx typecheck core
```

## License

Undecided — treat as proprietary until a license file exists.
