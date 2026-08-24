/**
 * Regression suite for the queue invariants and the attribution rule.
 *
 * Cases named `B<n>` / `tick-34` replay defects recorded in the Airvia prototype's
 * BUGS-ON-THE-GO.md register — the founding asset this package ports (RFC-001 §1.1).
 */
import { describe, expect, it } from 'vitest';
import {
  applyRepairs,
  attribution,
  checkQueue,
  mayAdvance,
  promoteSignedOff,
  specIdsIn,
  type Queue,
  type QueueEntry,
  type QueueEvidence,
} from './queue-guard.js';

/** Evidence stub. Everything is healthy unless a test says otherwise. */
const ev = (over: Partial<QueueEvidence> = {}): QueueEvidence => ({
  specDirExists: () => true,
  commitsFor: () => 5,
  signedOff: () => true,
  reviewCapBlocks: () => false,
  ...over,
});

const Q = (...entries: Array<string | QueueEntry>): Queue => ({
  entries: entries.map((e) => (typeof e === 'string' ? { id: e, status: 'pending' } : e)),
});

const codes = (r: ReturnType<typeof checkQueue>) => r.violations.map((v) => v.code).sort().join(',');

describe('checkQueue — healthy states are left alone', () => {
  it('no violations on a queue whose evidence supports every state', () => {
    const q = Q(
      { id: '001', status: 'parked' },
      { id: '002', status: 'done' },
      { id: '003', status: 'awaiting-review' },
      { id: '004', status: 'active', stage: 'build' },
      { id: '005', status: 'pending' },
    );
    expect(checkQueue(q, ev()).violations).toHaveLength(0);
  });

  it('an empty queue is not a fault', () => {
    expect(checkQueue({ entries: [] }, ev()).violations).toHaveLength(0);
  });

  it('a null queue is tolerated', () => {
    expect(checkQueue(null, ev()).violations).toHaveLength(0);
  });
});

describe('halts — states the loop cannot reason about (never guess)', () => {
  it('Q1: unknown status halts', () => {
    const r = checkQueue(Q({ id: '001', status: 'wip' }), ev());
    expect(r.halting.map((v) => v.code)).toEqual(['Q1']);
  });

  it('Q2: duplicate ids halt', () => {
    const r = checkQueue(Q('001', { id: '001', status: 'done' }), ev());
    expect(r.halting.map((v) => v.code)).toEqual(['Q2']);
  });

  it('Q3: two active entries halt — the outcome pointer would be arbitrary', () => {
    const r = checkQueue(
      Q({ id: '001', status: 'active', stage: 'build' }, { id: '002', status: 'active', stage: 'build' }),
      ev(),
    );
    expect(r.halting.map((v) => v.code)).toEqual(['Q3']);
    expect(r.halting[0].id).toBe('001,002');
  });
});

describe('repairs — unambiguous from evidence', () => {
  it('Q4 (B45): awaiting-review with no spec directory repairs to pending', () => {
    const q = Q({ id: '006', status: 'awaiting-review' });
    const r = checkQueue(q, ev({ specDirExists: () => false }));
    expect(codes(r)).toBe('Q4');
    const { applied } = applyRepairs(q, r.violations, '2026-08-24T00:00:00Z');
    expect(applied).toHaveLength(1);
    expect(q.entries[0].status).toBe('pending');
    expect(q.entries[0].repairedAt).toBe('2026-08-24T00:00:00Z');
  });

  it('Q5: spec directory but zero commits naming it repairs to pending', () => {
    const q = Q({ id: '099', status: 'awaiting-review' });
    const r = checkQueue(q, ev({ commitsFor: () => 0 }));
    expect(codes(r)).toBe('Q5');
    applyRepairs(q, r.violations);
    expect(q.entries[0].status).toBe('pending');
  });

  it('Q7: active entry with no stage gains stage "shape" without a status change', () => {
    const q = Q({ id: '004', status: 'active' });
    const r = checkQueue(q, ev());
    expect(codes(r)).toBe('Q7');
    applyRepairs(q, r.violations);
    expect(q.entries[0].status).toBe('active');
    expect(q.entries[0].stage).toBe('shape');
  });

  it('repairs reset closedAt when demoting to pending', () => {
    const q = Q({ id: '006', status: 'awaiting-review', closedAt: '2026-08-23T00:00:00Z' });
    const r = checkQueue(q, ev({ specDirExists: () => false }));
    applyRepairs(q, r.violations);
    expect(q.entries[0].closedAt).toBeNull();
  });
});

describe('warns — evidence weaker than the action would be', () => {
  it('Q6 (B21-class): done without sign-off evidence warns, never demotes', () => {
    const q = Q({ id: '002', status: 'done' });
    const r = checkQueue(q, ev({ signedOff: () => false }));
    expect(codes(r)).toBe('Q6');
    expect(r.violations[0].severity).toBe('warn');
    applyRepairs(q, r.violations);
    expect(q.entries[0].status).toBe('done'); // warn changed nothing
  });

  it('Q8: idle with pending work and no cap warns', () => {
    const r = checkQueue(Q('005'), ev());
    expect(codes(r)).toBe('Q8');
  });

  it('Q8 does not fire when the review cap is the reason for idling', () => {
    const r = checkQueue(Q('005'), ev({ reviewCapBlocks: () => true }));
    expect(r.violations).toHaveLength(0);
  });
});

describe('specIdsIn — the type(NNN) commit convention', () => {
  it('extracts unique three-digit ids', () => {
    expect(specIdsIn(['feat(006): a', 'fix(006): b', 'docs(005): c'])).toEqual(['006', '005']);
  });

  it('ignores non-conforming subjects', () => {
    expect(specIdsIn(['chore: bump deps', 'merge branch'])).toEqual([]);
  });
});

describe('attribution — the tick-34 incident guard', () => {
  it('tick-34 replay: dispatched for 006, committed only against 005 → mismatch withholds the advance', () => {
    const subjects = Array.from({ length: 14 }, (_, i) => `fix(005): finding ${i + 1}`);
    const attr = attribution(subjects, '006');
    expect(attr.verdict).toBe('mismatch');
    const adv = mayAdvance(attr);
    expect(adv.ok).toBe(false);
    expect(adv.reason).toContain('005');
  });

  it('a matching commit advances', () => {
    const attr = attribution(['feat(006): reconciler'], '006');
    expect(attr.verdict).toBe('match');
    expect(mayAdvance(attr).ok).toBe(true);
  });

  it('silence is NOT a mismatch — research passes commit nothing', () => {
    const attr = attribution([], '006');
    expect(attr.verdict).toBe('silent');
    expect(mayAdvance(attr).ok).toBe(true);
  });

  it('unattributed commits advance — the convention is not universal', () => {
    const attr = attribution(['chore: tidy'], '006');
    expect(attr.verdict).toBe('unattributed');
    expect(mayAdvance(attr).ok).toBe(true);
  });

  it('no active entry cannot mismatch', () => {
    const attr = attribution(['feat(005): x'], null);
    expect(attr.verdict).toBe('no-active');
    expect(mayAdvance(attr).ok).toBe(true);
  });
});

describe('Q3 with a parallel cap', () => {
  it('N active within the cap is legal; past it halts', () => {
    const q = Q(
      { id: '001', status: 'active', stage: 'execute' },
      { id: '002', status: 'active', stage: 'execute' },
      { id: '003', status: 'active', stage: 'execute' },
    );
    expect(checkQueue(q, ev(), { maxActive: 3 }).halting).toHaveLength(0);
    expect(checkQueue(q, ev(), { maxActive: 2 }).halting.map((v) => v.code)).toEqual(['Q3']);
    // the single-writer default is unchanged
    expect(checkQueue(q, ev()).halting.map((v) => v.code)).toEqual(['Q3']);
  });
});

describe('promoteSignedOff — the founder click that resumes the loop', () => {
  it('credits every awaiting-review entry whose sign-off exists, and nothing else', () => {
    const q = Q(
      { id: '001', status: 'awaiting-review' },
      { id: '002', status: 'awaiting-review' },
      { id: '003', status: 'active', stage: 'execute' },
      { id: '004', status: 'parked' },
    );
    const promoted = promoteSignedOff(q, (id) => id === '001' || id === '003' || id === '004', 'AT');
    expect(promoted).toEqual(['001']);
    expect(q.entries.map((e) => e.status)).toEqual(['done', 'awaiting-review', 'active', 'parked']);
    expect(q.entries[0].closedAt).toBe('AT');
  });

  it('with nothing signed off it touches nothing and reports nothing', () => {
    const q = Q({ id: '001', status: 'awaiting-review' });
    expect(promoteSignedOff(q, () => false)).toEqual([]);
    expect(q.entries[0].status).toBe('awaiting-review');
  });
});
