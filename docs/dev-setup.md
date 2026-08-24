# Dev setup

## Prerequisites

- Node ≥ 24, pnpm ≥ 10 (`corepack enable`)
- `pnpm install` at the repo root

## Tests

```bash
pnpm nx run-many -t typecheck test
```

The orchestrator suite starts a real **time-skipping Temporal test server** — the binary is
downloaded automatically on first run and cached. No Docker, no manual install.

## Temporal dev server (for running the platform, not the tests)

One binary, no Docker. Install once:

```bash
# Windows (winget)  — or grab the release from github.com/temporalio/cli
winget install Temporal.CLI
```

Run it with persistence (WITHOUT `--db-filename` state is in-memory and a restart wipes it):

```bash
temporal server start-dev --db-filename .spicyspec/temporal.db --ui-port 8233
```

- Server: `localhost:7233` (workers/clients connect here)
- Web UI: `http://localhost:8233` — run timeline, retries, pending signals

### Later: VPS / Temporal Cloud

Workflow code changes zero; workers repoint the connection address. In-flight runs do NOT
migrate between servers — cut over between runs (RFC-001 §4.1).

## Package map

| Package | Role |
|---|---|
| `@spicyspec/core` | Pure domain logic + defect-named regression suite |
| `@spicyspec/provider` | Vendor contract: normalized `WorkerEvent` stream |
| `@spicyspec/provider-claude` | Claude adapter on the Agent SDK (guardrails enforced via `canUseTool`) |
| `@spicyspec/orchestrator` | Temporal workflow (`specRunWorkflow`) + activities |

## Team mode (Postgres)

Point every runner's `storePath` at one Postgres URL and the machines share a single
queue, ledger, gate trail, and runner directory:

```jsonc
// spicyspec.runner.json
{ "storePath": "postgres://user:pass@your-host:5432/spicyspec" }
```

Anything that is not a `postgres://` URL stays a local SQLite file (solo mode). Same
repository interface, one contract suite over both drivers, and the live proof:

```bash
docker run -d --name spicyspec-pg-proof -e POSTGRES_PASSWORD=scratch-proof   -e POSTGRES_DB=spicyspec_proof -p 127.0.0.1:55440:5432 postgres:16-alpine
cd packages/store && node tools/live-pg-proof.mjs   # 9/9: rollback, round-trips, federation
docker rm -f spicyspec-pg-proof
```

## Boot survival: which of the two, and why

There are two mechanisms and they answer different questions. Install the first; the second
is optional.

| | `install-autostart` (scheduled task / timer / agent) | `service-xml` (WinSW) |
|---|---|---|
| What it starts | `supervise --once` — a sweep that repairs **everything**: Temporal, the worker, the dashboard, a cancelled rotation, a stop flag no human set | the worker process, and only the worker |
| When | boot-or-logon **and** every N minutes, forever | boot, plus restart-on-crash |
| Elevation | none by default | admin (installing a Windows service) |
| Recovers from | anything that leaves the loop not-running, including states no process crash caused | the worker process exiting |

`install-autostart` is the one that answers "I left it overnight and it was dead" — the
overnight death had a *cancelled workflow* and a *stale stop flag*, neither of which is a
crashed process, so nothing a service manager does would have helped. Use WinSW on top only
if you want the worker itself hosted as a real Windows service; the sweep detects it running
and leaves it alone.

```bash
# the one to install (idempotent — re-run it to change the interval)
spicyspec-runner install-autostart --config spicyspec.runner.json --interval-minutes 3

# see it registered
schtasks /Query /TN Spicyspec-<projectName> /V /FO LIST      # Windows
systemctl --user status spicyspec-<project>.timer            # Linux
launchctl print gui/$(id -u)/com.spicyspec.<project>         # macOS

# remove it
spicyspec-runner install-autostart --config spicyspec.runner.json --uninstall
```

On Windows the default task runs **as you, at logon** — not elevated, and keeping your user
profile, which is where the ambient AI-account logins live. `--whether-logged-on` registers
it as SYSTEM instead: it then fires with nobody logged in, but SYSTEM has no user profile, so
the workers it starts may fail to authenticate. Read what the command prints before choosing
it.

Optional, Windows only — host the worker itself as a service:

```bash
spicyspec-runner service-xml --config ... > spicyspec-runner.xml
# put it beside a downloaded WinSW exe renamed spicyspec-runner-service.exe, then
spicyspec-runner-service.exe install && spicyspec-runner-service.exe start
```

Logs from the sweep land in `<repo>/.spicyspec/logs/supervisor.log`.
