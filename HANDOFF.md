# HANDOFF — spicyspec (session end 2026-08-26, work paused by the founder)

For a dev who has never seen this codebase. Read `README.md` + `docs/RFC-001-founding.md` for what
this IS; this file is only where the work STANDS.

## What this is, in one paragraph
A productised autonomous build-loop: Temporal workflows drive Claude Agent SDK workers over a
spec-driven pipeline (intake → specify → clarify → plan → tasks → execute → converge), with a
single-file control room (`packages/control-plane/room/app.html`, no build step) and a SQLite/Postgres
store. First tenant is the airvia repo at `C:/XIII/share/Work/airvia` — its `spicyspec.runner.json`
is the live config, single-spec mode, 3 rotating accounts.

## Position
- Branch `main`, clean tree at `77561e7`. Full sweep green at handover:
  `pnpm nx run-many -t typecheck test build` → 36/36 tasks, ~200 tests across 12 projects.
- The loop is IDLE by design: airvia's 008 signed off (`awaiting-review`), 009 deliberately not
  opened — it waits on the founder clearing `PARKED.md` in the airvia repo.
- A dashboard instance may still be running on the airvia machine (port 4477, started from
  `packages/runner/dist/bin.js dashboard`). Rebuild + restart it after pulling: the deployed dist is
  whatever was last built.

## What landed most recently (read the commit messages — each carries its measurement)
- `77561e7` room: a task is a CHECKBOX row — prose no longer inflates a finished spec's bar
- `ecb0438` room: DEFERRED-TO-<spec> rows excluded from the bar, still counted beside it
- `5cdf659` runner: a DEFERRED row no longer holds its spec open (killed 008's infinity loop, R15)
- Before that: branch-per-spec (`spec-branch.ts`), supervisor self-healing (6 checks, cross-host
  lock), pid-carrying account leases, the Agents tab, the R7/economics packet blocks in
  `packages/pipeline/src/lib/packet.ts`.

## Where the next dev starts
1. `docs/dev-setup.md` — get Temporal + the worker running.
2. The airvia tenant's rules live in that repo's `CLAUDE.md` ("Workflow economics", 15 rules) and
   `~/.claude/rules/agentic-loop-economics.md` (the portable 12). The packet blocks in
   `packet.ts` are how those rules reach every tenant — change them THERE, not in prose.
3. Known non-blocking debts: grep classifier prints a pipe as its search location; Paper theme
   contrast on `.id` (1.00:1); two panes claim a module "is not available" while it works; a
   drain-then-rotate trigger + shorter activity heartbeat are QUEUED (currently a killed worker is
   reclaimed after the 20-min heartbeat timeout, not ~2 min).
4. The one rule that must survive any refactor: **verify the OUTCOME, never the exit code** — this
   repo's register (`BUGS-ON-THE-GO` in the airvia tenant, B1–B48) is a museum of things that
   reported success while doing nothing.

## Traps
- `node:sqlite` is experimental — every store read in scripts needs `--experimental-sqlite`.
- The room is ONE vendored html file, React via `h()` calls, no JSX, offline. Facts are objects —
  unwrap with `num()`; `sparkPath` takes an options object.
- Windows: `schtasks` runs from System32 (launchers must `cd /d`), pattern-kill by command line
  does not work through POSIX shells (use CIM), and cmd `>>` redirects fail while a log is held.
- Temporal: killing a worker mid-activity costs the 20-min heartbeat timeout before rotation.
