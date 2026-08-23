import { closingGate, parseGateRecords, type GateRecord } from '@spicyspec/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './sqlite-store.js';

let store: Store;

beforeEach(() => {
  store = openStore(':memory:');
});

afterEach(() => {
  store.close();
});

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

describe('runs', () => {
  it('appends and lists in order; nextRunNumber follows the max', () => {
    store.appendRun({ tick: 1, exit: 'clean' });
    store.appendRun({ tick: 2, exit: 'rate-limited' });
    store.appendRun({ tick: 2, exit: 'clean' }); // retry keeps its number
    expect(store.listRuns().map((r) => r.exit)).toEqual(['clean', 'rate-limited', 'clean']);
    expect(store.nextRunNumber()).toBe(3);
    expect(store.listRuns(2)).toHaveLength(2);
  });

  it('an entry without a tick throws instead of storing garbage', () => {
    expect(() => store.appendRun({ exit: 'clean' } as never)).toThrow(/numeric tick/);
  });
});

describe('gates', () => {
  it('appendGate validates via core — a malformed verdict never lands', () => {
    expect(() => store.appendGate(gate({ verdict: 'MAYBE' as never }))).toThrow();
    expect(store.listGates()).toHaveLength(0);
  });

  it('last write wins through core closingGate over the stored records', () => {
    store.appendGate(gate({ verdict: 'REVISE' }));
    store.appendGate(gate({ verdict: 'APPROVE' }));
    const g = closingGate(store.listGates('006'), '006');
    expect(g.state).toBe('approved');
    expect(g.count).toBe(2);
  });

  it('listGates filters by spec', () => {
    store.appendGate(gate({ spec: '006' }));
    store.appendGate(gate({ spec: '007' }));
    expect(store.listGates('007')).toHaveLength(1);
    expect(store.listGates()).toHaveLength(2);
  });

  it('exportGatesJsonl round-trips through the core parser (the git-auditable trail)', () => {
    store.appendGate(gate({ verdict: 'REVISE' }));
    store.appendGate(gate({ verdict: 'APPROVE' }));
    const { records, problems } = parseGateRecords(store.exportGatesJsonl());
    expect(problems).toHaveLength(0);
    expect(records.map((r) => r.verdict)).toEqual(['REVISE', 'APPROVE']);
  });
});

describe('pool state', () => {
  it('C4: pool state round-trips — cooldowns survive an orchestrator restart', () => {
    store.savePoolState({
      primary: { coldUntilMs: 123, uses: 4, limitType: 'seven_day', limitTypeSeenAt: 'x', refusedReason: null, refusedAt: null },
    });
    const loaded = store.loadPoolState();
    expect(loaded['primary'].coldUntilMs).toBe(123);
    expect(loaded['primary'].limitType).toBe('seven_day');
  });

  it('save is an upsert, not append', () => {
    store.savePoolState({ a: { uses: 1 } });
    store.savePoolState({ a: { uses: 2 } });
    expect(store.loadPoolState()['a'].uses).toBe(2);
  });
});

describe('queue', () => {
  it('B3/B22 class: whole-queue replace is transactional and order-preserving', () => {
    store.saveQueue({ entries: [{ id: '001', status: 'done' }, { id: '002', status: 'active', stage: 'build' }] });
    store.saveQueue({ entries: [{ id: '002', status: 'active', stage: 'build' }, { id: '003', status: 'pending' }] });
    const q = store.loadQueue();
    expect(q.entries.map((e) => e.id)).toEqual(['002', '003']);
  });

  it('a failed save rolls back — the reader never sees half a queue', () => {
    store.saveQueue({ entries: [{ id: '001', status: 'pending' }] });
    const bad = { entries: [{ id: '002', status: 'pending' }, { id: '002', status: 'pending' }] }; // PK collision
    expect(() => store.saveQueue(bad)).toThrow();
    expect(store.loadQueue().entries.map((e) => e.id)).toEqual(['001']); // untouched
  });
});
