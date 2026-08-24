/**
 * The Postgres driver — the same Store contract, team-shared (RFC-001 §4: Postgres for
 * team, SQLite for solo, ONE repository interface).
 *
 * The client is injected as a minimal query interface, so the driver has no hard
 * dependency on a specific pg package version and tests run against pg-mem — no server,
 * no container, same SQL path.
 *
 * Same disciplines as the SQLite driver: gate appends validate through core (a malformed
 * verdict never lands), the queue replace is transactional (a reader never sees half a
 * queue), and pool state round-trips exactly (cooldowns survive any process death).
 */
import {
  serializeGateRecord,
  type AccountState,
  type GateRecord,
  type LedgerEntry,
  type Queue,
  type QueueEntry,
} from '@spicyspec/core';
import type { Store } from './sqlite-store.js';

/** The slice of a pg Pool/Client this driver needs. `pg` and pg-mem both satisfy it. */
export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  /** pool-style: checkout a dedicated connection — REQUIRED for transactions */
  connect?(): Promise<PgClientLike & { release(): void }>;
}

/**
 * Run `fn` inside a real transaction. Found by the contract suite: BEGIN/COMMIT issued
 * through a POOL land on different connections — no transaction at all, and the rollback
 * test's half-written queue survived. With a pool we check out ONE client; a bare client
 * is already one connection.
 */
async function withTx<T>(pg: PgClientLike, fn: (c: PgClientLike) => Promise<T>): Promise<T> {
  const dedicated = pg.connect ? await pg.connect() : null;
  const c = dedicated ?? pg;
  await c.query('BEGIN');
  try {
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    dedicated?.release();
  }
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS runs (
    id   BIGSERIAL PRIMARY KEY,
    tick INTEGER NOT NULL,
    json TEXT    NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS gates (
    id   BIGSERIAL PRIMARY KEY,
    spec TEXT NOT NULL,
    gate TEXT NOT NULL,
    at   TEXT NOT NULL,
    json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS gates_spec ON gates(spec)`,
  `CREATE TABLE IF NOT EXISTS pool (
    account TEXT PRIMARY KEY,
    json    TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS queue (
    id   TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    ord  INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

export interface PgStoreOptions {
  client: PgClientLike;
  /** called on close when the caller wants the pool ended with the store */
  end?: () => Promise<void>;
}

export async function openPgStore(options: PgStoreOptions): Promise<Store> {
  const pg = options.client;
  for (const stmt of SCHEMA) await pg.query(stmt);
  await pg.query(`INSERT INTO kv(key, value) VALUES ('schema_version', '1') ON CONFLICT (key) DO NOTHING`);

  return {
    /* ------------------------------------------------------------------ runs ---- */
    async appendRun(entry: LedgerEntry): Promise<void> {
      if (typeof entry.tick !== 'number') throw new Error('a run entry needs a numeric tick');
      await pg.query('INSERT INTO runs(tick, json) VALUES ($1, $2)', [entry.tick, JSON.stringify(entry)]);
    },

    async listRuns(limit = 0): Promise<LedgerEntry[]> {
      const { rows } =
        limit > 0
          ? await pg.query('SELECT json FROM runs ORDER BY id DESC LIMIT $1', [limit])
          : await pg.query('SELECT json FROM runs ORDER BY id ASC');
      const entries = rows.map((r) => JSON.parse(String(r['json'])) as LedgerEntry);
      return limit > 0 ? entries.reverse() : entries;
    },

    async nextRunNumber(): Promise<number> {
      const { rows } = await pg.query('SELECT MAX(tick) AS m FROM runs');
      return (Number(rows[0]?.['m'] ?? 0) || 0) + 1;
    },

    /* ----------------------------------------------------------------- gates ---- */
    async appendGate(record: GateRecord): Promise<void> {
      const json = serializeGateRecord(record);
      const parsed = JSON.parse(json) as GateRecord;
      await pg.query('INSERT INTO gates(spec, gate, at, json) VALUES ($1, $2, $3, $4)', [
        String(parsed.spec),
        String(parsed.gate),
        String(parsed.at),
        json,
      ]);
    },

    async listGates(specId?: string): Promise<GateRecord[]> {
      const { rows } = specId
        ? await pg.query('SELECT json FROM gates WHERE spec = $1 ORDER BY id ASC', [String(specId)])
        : await pg.query('SELECT json FROM gates ORDER BY id ASC');
      return rows.map((r) => JSON.parse(String(r['json'])) as GateRecord);
    },

    async exportGatesJsonl(): Promise<string> {
      const { rows } = await pg.query('SELECT json FROM gates ORDER BY id ASC');
      return rows.map((r) => String(r['json'])).join('\n') + (rows.length ? '\n' : '');
    },

    /* ------------------------------------------------------------------ pool ---- */
    async loadPoolState(): Promise<Record<string, AccountState>> {
      const { rows } = await pg.query('SELECT account, json FROM pool');
      return Object.fromEntries(rows.map((r) => [String(r['account']), JSON.parse(String(r['json'])) as AccountState]));
    },

    async savePoolState(state: Record<string, AccountState>): Promise<void> {
      await withTx(pg, async (c) => {
        for (const [account, s] of Object.entries(state)) {
          await c.query(
            'INSERT INTO pool(account, json) VALUES ($1, $2) ON CONFLICT (account) DO UPDATE SET json = EXCLUDED.json',
            [account, JSON.stringify(s)],
          );
        }
      });
    },

    /* ----------------------------------------------------------------- queue ---- */
    async loadQueue(): Promise<Queue> {
      const { rows } = await pg.query('SELECT json FROM queue ORDER BY ord ASC');
      return { entries: rows.map((r) => JSON.parse(String(r['json'])) as QueueEntry) };
    },

    async saveQueue(queue: Queue): Promise<void> {
      await withTx(pg, async (c) => {
        await c.query('DELETE FROM queue');
        for (let i = 0; i < queue.entries.length; i += 1) {
          const e = queue.entries[i];
          await c.query('INSERT INTO queue(id, json, ord) VALUES ($1, $2, $3)', [e.id, JSON.stringify(e), i]);
        }
      });
    },

    /* -------------------------------------------------------------------- kv ---- */
    async getKv(key: string): Promise<string | null> {
      const { rows } = await pg.query('SELECT value FROM kv WHERE key = $1', [key]);
      return rows.length ? String(rows[0]['value']) : null;
    },

    async setKv(key: string, value: string): Promise<void> {
      await pg.query('INSERT INTO kv(key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [
        key,
        value,
      ]);
    },

    async close(): Promise<void> {
      await options.end?.();
    },
  };
}
