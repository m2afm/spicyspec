/**
 * Prototype-view exporter — the Loop Control Room compatibility layer.
 *
 * The Airvia control room (ui/app.html + ui/server.mjs) is founder tooling worth keeping
 * exactly as it is: catalog bars, owed-by-you checklists with gated sign-off, run totals.
 * It reads the PROTOTYPE's file formats (QUEUE.json, LEDGER.jsonl, ACCOUNTS.json,
 * RUN.lock). Rather than porting 3,000+ lines of UI, the runner WRITES those files as a
 * read-only view of the store — the store stays the single source of truth, the files are
 * projections, and the original control room keeps working over the new engine.
 *
 * Enabled by `compatLoopDir` in the runner config; absent = no files written.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Queue } from '@spicyspec/core';
import type { Store } from '@spicyspec/store';

export interface CompatViewOptions {
  repoCwd: string;
  /** e.g. `.specify/loop` — where the control room reads its files */
  loopDir: string;
}

const STATUS_TO_PROTOTYPE: Record<string, string> = {
  'awaiting-review': 'awaiting-founder',
  done: 'done',
  parked: 'parked',
  pending: 'pending',
  active: 'active',
};

/** Preserved once from the original file so slugs/dirs/notes survive the round trip. */
function readOriginalMeta(dir: string): Map<string, Record<string, unknown>> {
  const meta = new Map<string, Record<string, unknown>>();
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'QUEUE.json'), 'utf8')) as {
      entries?: Array<Record<string, unknown>>;
    };
    for (const e of raw.entries ?? []) meta.set(String(e['id']), e);
  } catch {
    /* first export on a fresh dir */
  }
  return meta;
}

/** Project the store queue into the prototype's QUEUE.json shape. */
export async function exportQueueView(store: Store, options: CompatViewOptions): Promise<void> {
  const dir = join(options.repoCwd, options.loopDir);
  mkdirSync(dir, { recursive: true });
  const original = readOriginalMeta(dir);
  const queue: Queue = await store.loadQueue();

  const entries = queue.entries.map((e) => {
    const prior = original.get(e.id) ?? {};
    return {
      ...prior,
      id: e.id,
      status: STATUS_TO_PROTOTYPE[String(e.status)] ?? String(e.status),
      stage: e.stage ?? prior['stage'] ?? null,
      derivation: 'projected from the spicyspec store (read-only view — the store is the truth)',
    };
  });

  writeFileSync(
    join(dir, 'QUEUE.json'),
    JSON.stringify({ seededAt: new Date().toISOString(), projectedBy: 'spicyspec', entries }, null, 1),
    'utf8',
  );
}

export interface CompatRunRow {
  exit: string;
  costUsd: number;
  tasksClosed: number;
  account: string;
  specId: string;
  stage: string;
  durationMinutes: number;
  head?: string;
  /** epoch SECONDS, as the provider reports it — the original room's window chip reads
   * `last.rateResetsAt * 1000` off this row (ui/server.mjs:619). */
  rateResetsAt?: number | null;
  note?: string;
}

/** Append one prototype-shape ledger row (the control room's history + totals source). */
export async function appendLedgerView(store: Store, options: CompatViewOptions, row: CompatRunRow): Promise<void> {
  const dir = join(options.repoCwd, options.loopDir);
  mkdirSync(dir, { recursive: true });
  // The control room counts DISTINCT tick numbers; continue the prototype's numbering.
  const key = 'compat:tick';
  const tick = Number((await store.getKv(key)) ?? (await countPrototypeTicks(dir))) + 1;
  await store.setKv(key, String(tick));
  const entry = {
    tick,
    startedAt: new Date(Date.now() - row.durationMinutes * 60_000).toISOString(),
    durationMinutes: row.durationMinutes,
    exit: row.exit,
    account: row.account,
    costUsd: row.costUsd,
    tasksClosed: row.tasksClosed,
    spec: row.specId,
    stage: row.stage,
    head: row.head ?? null,
    rateResetsAt: row.rateResetsAt ?? null,
    note: row.note ?? 'spicyspec run',
    commits: true,
  };
  appendFileSync(join(dir, 'LEDGER.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
}

async function countPrototypeTicks(dir: string): Promise<number> {
  try {
    const text = readFileSync(join(dir, 'LEDGER.jsonl'), 'utf8');
    let max = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const t = (JSON.parse(line) as { tick?: number }).tick ?? 0;
        if (t > max) max = t;
      } catch {
        /* skip */
      }
    }
    return max;
  } catch {
    return 0;
  }
}

/** Mirror the account pool into ACCOUNTS.json (the control room's accounts panel). */
export async function exportAccountsView(store: Store, options: CompatViewOptions): Promise<void> {
  const dir = join(options.repoCwd, options.loopDir);
  mkdirSync(dir, { recursive: true });
  const state = await store.loadPoolState();
  const accounts = Object.fromEntries(
    Object.entries(state).map(([id, s]) => [
      id,
      {
        coldUntilMs: s.coldUntilMs ?? 0,
        ticks: s.uses ?? 0,
        refusedReason: s.refusedReason ?? null,
        refusedAt: s.refusedAt ?? null,
        limitType: s.limitType ?? null,
        limitTypeSeenAt: s.limitTypeSeenAt ?? null,
      },
    ]),
  );
  writeFileSync(join(dir, 'ACCOUNTS.json'), JSON.stringify({ savedAt: new Date().toISOString(), accounts }, null, 1), 'utf8');
}

/**
 * Keep a RUN.lock heartbeat while the runner lives — the control room's RUNNING chip and
 * its start-guard read `pidAlive(lock.pid)` + heartbeat freshness.
 */
export function writeLockView(options: CompatViewOptions, startedAt: string): void {
  const dir = join(options.repoCwd, options.loopDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'RUN.lock'),
    JSON.stringify(
      { pid: process.pid, workerPid: process.pid, startedAt, heartbeat: new Date().toISOString(), codeHead: 'spicyspec', configHash: 'spicyspec' },
      null,
      1,
    ),
    'utf8',
  );
}

export function clearLockView(options: CompatViewOptions): void {
  try {
    const path = join(options.repoCwd, options.loopDir, 'RUN.lock');
    if (existsSync(path)) {
      const lock = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number };
      // Only clear our own lock — never another process's.
      if (lock.pid === process.pid) rmSync(path, { force: true });
    }
  } catch {
    /* best effort */
  }
}
