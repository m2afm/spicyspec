/**
 * Regression suite for run classification. Cases named `B<n>` / `tick-<n>` replay defects
 * recorded in the Airvia prototype's register (RFC-001 §1.1).
 */
import { describe, expect, it } from 'vitest';
import {
  classify,
  detectLoopOfDoom,
  EXIT,
  isAccountRefused,
  isBlocked,
  type EvidenceSnapshot,
  type RunResult,
} from './classify.js';

const snap = (head: string, done: number, open: number, dirty: boolean, handoffMs: number): EvidenceSnapshot => ({
  git: { head, dirty },
  tasks: { exists: true, done, open },
  handoff: { mtimeMs: handoffMs },
});

const run = (over: Partial<RunResult> = {}): RunResult => ({
  killedFor: null,
  resultEnvelope: { total_cost_usd: 2, num_turns: 10 },
  rateLimit: null,
  text: '',
  toolCalls: 50,
  ...over,
});

describe('classify — exit classes', () => {
  it('clean forward tick', () => {
    const c = classify(run({ text: 'STATUS: continuing' }), snap('a', 20, 15, false, 1), snap('b', 24, 11, false, 2));
    expect(c.exit).toBe(EXIT.CLEAN);
    expect(c.commits).toBe(true);
    expect(c.tasksClosed).toBe(4);
  });

  it('B8-class: fabricated progress — claims green, no commit, no movement → no-progress', () => {
    const c = classify(
      run({ text: 'all 674 tests pass', resultEnvelope: { total_cost_usd: 1, num_turns: 9 } }),
      snap('a', 20, 15, false, 1),
      snap('a', 20, 15, true, 1),
    );
    expect(c.exit).toBe(EXIT.NO_PROGRESS);
  });

  it('spec-complete: no open tasks, clean tree', () => {
    const c = classify(run({ text: 'done' }), snap('a', 30, 2, false, 1), snap('b', 32, 0, false, 2));
    expect(c.exit).toBe(EXIT.SPEC_COMPLETE);
  });

  it('awaiting-review outranks spec-complete', () => {
    const c = classify(
      run({ text: 'STATUS: awaiting-review' }),
      snap('a', 30, 2, false, 1),
      snap('b', 32, 0, false, 2),
    );
    expect(c.exit).toBe(EXIT.AWAITING_REVIEW);
  });

  it('legacy AWAITING FOUNDER marker still classifies as awaiting-review', () => {
    const c = classify(run({ text: 'AWAITING_FOUNDER' }), snap('a', 30, 2, false, 1), snap('b', 32, 0, false, 2));
    expect(c.exit).toBe(EXIT.AWAITING_REVIEW);
  });

  it('stall kill', () => {
    const c = classify(
      run({ killedFor: 'stall', resultEnvelope: null }),
      snap('a', 1, 5, false, 1),
      snap('a', 1, 5, false, 1),
    );
    expect(c.exit).toBe(EXIT.STALLED);
  });

  it('rate limit outranks a hang kill', () => {
    const c = classify(
      run({ killedFor: 'hang', rateLimit: { status: 'rejected', resetsAt: 123 }, resultEnvelope: null }),
      snap('a', 1, 5, false, 1),
      snap('a', 1, 5, false, 1),
    );
    expect(c.exit).toBe(EXIT.RATE_LIMITED);
    expect(c.resetsAt).toBe(123);
  });

  it('B15: an operator kill is ABORTED, never a worker failure', () => {
    const c = classify(
      run({ killedFor: 'stop-now', resultEnvelope: null }),
      snap('a', 1, 5, false, 1),
      snap('a', 1, 5, false, 1),
    );
    expect(c.exit).toBe(EXIT.ABORTED);
  });

  it('tick-27 (B31-class): zero tool calls with a clean turn is NO_ATTEMPT, never a stall', () => {
    const c = classify(
      run({ toolCalls: 0, text: 'Full ruleset active. Now: orient.' }),
      snap('a', 1, 5, false, 1),
      snap('a', 1, 5, false, 1),
    );
    expect(c.exit).toBe(EXIT.NO_ATTEMPT);
  });

  it('B19: a watchdog kill has UNKNOWN cost, not zero', () => {
    const c = classify(
      run({ killedFor: 'hang', resultEnvelope: null }),
      snap('a', 1, 5, false, 1),
      snap('a', 1, 5, false, 1),
    );
    expect(c.costKnown).toBe(false);
    expect(c.exit).toBe(EXIT.HUNG);
  });

  it('an error envelope classifies as errored', () => {
    const c = classify(
      run({ resultEnvelope: { is_error: true, result: 'boom' } }),
      snap('a', 1, 5, false, 1),
      snap('a', 1, 5, false, 1),
    );
    expect(c.exit).toBe(EXIT.ERRORED);
  });
});

describe('B29: account refusal is infrastructure, not work', () => {
  it('403 at the door classifies as ACCOUNT_REFUSED before errored', () => {
    const c = classify(
      run({ resultEnvelope: { is_error: true, api_error_status: 403, result: 'Your organization has disabled Claude subscription access' } }),
      snap('a', 1, 5, false, 1),
      snap('a', 1, 5, false, 1),
    );
    expect(c.exit).toBe(EXIT.ACCOUNT_REFUSED);
    expect(c.refusal).toContain('disabled');
  });

  it('quota-cycle refusal text matches (the 2026-08-23 Kimi shape)', () => {
    expect(
      isAccountRefused({ is_error: true, result: "You've reached your usage limit for this billing cycle." }),
    ).toBe(true);
  });

  it('a healthy envelope is not a refusal', () => {
    expect(isAccountRefused({ total_cost_usd: 1 })).toBe(false);
    expect(isAccountRefused(null)).toBe(false);
  });
});

describe('B10: allowed_warning is NOT a rate limit', () => {
  it('allowed_warning keeps serving', () => {
    expect(isBlocked({ status: 'allowed_warning', utilization: 0.95 })).toBe(false);
  });

  it('rejected/blocked/exhausted/limited block', () => {
    for (const status of ['rejected', 'blocked', 'exhausted', 'limited', 'REJECTED']) {
      expect(isBlocked({ status })).toBe(true);
    }
  });

  it('missing status is not blocked', () => {
    expect(isBlocked(null)).toBe(false);
    expect(isBlocked({})).toBe(false);
  });
});

describe('detectLoopOfDoom — consecutive fix-shaped commits', () => {
  const c = (sha: string, subject: string) => ({ sha, subject });

  it('fires on a full window of fix/test commits', () => {
    const hit = detectLoopOfDoom([c('1', 'fix(006): a'), c('2', 'test(006): b'), c('3', 'fix(006): c')], 3);
    expect(hit?.pattern).toBe('consecutive-fix-commits');
    expect(hit?.commits).toEqual(['1', '2', '3']);
  });

  it('a forward commit inside the window clears it', () => {
    expect(detectLoopOfDoom([c('1', 'fix(006): a'), c('2', 'feat(006): b'), c('3', 'fix(006): c')], 3)).toBeNull();
  });

  it('an underfilled window never fires', () => {
    expect(detectLoopOfDoom([c('1', 'fix(006): a')], 3)).toBeNull();
  });
});

describe('worker-declared stage completion', () => {
  it('RUN_STATUS: spec-complete on a CLEAN tree classifies spec-complete (artifact stages have no task list)', () => {
    const c = classify(
      run({ text: 'wrote the plan.\nRUN_STATUS: spec-complete' }),
      snap('a', 0, 0, false, 1),
      snap('b', 0, 0, false, 2),
    );
    expect(c.exit).toBe(EXIT.SPEC_COMPLETE);
  });

  it('the declaration is IGNORED on a dirty tree — evidence outranks narration', () => {
    const c = classify(
      run({ text: 'RUN_STATUS: spec-complete' }),
      snap('a', 0, 0, false, 1),
      snap('b', 0, 0, true, 2),
    );
    expect(c.exit).toBe(EXIT.CLEAN);
  });

  it('legacy TICK_STATUS marker still counts', () => {
    const c = classify(run({ text: 'TICK_STATUS: spec-complete' }), snap('a', 0, 0, false, 1), snap('b', 0, 0, false, 2));
    expect(c.exit).toBe(EXIT.SPEC_COMPLETE);
  });
});

describe('RUN_STATUS: blocked (the 009 wrongly-parked class)', () => {
  it('an explicit blocked declaration classifies as blocked, never no-progress', () => {
    const c = classify(
      run({ text: 'seats denied.' + String.fromCharCode(10) + 'RUN_STATUS: blocked' }),
      snap('a', 20, 15, false, 1),
      snap('a', 20, 15, false, 1),
    );
    expect(c.exit).toBe(EXIT.BLOCKED);
  });
});