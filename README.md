# Spicyspec

**An agentic delivery platform.** Idea / documentation / competition brief in → spec kit →
gated autonomous execution → **handoff package** out: a working app in dev mode with the specs,
gate records, and test evidence a production team needs to adapt and launch it.

> GitHub Actions for building whole apps — a spec-driven pipeline as the brain,
> evidence-paired verification as the moat.

## New here? Read in this order

1. **This file** — what the thing is and how to run it.
2. **[HANDOFF.md](HANDOFF.md)** — where the work stands *right now*, what is unfinished, and the
   traps the last session paid for. The baton, not the record.
3. **[docs/RFC-001-founding.md](docs/RFC-001-founding.md)** — the architecture and the decisions
   behind it.
4. **[docs/dev-setup.md](docs/dev-setup.md)** — Temporal, the worker, and boot survival.
5. **[docs/accounts.md](docs/accounts.md)** — adding accounts: the multi-account rotation setup.
6. **[examples/airvia/](examples/airvia/)** — a real tenant config, annotated. The first tenant is
   the Airvia marketplace repo; its live rules live in *that* repo's `CLAUDE.md`.

## Shape

- **Control plane** — projects, pipelines, run queue, gate records, approvals, dashboards.
- **Runners** — a daemon on each team member's machine; brings its own AI provider accounts
  (Claude subscriptions are personal), polls for jobs, streams evidence back. Dial-out only.
- **Plugin surfaces** — providers (Claude/Kimi/GLM/…), agent manifests, skill & gate packs
  (frontend-checklist, backend-checklist, security-check, pentest), pipeline definitions.

## Quickstart

```bash
pnpm install
pnpm nx run-many -t typecheck test build   # the full sweep — green at handover (36/36 tasks)
```

Run a loop against a repo of your own:

```bash
npx create-spicyspec my-project    # scaffolds config + store in five commands
spicyspec-runner start --config spicyspec.runner.json
spicyspec-runner dashboard --port 4477 --config spicyspec.runner.json
```

The dashboard is one vendored HTML file (`packages/control-plane/room/app.html`) — no build step,
works offline, React via `h()` calls. Rebuild the runner (`pnpm nx build runner`) before restarting
a deployed dashboard: it serves whatever `dist/` holds.

## How work flows

One spec at a time, through a gated pipeline: **intake → specify → clarify → plan → tasks →
execute → converge**, then a terminal gate and a human sign-off — the platform never marks its own
work done. Temporal makes every run durable; the store (SQLite solo, Postgres team) is the single
writer's ledger; accounts rotate *within* a spec, weekly-quota accounts held in reserve.

## Stack

TypeScript strict · Nx monorepo · @anthropic-ai/claude-agent-sdk · Temporal (durable execution;
local dev server now, VPS/Cloud later) · Postgres+Prisma (team) / SQLite (solo) · Angular control
plane · WinSW/systemd runner services · vitest · zod.

## Status

**Dogfooding on the Airvia tenant.** The loop delivered specs 001–008 there; 008 is signed off at
its terminal gate and awaits the founder's own click-through. This platform was extracted from that
prototype (48h unattended, 191 tasks closed, 47 machinery defects — each encoded as a named
regression test) and then hardened against everything the dogfood run surfaced: self-healing
supervision, branch-per-spec, pid-carrying account leases, honest task counting.

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

## Team practices — the rules the measurements forced

The full set (with the numbers) lives in the tenant repo's `CLAUDE.md` and in
`packages/pipeline/src/lib/packet.ts`, which is how they reach every worker. The short form:

- **Executed beats reasoned.** One browser click-through per feature, run uncached at the terminal
  gate. No static substitute counts. Both defects that ever escaped to a human were this class.
- **Verify the OUTCOME, never the exit code.** The costliest failures here were things reporting
  success while doing nothing — a supervisor whose timers let it exit healthy, a psql helper that
  swallowed every SQL error, coverage bars that resolved no files and passed.
- **Review in batches of 5–6 units; every finding names a falsifiable probe** — a mutation that
  stayed green, a red-first test, or a command with its output. "Checked, fine" is not a finding.
- **Never review the process's own records.** Task lists and handoffs are corrected in place.
- **Fix per finding; commit bodies carry the probe.** Read any `fix(...)` commit in this repo or the
  tenant's for the idiom.

## License

Undecided — **treat as proprietary**. The source being visible does not grant use, copying, or
redistribution; no license file exists yet, so default copyright applies. Founder call pending.
