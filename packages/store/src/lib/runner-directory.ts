/**
 * Runner registration — the federation slice (RFC-001 §2: runners on team machines).
 *
 * Each runner writes a heartbeat record into the SHARED store (Postgres for a team, the
 * local SQLite file for solo); the dashboard lists who is connected and flags the stale.
 * The lesson behind the staleness rule is prototype B17: liveness was once judged by bare
 * pid existence and a dead-but-present entry passed for alive — here liveness is a fresh
 * heartbeat TIMESTAMP, never the record's existence.
 */
import type { Store } from './sqlite-store.js';

export interface RunnerRecord {
  id: string;
  host: string;
  pid: number;
  taskQueue: string;
  startedAt: string;
  heartbeatAt: string;
  accounts: string[];
}

export const RUNNER_KEY = (id: string) => `runner:${id}`;
export const HEARTBEAT_MS = 30_000;
/** stale = more than three missed beats — presence is a fresh timestamp, not a record (B17) */
export const STALE_AFTER_MS = HEARTBEAT_MS * 3;

export async function registerRunner(store: Store, record: RunnerRecord): Promise<void> {
  await store.setKv(RUNNER_KEY(record.id), JSON.stringify(record));
}

export async function heartbeatRunner(store: Store, id: string, at: string): Promise<void> {
  const raw = await store.getKv(RUNNER_KEY(id));
  if (!raw) return;
  const record = JSON.parse(raw) as RunnerRecord;
  record.heartbeatAt = at;
  await store.setKv(RUNNER_KEY(id), JSON.stringify(record));
}

export interface RunnerView extends RunnerRecord {
  stale: boolean;
}

export async function listRunners(store: Store, nowMs: number): Promise<RunnerView[]> {
  const rows = await store.listKv('runner:');
  return rows.map((r) => {
    const record = JSON.parse(r.value) as RunnerRecord;
    return { ...record, stale: nowMs - Date.parse(record.heartbeatAt) > STALE_AFTER_MS };
  });
}

/** Start the heartbeat loop; returns a stop function. Failures are silent-but-bounded —
 * a flaky store write must not kill the worker the heartbeat describes. */
export function startHeartbeat(store: Store, id: string, nowIso: () => string): () => void {
  const timer = setInterval(() => {
    void heartbeatRunner(store, id, nowIso()).catch(() => undefined);
  }, HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
