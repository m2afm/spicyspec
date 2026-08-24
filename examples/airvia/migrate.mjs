/**
 * Airvia state migration — prototype flat files into the Spicyspec store.
 *
 * Reads (never writes) the prototype's QUEUE.json and GATES.jsonl, maps them onto the
 * platform's vocabulary, and writes the runner store. Every mapping decision is printed;
 * nothing is silently dropped (the no-silent-caps rule).
 *
 *   status: done→done · parked→parked · awaiting-founder→awaiting-review · pending→pending
 *           active→active with the stage DERIVED FROM ARTIFACTS (evidence, not the
 *           prototype's stage word): tasks.md → execute, plan.md → tasks, spec.md → plan,
 *           nothing yet → specify.
 *
 * PRECONDITION (hard): the prototype loop is STOPPED. Two orchestrators on one tree is
 * prototype B12 at system scale. This script refuses to run while RUN.lock is fresh.
 *
 * Run from examples/airvia:  node migrate.mjs [airvia-repo] [store-path]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseGateRecords } from '@spicyspec/core';
import { openStore } from '@spicyspec/store';

const repo = resolve(process.argv[2] ?? 'C:/XIII/share/Work/airvia');
const storePath = resolve(process.argv[3] ?? join(repo, '.spicyspec', 'runner.db'));
const log = (m) => console.log(`[migrate] ${m}`);

/* ------------------------------------------------------------- the precondition ---- */
const lockPath = join(repo, '.specify', 'loop', 'RUN.lock');
if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const ageMs = Date.now() - Date.parse(lock.heartbeat ?? 0);
  if (ageMs < 5 * 60_000) {
    console.error(
      `[migrate] REFUSING: the prototype loop's heartbeat is ${Math.round(ageMs / 1000)}s old — it is still running.\n` +
        '          Stop it first (create .specify/loop/STOP, wait for the tick to end, pm2 delete airvia-loop).',
    );
    process.exit(1);
  }
  log(`prototype lock present but stale (${Math.round(ageMs / 60000)}m) — proceeding`);
}

/* -------------------------------------------------------------------- the queue ---- */
const prototypeQueue = JSON.parse(readFileSync(join(repo, '.specify', 'loop', 'QUEUE.json'), 'utf8'));

const STATUS_MAP = {
  done: 'done',
  parked: 'parked',
  'awaiting-founder': 'awaiting-review',
  pending: 'pending',
  active: 'active',
};

function stageFromArtifacts(dir) {
  const has = (f) => existsSync(join(repo, dir, f));
  if (has('tasks.md')) return 'execute';
  if (has('plan.md')) return 'tasks';
  if (has('spec.md')) return 'plan';
  return 'specify';
}

const entries = [];
for (const e of prototypeQueue.entries) {
  const status = STATUS_MAP[e.status];
  if (!status) {
    console.error(`[migrate] REFUSING: unknown prototype status "${e.status}" on ${e.id} — no rule, no guess (Q1).`);
    process.exit(1);
  }
  const entry = { id: e.id, status };
  if (status === 'active' || status === 'pending') {
    entry.stage = e.dir ? stageFromArtifacts(e.dir) : undefined;
  }
  entries.push(entry);
  log(
    `${e.id} ${e.slug ?? ''}: ${e.status} -> ${status}` +
      (entry.stage ? ` @ stage ${entry.stage} (from artifacts in ${e.dir})` : ''),
  );
}

/* -------------------------------------------------------------------- the gates ---- */
const gatesText = readFileSync(join(repo, '.specify', 'board', 'GATES.jsonl'), 'utf8');
const { records, problems } = parseGateRecords(gatesText, 'GATES.jsonl');
for (const p of problems) log(`gate line skipped (${p})`);

/* ------------------------------------------------------------------------ write ---- */
const store = openStore(storePath);
const already = await store.loadQueue();
if (already.entries.length) {
  console.error(`[migrate] REFUSING: the store at ${storePath} already has a queue — never migrate over live state.`);
  await store.close();
  process.exit(1);
}

await store.saveQueue({ entries });
let gatesWritten = 0;
for (const r of records) {
  const { line, ...record } = r;
  await store.appendGate(record);
  gatesWritten += 1;
}
await store.setKv(
  'migration:airvia',
  JSON.stringify({ at: new Date().toISOString(), entries: entries.length, gates: gatesWritten, gateProblems: problems.length }),
);

log(`queue: ${entries.length} entries written`);
log(`gates: ${gatesWritten} records imported, ${problems.length} problem lines skipped`);
log(`store: ${storePath}`);
log('NOT migrated (stays in the prototype files as history): LEDGER.jsonl, ACCOUNTS.json cooldowns, PARKED.md prose.');
await store.close();
