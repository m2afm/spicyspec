/**
 * THE STORE CONTRACT — one suite, every driver.
 *
 * SQLite (solo) and Postgres (team, via pg-mem — same SQL path, no server) must behave
 * identically behind the Store interface; a behavior that only one driver has is a bug
 * in one of them. Every rule the SQLite suite established runs against both.
 */
import { closingGate, parseGateRecords, type GateRecord } from '@spicyspec/core';
import { newDb } from 'pg-mem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openPgStore } from './pg-store.js';
import { openStore, type Store } from './sqlite-store.js';

const gate = (over: Partial<GateRecord> = {}): GateRecord => ({
  at: '2026-08-24T00:00:00Z',
  spec: '006',
  gate: 'closing',
  verdict: 'APPROVE',
  confidence: 0.9,
  seat: 'qa-critic',
  frozen: 'abc1234',
  ...over,
});

interface DriverCase {
  name: string;
  makeStore: () => Promise<Store>;
  /**
   * pg-mem cannot emulate rollback-after-error (probed: an inserted row survives
   * ROLLBACK). The driver's withTx (dedicated client, BEGIN/COMMIT/ROLLBACK) is exactly
   * what REAL Postgres requires — the contract suite CAUGHT the pool-level BEGIN bug —
   * but the emulator cannot prove the rollback half, so that one case is sqlite-only.
   */
  supportsRollbackProof: boolean;
}

const DRIVERS: DriverCase[] = [
  { name: 'sqlite', makeStore: async () => openStore(':memory:'), supportsRollbackProof: true },
  {
    name: 'postgres (pg-mem)',
    makeStore: async () => {
      const db = newDb();
      const { Pool } = db.adapters.createPg();
      const pool = new Pool();
      return openPgStore({ client: pool as never });
    },
    supportsRollbackProof: false,
  },
];

describe.each(DRIVERS)('store contract — $name', ({ makeStore, supportsRollbackProof }) => {
  let store: Store;

  beforeEach(async () => {
    store = await makeStore();
  });

  afterEach(async () => {
    await store.close();
  });

  describe('runs', () => {
    it('appends and lists in order; nextRunNumber follows the max', async () => {
      await store.appendRun({ tick: 1, exit: 'clean' });
      await store.appendRun({ tick: 2, exit: 'rate-limited' });
      await store.appendRun({ tick: 2, exit: 'clean' }); // retry keeps its number
      expect((await store.listRuns()).map((r) => r.exit)).toEqual(['clean', 'rate-limited', 'clean']);
      expect(await store.nextRunNumber()).toBe(3);
      expect(await store.listRuns(2)).toHaveLength(2);
    });

    it('an entry without a tick throws instead of storing garbage', async () => {
      await expect(store.appendRun({ exit: 'clean' } as never)).rejects.toThrow(/numeric tick/);
    });
  });

  describe('gates', () => {
    it('appendGate validates via core — a malformed verdict never lands', async () => {
      await expect(store.appendGate(gate({ verdict: 'MAYBE' as never }))).rejects.toThrow();
      expect(await store.listGates()).toHaveLength(0);
    });

    it('last write wins through core closingGate over the stored records', async () => {
      await store.appendGate(gate({ verdict: 'REVISE' }));
      await store.appendGate(gate({ verdict: 'APPROVE' }));
      const g = closingGate(await store.listGates('006'), '006');
      expect(g.state).toBe('approved');
      expect(g.count).toBe(2);
    });

    it('listGates filters by spec', async () => {
      await store.appendGate(gate({ spec: '006' }));
      await store.appendGate(gate({ spec: '007' }));
      expect(await store.listGates('007')).toHaveLength(1);
      expect(await store.listGates()).toHaveLength(2);
    });

    it('exportGatesJsonl round-trips through the core parser (the git-auditable trail)', async () => {
      await store.appendGate(gate({ verdict: 'REVISE' }));
      await store.appendGate(gate({ verdict: 'APPROVE' }));
      const { records, problems } = parseGateRecords(await store.exportGatesJsonl());
      expect(problems).toHaveLength(0);
      expect(records.map((r) => r.verdict)).toEqual(['REVISE', 'APPROVE']);
    });
  });

  describe('pool state', () => {
    it('C4: pool state round-trips — cooldowns survive an orchestrator restart', async () => {
      await store.savePoolState({
        primary: { coldUntilMs: 123, uses: 4, limitType: 'seven_day', limitTypeSeenAt: 'x', refusedReason: null, refusedAt: null },
      });
      const loaded = await store.loadPoolState();
      expect(loaded['primary'].coldUntilMs).toBe(123);
      expect(loaded['primary'].limitType).toBe('seven_day');
    });

    it('save is an upsert, not append', async () => {
      await store.savePoolState({ a: { uses: 1 } });
      await store.savePoolState({ a: { uses: 2 } });
      expect((await store.loadPoolState())['a'].uses).toBe(2);
    });
  });

  describe('queue', () => {
    it('B3/B22 class: whole-queue replace is transactional and order-preserving', async () => {
      await store.saveQueue({ entries: [{ id: '001', status: 'done' }, { id: '002', status: 'active', stage: 'build' }] });
      await store.saveQueue({ entries: [{ id: '002', status: 'active', stage: 'build' }, { id: '003', status: 'pending' }] });
      expect((await store.loadQueue()).entries.map((e) => e.id)).toEqual(['002', '003']);
    });

    it.runIf(supportsRollbackProof)('a failed save rolls back — the reader never sees half a queue', async () => {
      await store.saveQueue({ entries: [{ id: '001', status: 'pending' }] });
      const bad = { entries: [{ id: '002', status: 'pending' }, { id: '002', status: 'pending' }] }; // PK collision
      await expect(store.saveQueue(bad)).rejects.toThrow();
      expect((await store.loadQueue()).entries.map((e) => e.id)).toEqual(['001']); // untouched
    });
  });

  describe('kv', () => {
    it('get/set round-trips and upserts', async () => {
      expect(await store.getKv('k')).toBeNull();
      await store.setKv('k', 'v1');
      await store.setKv('k', 'v2');
      expect(await store.getKv('k')).toBe('v2');
    });

    it('tryReserve: first claim wins, second loses, release frees (the account-booking primitive)', async () => {
      expect(await store.tryReserve('lock:primary', 'run-1')).toBe(true);
      expect(await store.tryReserve('lock:primary', 'run-2')).toBe(false); // already booked
      expect(await store.getKv('lock:primary')).toBe('run-1'); // the winner's claim stands
      await store.release('lock:primary');
      expect(await store.tryReserve('lock:primary', 'run-3')).toBe(true);
    });

    it('listKv enumerates a prefix in key order and nothing else', async () => {
      await store.setKv('runner:beta', 'b');
      await store.setKv('runner:alpha', 'a');
      await store.setKv('other:x', 'z');
      expect(await store.listKv('runner:')).toEqual([
        { key: 'runner:alpha', value: 'a' },
        { key: 'runner:beta', value: 'b' },
      ]);
    });
  });
});
