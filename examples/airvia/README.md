# Migrating the Airvia loop onto Spicyspec

> **⚠️ THIS MIGRATION IS DONE — this page is history, not instructions.** The prototype's state was
> migrated and the loop has been running on Spicyspec since; it delivered specs through 008 there.
> **Setting up a fresh machine against airvia lives in THAT repo: `docs/SPICYSPEC-SETUP.md`** —
> a fresh clone seeds a new store (state does not travel with git) rather than migrating anything.
> Kept because `migrate.mjs` and its refusal rules are the template for onboarding the NEXT
> prototype-built tenant.

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
2. Migrate the prototype's state (queue + gate trail) instead of seeding fresh:

```bash
node migrate.mjs C:/XIII/share/Work/airvia
```

   The script refuses while the prototype loop's heartbeat is fresh, refuses over a
   non-empty store, maps `awaiting-founder` to `awaiting-review`, derives each active
   entry's stage FROM ITS ARTIFACTS (tasks.md -> execute, plan.md -> tasks, ...), and
   imports all machine-readable gate records. Prototype LEDGER/ACCOUNTS/PARKED prose
   stays where it is, as history.

3. Go:

```bash
temporal server start-dev --db-filename .spicyspec/temporal.db
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
