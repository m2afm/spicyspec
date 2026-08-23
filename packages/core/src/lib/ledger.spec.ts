import { describe, expect, it } from 'vitest';
import { ledgerTotals, overageSummary, parseLedger } from './ledger.js';

const row = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ tick: 1, costUsd: 2, tasksClosed: 3, durationMinutes: 10, ...over });

describe('parseLedger', () => {
  it('parses rows and reports malformed lines as problems', () => {
    const { entries, problems } = parseLedger([row(), 'nope', row({ tick: 2 })].join('\n'));
    expect(entries).toHaveLength(2);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(':2');
  });

  it('an entry without a numeric tick is a problem, not data', () => {
    const { entries, problems } = parseLedger(JSON.stringify({ costUsd: 1 }));
    expect(entries).toHaveLength(0);
    expect(problems).toHaveLength(1);
  });
});

describe('ledgerTotals — distinct runs, not rows', () => {
  it('a rate-limited retry keeps its number and is not double-counted as a run', () => {
    const { entries } = parseLedger(
      [row({ tick: 40, exit: 'rate-limited' }), row({ tick: 40, exit: 'clean' }), row({ tick: 41 })].join('\n'),
    );
    const t = ledgerTotals(entries);
    expect(t.runs).toBe(2);
    expect(t.rows).toBe(3);
    expect(t.costUsd).toBe(6); // cost is real on every attempt
  });
});

describe('overageSummary — derived from records, never assumed', () => {
  it('no reported state → nothing can be asserted', () => {
    const s = overageSummary([{ tick: 1 }]);
    expect(s.assertable).toBe(false);
    expect(s.line).toContain('nothing can be asserted');
  });

  it('billed runs are counted and flagged', () => {
    const s = overageSummary([
      { tick: 1, overageStatus: 'allowed', usedOverage: false },
      { tick: 2, overageStatus: 'allowed', usedOverage: true },
    ]);
    expect(s.assertable).toBe(true);
    expect(s.billedRuns).toBe(1);
    expect(s.line).toContain('may be billable');
  });

  it('clean run states the states seen', () => {
    const s = overageSummary([{ tick: 1, overageStatus: 'rejected', usedOverage: false }]);
    expect(s.billedRuns).toBe(0);
    expect(s.line).toContain('rejected');
  });
});
