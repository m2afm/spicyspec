/**
 * LIVE Postgres proof — the one case pg-mem could not emulate, run against a REAL server:
 *
 *   1. rollback-after-error: a failed queue save leaves the previous queue untouched
 *      (this is the case the contract suite skips on pg-mem, with the reason cited)
 *   2. the full store surface (runs, gates, pool, queue, kv, runner directory) round-trips
 *   3. two POOLS (two "runners") share one directory — the federation claim, live
 *
 * Needs a disposable server, e.g.:
 *   docker run -d --name spicyspec-pg-proof -e POSTGRES_PASSWORD=scratch-proof \
 *     -e POSTGRES_DB=spicyspec_proof -p 127.0.0.1:55440:5432 postgres:16-alpine
 *
 * Run from packages/store:  node tools/live-pg-proof.mjs [connection-string]
 */
import { openPgStore, registerRunner, listRunners } from '@spicyspec/store';
import pg from 'pg';

const conn = process.argv[2] ?? 'postgres://postgres:scratch-proof@127.0.0.1:55440/spicyspec_proof';
const log = (m) => console.log(`[pg-proof] ${m}`);

const poolA = new pg.Pool({ connectionString: conn });
const poolB = new pg.Pool({ connectionString: conn });

// fresh slate
await poolA.query('DROP TABLE IF EXISTS runs, gates, pool, queue, kv CASCADE');

const storeA = await openPgStore({ client: poolA, end: () => poolA.end() });
const storeB = await openPgStore({ client: poolB, end: () => poolB.end() });
log(`connected: ${conn.replace(/:[^:@/]+@/, ':***@')}`);

const checks = [];
const check = (name, ok) => {
  checks.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
};

/* ------------------------- 1. THE rollback case, on real Postgres ------------------- */
await storeA.saveQueue({ entries: [{ id: '001', status: 'pending' }] });
let threw = false;
try {
  await storeA.saveQueue({ entries: [{ id: '002', status: 'pending' }, { id: '002', status: 'pending' }] });
} catch {
  threw = true;
}
const afterFail = await storeA.loadQueue();
check('a duplicate-key save throws', threw);
check(
  'ROLLBACK holds on real Postgres: previous queue untouched (the pg-mem-unprovable case)',
  JSON.stringify(afterFail.entries.map((e) => e.id)) === JSON.stringify(['001']),
);

/* ------------------------- 2. full surface round-trip ------------------------------- */
await storeA.appendRun({ tick: 1, exit: 'clean', costUsd: 2.5, tasksClosed: 3 });
await storeA.appendGate({ at: '2026-08-24T00:00:00Z', spec: '001', gate: 'closing', verdict: 'APPROVE', confidence: 0.9, seat: 'qa-critic', frozen: 'abc' });
await storeA.savePoolState({ primary: { coldUntilMs: 99, uses: 7, limitType: 'seven_day' } });
await storeA.setKv('k', 'v');

check('runs round-trip', (await storeA.listRuns())[0]?.costUsd === 2.5);
check('gates round-trip + jsonl export', (await storeA.exportGatesJsonl()).includes('"APPROVE"'));
check('pool state round-trips (C4)', (await storeA.loadPoolState())['primary']?.limitType === 'seven_day');
check('kv round-trips', (await storeA.getKv('k')) === 'v');
check('malformed gate never lands', await storeA.appendGate({ spec: 'x', verdict: 'MAYBE' }).then(() => false, () => true));

/* ------------------------- 3. federation: two pools, one directory ------------------ */
const now = () => new Date().toISOString();
await registerRunner(storeA, { id: 'machine-A', host: 'A', pid: 1, taskQueue: 'spicyspec', startedAt: now(), heartbeatAt: now(), accounts: ['primary'] });
await registerRunner(storeB, { id: 'machine-B', host: 'B', pid: 2, taskQueue: 'spicyspec', startedAt: now(), heartbeatAt: now(), accounts: ['secondary'] });
const seenFromA = await listRunners(storeA, Date.now());
check(
  'two runners on separate connections share ONE directory (the team-install claim, live)',
  seenFromA.length === 2 && seenFromA.every((r) => !r.stale),
);

// B also sees A's queue — one truth
check('runner B reads the queue runner A wrote', (await storeB.loadQueue()).entries[0]?.id === '001');

await storeB.close(); // ends poolB
await storeA.close(); // ends poolA

const pass = checks.filter(([, ok]) => ok).length;
console.log(`\n${pass}/${checks.length} checks against real Postgres`);
process.exitCode = pass === checks.length ? 0 : 1;
