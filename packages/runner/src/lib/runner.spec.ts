/**
 * Runner suite — parsing rules and wiring, all dependencies faked. Defect ids reference
 * the prototype register.
 */
import type { Classification } from '@spicyspec/core';
import { openStore } from '@spicyspec/store';
import type { ProviderAdapter, WorkerEvent } from '@spicyspec/provider';
import { describe, expect, it } from 'vitest';
import { parseRunnerConfig } from './config.js';
import { parsePorcelain, snapshot } from './git-snapshot.js';
import { countTasks } from './tasks.js';
import { createRunnerActivities, loadPoolFromStore, NoWarmAccountError, settlePool, type RunnerDeps } from './wiring.js';

/* ------------------------------------------------------------------------- tasks ---- */

describe('countTasks — B28: prose is never a task', () => {
  it('counts only checkbox lines with a bold task id', () => {
    const text = [
      '- [ ] **T010** RED-first unit (resume)',
      '  - [x] **T011** implement resumeUnderLock',
      '- [ ] plain bullet that mentions T012 in prose',
      '* [X] **T013** star bullets and capital X count',
      'Some paragraph with - [ ] mid-line noise',
    ].join('\n');
    const t = countTasks(text);
    expect(t).toEqual({ exists: true, done: 2, open: 1, nextTaskIds: ['T010'] });
  });

  it('a missing file is a fact, not an error', () => {
    expect(countTasks(null)).toEqual({ exists: false, done: 0, open: 0, nextTaskIds: [] });
  });

  it('nextTaskIds is bounded', () => {
    const text = Array.from({ length: 9 }, (_, i) => `- [ ] **T00${i}** x`).join('\n');
    expect(countTasks(text).nextTaskIds).toEqual(['T000', 'T001', 'T002']);
  });
});

/* ------------------------------------------------------------------ git snapshot ---- */

describe('parsePorcelain — B1: never trim the status line', () => {
  it('an unstaged-only line keeps its full path', () => {
    const out = ' M apps/api/src/thing.ts\n?? new-file.ts\nA  staged.ts\n';
    const s = parsePorcelain(out);
    expect(s.dirty).toBe(true);
    expect(s.dirtyPaths).toEqual(['apps/api/src/thing.ts', 'new-file.ts', 'staged.ts']);
  });

  it('a clean tree is clean', () => {
    expect(parsePorcelain('')).toEqual({ dirty: false, dirtyPaths: [] });
  });
});

describe('snapshot', () => {
  const gitOutputs: Record<string, string> = {
    'rev-parse HEAD': 'abc1234\n',
    'branch --show-current': 'main\n',
    'log -1 --format=%s': 'feat: x\n',
    'status --porcelain': ' M a.ts\n',
  };

  it('assembles git facts, task counts, and handoff mtime with injected I/O', async () => {
    const snap = await snapshot({
      cwd: '/repo',
      tasksFile: '/repo/specs/006/tasks.md',
      handoffFile: '/repo/HANDOFF.md',
      execFn: async (cmd, args) => {
        expect(cmd).toBe('git');
        expect(args[0]).toBe('--no-optional-locks'); // B22
        return gitOutputs[args.slice(1).join(' ')] ?? '';
      },
      readFileFn: async () => '- [ ] **T001** a\n- [x] **T002** b\n',
      statMtimeMsFn: async () => 777,
    });
    expect(snap.git).toMatchObject({ head: 'abc1234', branch: 'main', dirty: true, dirtyPaths: ['a.ts'] });
    expect(snap.tasks).toMatchObject({ exists: true, done: 1, open: 1, nextTaskIds: ['T001'] });
    expect(snap.handoff.mtimeMs).toBe(777);
  });

  it('a spec with no task list yet snapshots exists:false', async () => {
    const snap = await snapshot({
      cwd: '/repo',
      tasksFile: '/repo/specs/099/tasks.md',
      execFn: async (_c, args) => gitOutputs[args.slice(1).join(' ')] ?? '',
      readFileFn: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(snap.tasks.exists).toBe(false);
  });
});

/* ------------------------------------------------------------------------ config ---- */

describe('parseRunnerConfig', () => {
  it('a minimal config gains every default', () => {
    const c = parseRunnerConfig({ projectName: 'Acme', repoCwd: '/repo', accounts: [{ id: 'primary' }] });
    expect(c.temporal.address).toBe('localhost:7233');
    expect(c.worker.protectedPaths).toEqual(['.spicyspec/']);
    expect(c.accounts[0].enabled).toBe(true);
  });

  it('a typo is a startup error with the path named', () => {
    expect(() => parseRunnerConfig({ projectName: 'Acme', repoCwd: '/repo', accounts: [] })).toThrow(/accounts/);
  });
});

/* ------------------------------------------------------------------------ wiring ---- */

const cls = (over: Partial<Classification> = {}): Classification =>
  ({
    exit: 'clean',
    progressed: true,
    commits: true,
    tasksClosed: 1,
    tasksOpen: 3,
    dirty: false,
    costUsd: 2,
    turns: 5,
    sessionId: 's',
    apiError: null,
    isError: null,
    overageStatus: 'rejected',
    usedOverage: false,
    rateStatus: 'allowed',
    rateResetsAt: null,
    utilization: 0.4,
    rateLimitType: null,
    costKnown: true,
    ...over,
  }) as Classification;

function makeDeps(over: Partial<RunnerDeps> = {}): RunnerDeps {
  const store = openStore(':memory:');
  return {
    config: parseRunnerConfig({
      projectName: 'Acme',
      repoCwd: '/repo',
      accounts: [{ id: 'primary' }, { id: 'secondary' }],
    }),
    store,
    provider: { id: 'fake', createSession: () => ({ events: fakeEvents, interrupt: async () => undefined }) } as ProviderAdapter,
    snapshotFn: async () => ({
      git: { head: 'h1', dirty: false, branch: 'main', headSubject: 's', dirtyPaths: [] },
      tasks: { exists: true, done: 1, open: 2, nextTaskIds: ['T002'] },
      handoff: { mtimeMs: 1 },
    }),
    nowMs: () => 1_000_000,
    nowIso: () => '2026-08-24T00:00:00Z',
    ...over,
  };
}

async function* fakeEvents(): AsyncGenerator<WorkerEvent> {
  yield { type: 'tool_use', id: '1', name: 'Bash', input: {}, parentToolUseId: null };
  yield { type: 'result', envelope: { total_cost_usd: 1, num_turns: 2, result: 'RUN_STATUS: continuing' } };
}

describe('settlePool', () => {
  it('a rate-limited run cools the account and the cooldown SURVIVES a reload (C4)', () => {
    const deps = makeDeps();
    settlePool(deps, cls({ exit: 'rate-limited', rateResetsAt: 2_000, rateLimitType: 'five_hour' }), 'primary');
    const pool = loadPoolFromStore(deps);
    const primary = pool.accounts.find((a) => a.id === 'primary');
    expect(primary?.coldUntilMs).toBe(2_000 * 1000 + 60_000);
    expect(primary?.limitType).toBe('five_hour');
    expect(primary?.uses).toBe(1);
  });

  it('B29: a refusal sidelines long and records the reason', () => {
    const deps = makeDeps();
    settlePool(deps, cls({ exit: 'account-refused', refusal: 'org disabled access' }), 'secondary');
    const acc = loadPoolFromStore(deps).accounts.find((a) => a.id === 'secondary');
    expect(acc?.coldUntilMs).toBe(1_000_000 + 6 * 3600_000);
    expect(acc?.refusedReason).toBe('org disabled access');
  });
});

describe('createRunnerActivities', () => {
  it('runs a session end to end: packet built, session drained, classification stored', async () => {
    const deps = makeDeps();
    const activities = createRunnerActivities(deps);
    const outcome = await activities.runWorkerSession({ specId: '006', run: 1 });
    expect(outcome.exit).toBe('no-progress'); // same snapshot before/after — nothing moved
    const runs = deps.store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ tick: 1, exit: 'no-progress', account: 'primary' });
  });

  it('packet carries the project, the stage, and the position from the snapshot', async () => {
    const deps = makeDeps();
    let prompt = '';
    deps.provider = {
      id: 'fake',
      createSession: (opts) => {
        prompt = opts.prompt;
        return { events: fakeEvents, interrupt: async () => undefined };
      },
    } as ProviderAdapter;
    await createRunnerActivities(deps).runWorkerSession({ specId: '006', run: 3 });
    expect(prompt).toContain('ACME DELIVERY RUN 3 — spec 006 · stage execute');
    expect(prompt).toContain('HEAD `h1`');
    expect(prompt).toContain('RUN_STATUS: awaiting-review');
  });

  it('every account cold → NoWarmAccountError (Temporal retry takes over)', async () => {
    const deps = makeDeps();
    settlePool(deps, cls({ exit: 'rate-limited', rateResetsAt: 9_999 }), 'primary');
    settlePool(deps, cls({ exit: 'rate-limited', rateResetsAt: 9_999 }), 'secondary');
    await expect(createRunnerActivities(deps).runWorkerSession({ specId: '006', run: 2 })).rejects.toThrow(
      NoWarmAccountError,
    );
  });

  it('load-spreading: the next run picks the least-used warm account', async () => {
    const deps = makeDeps();
    const seen: string[] = [];
    deps.provider = {
      id: 'fake',
      createSession: (opts) => {
        seen.push(opts.account.id);
        return { events: fakeEvents, interrupt: async () => undefined };
      },
    } as ProviderAdapter;
    const activities = createRunnerActivities(deps);
    await activities.runWorkerSession({ specId: '006', run: 1 });
    await activities.runWorkerSession({ specId: '006', run: 2 });
    expect(new Set(seen).size).toBe(2); // alternated, not hammered
  });
});
