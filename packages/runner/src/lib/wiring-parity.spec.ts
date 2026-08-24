/**
 * Parity suite for the surfaces the control room reads and nothing else writes: the
 * persisted run row, the operator kill reaching a live session, and one review decision
 * being spent exactly once across both of its consumers.
 *
 * Fixtures are local on purpose — each defect below is about what a REAL run persists, so
 * these tests drive createRunnerActivities end to end rather than asserting on a helper.
 */
import { recordReviewDecision } from '@spicyspec/control-plane';
import type { ProviderAdapter, WorkerEvent } from '@spicyspec/provider';
import { openStore } from '@spicyspec/store';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRunnerConfig } from './config.js';
import { KILL_FLAG_KEY, STOP_FLAG_KEY } from './control-flags.js';
import { createQueueActivities, type QueueEvidenceFns } from './queue-activities.js';
import { REVIEW_CONSUMED_KEY } from './review-consumption.js';
import { createRunnerActivities, durationMinutesFor, type RunnerDeps } from './wiring.js';

const idleProvider = (): ProviderAdapter =>
  ({
    id: 'fake',
    createSession: () => ({
      events: async function* (): AsyncGenerator<WorkerEvent> {
        yield { type: 'tool_use', id: '1', name: 'Bash', input: {}, parentToolUseId: null };
        yield { type: 'result', envelope: { total_cost_usd: 1, num_turns: 2, result: 'RUN_STATUS: continuing' } };
      },
      interrupt: async () => undefined,
    }),
  }) as ProviderAdapter;

function makeDeps(over: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    config: parseRunnerConfig({ projectName: 'Acme', repoCwd: '/repo', accounts: [{ id: 'primary' }] }),
    store: openStore(':memory:'),
    provider: idleProvider(),
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

/* ------------------------------------------------------------------- the run row ---- */

/** Reports a real envelope, a rate-limit event, and a write that leaves a red-first break —
 * so every field asserted below has a value that a zero could not be mistaken for. */
const workingProvider = (): ProviderAdapter =>
  ({
    id: 'fake',
    createSession: () => ({
      events: async function* (): AsyncGenerator<WorkerEvent> {
        yield {
          type: 'tool_use',
          id: '1',
          name: 'Write',
          input: { file_path: 'src/app/guard.ts', content: 'if (false && check()) { return; }' },
          parentToolUseId: null,
        };
        yield {
          type: 'rate_limit',
          info: { status: 'allowed_warning', resetsAt: 4_000, utilization: 0.91, rateLimitType: 'five_hour' },
        };
        yield { type: 'result', envelope: { total_cost_usd: 3, num_turns: 9, result: 'RUN_STATUS: continuing' } };
      },
      interrupt: async () => undefined,
    }),
  }) as ProviderAdapter;

describe('the persisted run row — the control room has NO other source for these numbers', () => {
  it('carries duration, head, startedAt, the rate facts and the red-first residue', async () => {
    // All five were omitted, so the founder saw zero minutes, no HEAD, no start time, empty
    // rate/utilization/window chips and a permanent '—' in the redFirst column, however
    // much the run actually did.
    const deps = makeDeps({ provider: workingProvider() });
    let calls = 0;
    deps.snapshotFn = async () => ({
      git: { head: calls++ === 0 ? 'before-head' : 'after-head', dirty: false, branch: 'main', headSubject: 's', dirtyPaths: [] },
      tasks: { exists: true, done: 1, open: 2, nextTaskIds: ['T002'] },
      handoff: { mtimeMs: 1 },
    });

    await createRunnerActivities(deps).runWorkerSession({ specId: '006', run: 5 });
    const [row] = await deps.store.listRuns();

    expect(row.durationMinutes).toBe(durationMinutesFor(9));
    expect(row.head).toBe('after-head');
    expect(Number.isNaN(Date.parse(String(row.startedAt)))).toBe(false);
    expect(row['rateStatus']).toBe('allowed_warning');
    expect(row['utilization']).toBe(0.91);
    expect(row['rateResetsAt']).toBe(4_000);
    expect(row['redFirstResidue']).toEqual([{ file: 'src/app/guard.ts', marker: expect.stringContaining('false') }]);
  });

  it('a clean run records an EMPTY residue list — an absent field would read as unknown, not clean', async () => {
    const deps = makeDeps();
    await createRunnerActivities(deps).runWorkerSession({ specId: '006', run: 1 });
    expect((await deps.store.listRuns())[0]['redFirstResidue']).toEqual([]);
  });

  it('the run row and the compat LEDGER row state the SAME duration', async () => {
    // Computed independently on two surfaces, so the control room's minutes total and the
    // original room's could disagree about one run.
    const repoCwd = mkdtempSync(join(tmpdir(), 'spicyspec-compat-'));
    const deps = makeDeps({
      provider: workingProvider(),
      config: parseRunnerConfig({
        projectName: 'Acme',
        repoCwd,
        compatLoopDir: '.specify/loop',
        accounts: [{ id: 'primary' }],
      }),
    });
    await createRunnerActivities(deps).runWorkerSession({ specId: '006', run: 1 });

    const [row] = await deps.store.listRuns();
    const compat = JSON.parse(readFileSync(join(repoCwd, '.specify/loop/LEDGER.jsonl'), 'utf8').trim()) as Record<string, unknown>;
    expect(compat['durationMinutes']).toBe(row.durationMinutes);
    expect(compat['head']).toBe('h1');
    // The ORIGINAL room derives its window chip from this field (ui/server.mjs:619).
    expect(compat['rateResetsAt']).toBe(4_000);
  });
});

/* ------------------------------------------------------------------ operator kill ---- */

describe('the control room KILL reaches the LIVE session, not only the process tree', () => {
  /** Emits, then waits — the only session shape in which a watchdog poll can win. */
  const pausingProvider = (): ProviderAdapter => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      id: 'fake',
      createSession: () => ({
        events: async function* (): AsyncGenerator<WorkerEvent> {
          yield { type: 'tool_use', id: '1', name: 'Bash', input: {}, parentToolUseId: null };
          await gate;
          yield { type: 'result', envelope: { total_cost_usd: 1, num_turns: 6, result: '' } };
        },
        interrupt: async () => release(),
      }),
    } as ProviderAdapter;
  };

  const fastPoll = (provider: ProviderAdapter) =>
    makeDeps({
      provider,
      config: parseRunnerConfig({
        projectName: 'Acme',
        repoCwd: '/repo',
        accounts: [{ id: 'primary' }],
        watchdog: { pollSeconds: 0.01 },
      }),
    });

  it('runner:kill-now already armed spends NOTHING — no session, no account use, no ledger row', async () => {
    // The flag stays armed until the operator clears it, so a rotation that spawns a
    // session per iteration bills one real session per iteration for a single button
    // press. A pre-flight abort is not a tick: the original never opened one either, so
    // there is no cost, no account use and no ledger row to record.
    const deps = fastPoll(pausingProvider());
    await deps.store.setKv(KILL_FLAG_KEY, JSON.stringify({ armedAt: '2026-08-24T03:00:00Z' }));
    const outcome = await createRunnerActivities(deps).runWorkerSession({ specId: '006', run: 1 });
    expect(outcome.exit).toBe('aborted');
    expect(outcome.costUsd).toBe(0);
    expect(await deps.store.listRuns()).toEqual([]);
    expect(await deps.store.getKv('account:lease:primary')).toBeNull();
  });

  it('runner:kill-now armed MID-run interrupts the live session and records the ABORTED row', async () => {
    // killRequested was declared and polled but supplied by nobody, so the room's KILL could
    // only hard-kill the runner tree — which produces no classified run at all, and
    // `aborted` (an operator kill, never a worker failure, B15) was unreachable.
    const deps = fastPoll(pausingProvider());
    const armAfterStart = deps.store.getKv.bind(deps.store);
    let seen = 0;
    deps.store.getKv = async (key: string) => {
      // The first poll finds nothing (the run is healthy and underway); the operator then
      // presses KILL, which is what the watchdog must catch.
      if (key === KILL_FLAG_KEY) {
        seen += 1;
        if (seen === 1) return null;
        return JSON.stringify({ armedAt: '2026-08-24T03:00:00Z' });
      }
      return armAfterStart(key);
    };
    const outcome = await createRunnerActivities(deps).runWorkerSession({ specId: '006', run: 1 });
    expect(outcome.exit).toBe('aborted');
    expect((await deps.store.listRuns())[0].exit).toBe('aborted');
  });

  it('nothing armed never aborts a healthy run', async () => {
    const deps = fastPoll(idleProvider());
    expect((await createRunnerActivities(deps).runWorkerSession({ specId: '006', run: 1 })).exit).not.toBe('aborted');
  });

  it('a graceful STOP is not a kill — it never touches the live session', async () => {
    const deps = fastPoll(idleProvider());
    await deps.store.setKv(STOP_FLAG_KEY, JSON.stringify({ armedAt: '2026-08-24T03:00:00Z' }));
    expect((await createRunnerActivities(deps).runWorkerSession({ specId: '006', run: 1 })).exit).not.toBe('aborted');
  });
});

/* --------------------------------------------------------- one decision, one spend ---- */

describe('a recorded review decision is consumed ONCE across BOTH consumers', () => {
  const evidence = (signedOff = false): QueueEvidenceFns => ({
    specDirExists: () => true,
    commitsFor: () => 5,
    signedOff: () => signedOff,
  });
  const awaiting = () => ({ entries: [{ id: '006', status: 'awaiting-review' as const, stage: 'handoff' }] });
  const approval = (at: string) => ({ specId: '006', approved: true, note: 'walked', by: 'founder', at });

  it('the workflow bridge spending a decision stops the rotation crediting it again', async () => {
    // Two markers, two consumers, neither able to see the other's consumption.
    const deps = makeDeps();
    await deps.store.saveQueue(awaiting());
    await recordReviewDecision(deps.store, approval('2026-08-24T01:00:00Z'));

    expect(await createRunnerActivities(deps).checkReviewDecision({ specId: '006' })).toMatchObject({ approved: true });

    await createQueueActivities({ runner: deps, evidenceFn: async () => evidence() }).openNextSpec({ busy: [] });
    expect((await deps.store.loadQueue()).entries[0].status).toBe('awaiting-review');
  });

  it('the rotation crediting a decision stops the bridge delivering it again', async () => {
    const deps = makeDeps();
    await deps.store.saveQueue(awaiting());
    await recordReviewDecision(deps.store, approval('2026-08-24T01:00:00Z'));

    await createQueueActivities({ runner: deps, evidenceFn: async () => evidence() }).openNextSpec({ busy: [] });
    expect((await deps.store.loadQueue()).entries[0].status).toBe('done');
    expect(await createRunnerActivities(deps).checkReviewDecision({ specId: '006' })).toBeNull();
  });

  it('a months-later re-queue is NEVER auto-approved by the old decision', async () => {
    const deps = makeDeps();
    await deps.store.saveQueue(awaiting());
    await recordReviewDecision(deps.store, approval('2026-08-24T01:00:00Z'));
    const rotation = createQueueActivities({ runner: deps, evidenceFn: async () => evidence() });
    await rotation.openNextSpec({ busy: [] });

    // the founder re-queues it by hand, months on, with the same decision still on record
    await deps.store.saveQueue(awaiting());
    await rotation.openNextSpec({ busy: [] });
    expect((await deps.store.loadQueue()).entries[0].status).toBe('awaiting-review');
  });

  it('the git-TAG promotion spends the recorded decision too', async () => {
    // The room's sign-off writes BOTH the tag and the decision. Credited by the tag, the
    // decision was left unspent — still live evidence for a future re-queue.
    const deps = makeDeps();
    await deps.store.saveQueue(awaiting());
    await recordReviewDecision(deps.store, approval('2026-08-24T01:00:00Z'));

    await createQueueActivities({ runner: deps, evidenceFn: async () => evidence(true) }).openNextSpec({ busy: [] });
    expect((await deps.store.loadQueue()).entries[0].status).toBe('done');
    expect(await deps.store.getKv(REVIEW_CONSUMED_KEY('006'))).toBe('2026-08-24T01:00:00Z');

    await deps.store.saveQueue(awaiting());
    expect(await createRunnerActivities(deps).checkReviewDecision({ specId: '006' })).toBeNull();
  });

  it('a NEW decision (different timestamp) is a new decision for both consumers', async () => {
    const deps = makeDeps();
    await deps.store.saveQueue(awaiting());
    await recordReviewDecision(deps.store, { specId: '006', approved: false, note: 'regression', by: 'founder', at: '2026-08-24T01:00:00Z' });
    expect(await createRunnerActivities(deps).checkReviewDecision({ specId: '006' })).toMatchObject({ approved: false });

    await recordReviewDecision(deps.store, approval('2026-08-24T05:00:00Z'));
    await createQueueActivities({ runner: deps, evidenceFn: async () => evidence() }).openNextSpec({ busy: [] });
    expect((await deps.store.loadQueue()).entries[0].status).toBe('done');
  });

  it('a decision an older build already delivered is not consumed a second time on upgrade', async () => {
    const deps = makeDeps();
    await deps.store.saveQueue(awaiting());
    await recordReviewDecision(deps.store, approval('2026-08-24T01:00:00Z'));
    await deps.store.setKv('review:delivered:006', '2026-08-24T01:00:00Z');
    expect(await createRunnerActivities(deps).checkReviewDecision({ specId: '006' })).toBeNull();
  });
});

describe('the review decision survives a crash between crediting and spending', () => {
  it('the entry is committed done BEFORE the decision is spent — an approval is never lost', async () => {
    const deps = makeDeps({ config: parseRunnerConfig({ projectName: 'Acme', repoCwd: '/repo', accounts: [{ id: 'primary' }] }) });
    await deps.store.saveQueue({ entries: [{ id: '007', status: 'awaiting-review' as const, stage: 'handoff' }] });
    await recordReviewDecision(deps.store, { specId: '007', approved: true, note: 'walked', by: 'founder', at: '2026-08-24T03:00:00Z' });

    // Fail every write AFTER the queue commit: the decision must stay unspent, so the next
    // rotation still credits the entry rather than losing the founder's approval.
    const realSet = deps.store.setKv.bind(deps.store);
    let committed = false;
    deps.store.setKv = async (k: string, v: string) => {
      if (committed && k.startsWith('review:consumed:')) throw new Error('crash');
      return realSet(k, v);
    };
    const realSave = deps.store.saveQueue.bind(deps.store);
    deps.store.saveQueue = async (q) => {
      const r = await realSave(q);
      committed = true;
      return r;
    };

    const activities = createQueueActivities({ runner: deps, evidenceFn: async () => ({ specDirExists: () => true, commitsFor: () => 3, signedOff: () => false }) });
    await activities.openNextSpec({ busy: [] });
    const q = await deps.store.loadQueue();
    expect(q.entries.find((e) => e.id === '007')?.status).toBe('done');
  });
});
