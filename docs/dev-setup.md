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
