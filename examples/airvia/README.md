# Migrating the Airvia loop onto Spicyspec

Airvia is the prototype this platform was extracted from — its 47 recorded machinery
defects are this repo's regression suite. Migrating it back onto Spicyspec is the dogfood
milestone. **Preparation only lives here; nothing in this folder touches the Airvia tree.**

## The one hard precondition

**Stop the prototype loop first.** Spicyspec's runner assumes it is the ONLY writer on the
repo (the same single-writer discipline the prototype enforced with its RUN.lock). Two
orchestrators on one tree is the double-writer incident (prototype B12) at system scale.

```bash
# in the airvia repo: create the stop marker, wait for the tick to finish, verify
# pm2 shows the driver down, then remove the pm2 app entirely.
```

## Steps

1. Copy `spicyspec.runner.json` from here, fix `repoCwd` to the airvia checkout path.
2. Fill `spicyspec.catalog.json` from `docs/mockups/00-feature-catalog.md` — one entry per
   remaining feature, `id` matching the spec directory number (`006`, `008`, …). Entries
   already built and founder-signed stay OUT of the catalog (the queue is remaining work,
   not history).
3. Seed and go:

```bash
temporal server start-dev --db-filename .spicyspec/temporal.db
spicyspec-runner seed --config spicyspec.runner.json --catalog spicyspec.catalog.json
spicyspec-runner start --config spicyspec.runner.json
spicyspec-runner dashboard --config spicyspec.runner.json --port 4477
```

4. Airvia-specific verification commands (verify-specs.sh, check.js, selftest.mjs) ride
   the packet via the pipeline's `extraSections` / harvest `extraVerificationPatterns` —
   see the config comments.

## What the prototype had that the platform does differently

| Prototype | Spicyspec |
|---|---|
| driver.mjs watchdogs, RUN.lock, STOP markers | Temporal durable execution, heartbeats, signals |
| QUEUE.json / LEDGER.jsonl / ACCOUNTS.json flat files | one ACID store (SQLite or Postgres) |
| prose-parsed gate verdicts | machine-readable gate records (absence = UNKNOWN) |
| tracker (single vendor, died to a quota mid-run) | judge chain with fall-through |
| founder journey parked in PARKED.md | awaiting-review + dashboard Approve + phone push |
