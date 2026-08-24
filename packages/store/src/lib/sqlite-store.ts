/**
 * The runner-local state store — RFC-001 layer 6, SQLite driver.
 *
 * Replaces the prototype's flat files (QUEUE.json, LEDGER.jsonl, ACCOUNTS.json), whose
 * shared-index/partial-write/worker-writable class produced five recorded defects
 * (B1, B2, B3, B21, B22). One ACID database, WAL mode, transactions — a run's state
 * change either lands whole or not at all, and no worker "finished the project" by
 * scribbling a JSON file (B21: the finish check now reads THIS store, which lives under
 * a protected path the provider layer denies writes to).
 *
 * Built on `node:sqlite` — ships with Node ≥ 23.4, ZERO native dependencies. A product
 * installed on team machines must not require a compiler toolchain (the prototype's pm2
 * lesson generalized: every native dependency is a support ticket).
 *
 * Gate records keep a JSONL EXPORT for the git-auditable trail (RFC-001 §7.7) — the DB is
 * truth, the JSONL is the ledger humans diff.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { serializeGateRecord, type AccountState, type GateRecord, type LedgerEntry, type Queue, type QueueEntry } from '@spicyspec/core';

export interface RunStore {
  appendRun(entry: LedgerEntry): Promise<void>;
  listRuns(limit?: number): Promise<LedgerEntry[]>;
  nextRunNumber(): Promise<number>;
}

export interface GateStore {
  appendGate(record: GateRecord): Promise<void>;
  listGates(specId?: string): Promise<GateRecord[]>;
  /** git-auditable export — one JSON object per line, append order preserved */
  exportGatesJsonl(): Promise<string>;
}

export interface PoolStore {
  loadPoolState(): Promise<Record<string, AccountState>>;
  savePoolState(state: Record<string, AccountState>): Promise<void>;
}

export interface QueueStore {
  loadQueue(): Promise<Queue>;
  saveQueue(queue: Queue): Promise<void>;
}

export interface KvStore {
  getKv(key: string): Promise<string | null>;
  setKv(key: string, value: string): Promise<void>;
  /** every key under a prefix — how the dashboard enumerates runners, decisions, etc. */
  listKv(prefix: string): Promise<Array<{ key: string; value: string }>>;
}

export type Store = RunStore & GateStore & PoolStore & QueueStore & KvStore & { close(): Promise<void> };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  tick    INTEGER NOT NULL,
  json    TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS gates (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  spec    TEXT    NOT NULL,
  gate    TEXT    NOT NULL,
  at      TEXT    NOT NULL,
  json    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS gates_spec ON gates(spec);
CREATE TABLE IF NOT EXISTS pool (
  account TEXT PRIMARY KEY,
  json    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS queue (
  id      TEXT PRIMARY KEY,
  json    TEXT NOT NULL,
  ord     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key     TEXT PRIMARY KEY,
  value   TEXT NOT NULL
);
`;

/** Open (or create) the store. Pass ':memory:' for tests. */
export function openStore(path: string): Store {
  // A fresh checkout has no state directory yet — first open creates it (found by the
  // first real migration: ERR_SQLITE_ERROR 14 on a missing parent).
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  db.exec("INSERT OR IGNORE INTO kv(key, value) VALUES ('schema_version', '1');");

  return {
    /* ------------------------------------------------------------------ runs ---- */
    async appendRun(entry: LedgerEntry): Promise<void> {
      if (typeof entry.tick !== 'number') throw new Error('a run entry needs a numeric tick');
      db.prepare('INSERT INTO runs(tick, json) VALUES (?, ?)').run(entry.tick, JSON.stringify(entry));
    },

    async listRuns(limit = 0): Promise<LedgerEntry[]> {
      const sql = limit > 0 ? 'SELECT json FROM runs ORDER BY id DESC LIMIT ?' : 'SELECT json FROM runs ORDER BY id ASC';
      const rows = (limit > 0 ? db.prepare(sql).all(limit) : db.prepare(sql).all()) as Array<{ json: string }>;
      const entries = rows.map((r) => JSON.parse(r.json) as LedgerEntry);
      return limit > 0 ? entries.reverse() : entries;
    },

    async nextRunNumber(): Promise<number> {
      const row = db.prepare('SELECT MAX(tick) AS m FROM runs').get() as { m: number | null };
      return (row.m ?? 0) + 1;
    },

    /* ----------------------------------------------------------------- gates ---- */
    async appendGate(record: GateRecord): Promise<void> {
      // serializeGateRecord validates — a malformed verdict must throw, never append (core rule).
      const json = serializeGateRecord(record);
      const parsed = JSON.parse(json) as GateRecord;
      db.prepare('INSERT INTO gates(spec, gate, at, json) VALUES (?, ?, ?, ?)').run(
        String(parsed.spec),
        String(parsed.gate),
        String(parsed.at),
        json,
      );
    },

    async listGates(specId?: string): Promise<GateRecord[]> {
      const rows = (
        specId
          ? db.prepare('SELECT json FROM gates WHERE spec = ? ORDER BY id ASC').all(String(specId))
          : db.prepare('SELECT json FROM gates ORDER BY id ASC').all()
      ) as Array<{ json: string }>;
      return rows.map((r) => JSON.parse(r.json) as GateRecord);
    },

    async exportGatesJsonl(): Promise<string> {
      const rows = db.prepare('SELECT json FROM gates ORDER BY id ASC').all() as Array<{ json: string }>;
      return rows.map((r) => r.json).join('\n') + (rows.length ? '\n' : '');
    },

    /* ------------------------------------------------------------------ pool ---- */
    async loadPoolState(): Promise<Record<string, AccountState>> {
      const rows = db.prepare('SELECT account, json FROM pool').all() as Array<{ account: string; json: string }>;
      return Object.fromEntries(rows.map((r) => [r.account, JSON.parse(r.json) as AccountState]));
    },

    async savePoolState(state: Record<string, AccountState>): Promise<void> {
      const upsert = db.prepare(
        'INSERT INTO pool(account, json) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET json = excluded.json',
      );
      db.exec('BEGIN');
      try {
        for (const [account, s] of Object.entries(state)) upsert.run(account, JSON.stringify(s));
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    /* ----------------------------------------------------------------- queue ---- */
    async loadQueue(): Promise<Queue> {
      const rows = db.prepare('SELECT json FROM queue ORDER BY ord ASC').all() as Array<{ json: string }>;
      return { entries: rows.map((r) => JSON.parse(r.json) as QueueEntry) };
    },

    async saveQueue(queue: Queue): Promise<void> {
      // Whole-queue replace inside one transaction: the reader never sees half a queue
      // (the B3/B22 class — a partially-rewritten state file observed mid-write).
      db.exec('BEGIN');
      try {
        db.exec('DELETE FROM queue');
        const insert = db.prepare('INSERT INTO queue(id, json, ord) VALUES (?, ?, ?)');
        queue.entries.forEach((e, i) => insert.run(e.id, JSON.stringify(e), i));
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    /* -------------------------------------------------------------------- kv ---- */
    async getKv(key: string): Promise<string | null> {
      const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },

    async setKv(key: string, value: string): Promise<void> {
      db.prepare('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        key,
        value,
      );
    },

    async listKv(prefix: string): Promise<Array<{ key: string; value: string }>> {
      const rows = db
        .prepare("SELECT key, value FROM kv WHERE key LIKE ? || '%' ORDER BY key ASC")
        .all(prefix) as Array<{ key: string; value: string }>;
      return rows;
    },

    async close(): Promise<void> {
      db.close();
    },
  };
}
