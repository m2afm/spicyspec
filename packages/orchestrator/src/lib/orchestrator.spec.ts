/**
 * Temporal smoke suite — proves durable execution works on this machine end to end:
 * the workflow runs in a real (time-skipping) Temporal test server, activities are mocked,
 * signals and queries behave, and the stall/review/backstop rules hold.
 *
 * First run downloads the test-server binary; CI caches it.
 */
import { ApplicationFailure } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SpecRunActivities, WorkerRunOutcome } from './activities.js';
import { reviewSignal, specRunWorkflow, stateQuery } from './workflows.js';

const TASK_QUEUE = 'spicyspec-test';
const workflowsPath = fileURLToPath(new URL('./workflows-entry.ts', import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 180_000);

afterAll(async () => {
  await env?.teardown();
});

/** Run one workflow against a scripted sequence of activity outcomes. */
async function runScripted(
  script: WorkerRunOutcome['exit'][],
  input = { specId: '006', maxRuns: 10, maxConsecutiveStalls: 2 },
  during?: (handle: Awaited<ReturnType<typeof env.client.workflow.start>>) => Promise<void>,
) {
  let call = 0;
  const activities: SpecRunActivities = {
    async runWorkerSession() {
      const exit = script[Math.min(call, script.length - 1)];
      call += 1;
      // `progressed` is the stall counter's ONLY input now (prototype rule: progress
      // resets, non-progress increments, regardless of exit class), so the script has to
      // state it rather than let the workflow infer it from a whitelist of exits.
      const progressed = exit === 'clean' || exit === 'spec-complete';
      return { exit, costUsd: 1, costKnown: true, commits: progressed, tasksClosed: progressed ? 1 : 0, progressed };
    },
    async checkReviewDecision() {
      return null; // these cases exercise the SIGNAL path; the bridge has its own suite
    },
  };
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath,
    activities,
  });
  return worker.runUntil(async () => {
    const handle = await env.client.workflow.start(specRunWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: `t-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      args: [input],
    });
    await during?.(handle);
    return handle.result();
  });
}

describe('specRunWorkflow on a real Temporal test server', () => {
  it('clean runs then spec-complete → complete', async () => {
    const state = await runScripted(['clean', 'clean', 'spec-complete']);
    expect(state.status).toBe('complete');
    expect(state.runs).toBe(3);
  }, 120_000);

  it('two consecutive stalls park the spec (prototype maxConsecutiveStalls)', async () => {
    const state = await runScripted(['clean', 'no-progress', 'stalled']);
    expect(state.status).toBe('parked');
    expect(state.stalls).toBe(2);
  }, 120_000);

  it('B29 discipline: infra exits never count toward the stall limit OR the run budget', async () => {
    const state = await runScripted(['no-progress', 'account-refused', 'rate-limited', 'no-progress']);
    // Two no-progress runs separated by infra exits still reach the stall limit.
    expect(state.status).toBe('parked');
    expect(state.parkedFor).toBe('stalls');
    // CONTRACT CHANGE: this asserted runs === 4. Counting an infra attempt as a run is how
    // a night of account cold-cycling walked a healthy spec into the maxRuns backstop and
    // out of the rotation. Two real runs happened; the refusal and the rate limit were
    // retries of run 2 and consumed nothing.
    expect(state.runs).toBe(2);
    expect(state.attempt).toBe(1); // reset by the scored run that followed the retries
  }, 120_000);

  it('an infra retry keeps its run NUMBER and climbs `attempt` instead', async () => {
    const state = await runScripted(['rate-limited', 'rate-limited', 'clean', 'spec-complete']);
    expect(state.status).toBe('complete');
    expect(state.runs).toBe(2); // the two rate-limited attempts were both run 1
  }, 120_000);

  it("`errored` counts as a stall when nothing moved — it used to count as neither", async () => {
    // The old STALL_EXITS whitelist held stalled/no-progress/hung/timed-out, so `errored`
    // fell through as neither forward nor stalling: an infinite-retry shape bounded only by
    // the run budget, which then reported 'exhausted' on a spec that never once progressed.
    const state = await runScripted(['errored', 'errored'], { specId: '010', maxRuns: 10, maxConsecutiveStalls: 2 });
    expect(state.status).toBe('parked');
    expect(state.parkedFor).toBe('stalls');
    expect(state.stalls).toBe(2);
  }, 120_000);

  it('awaiting-review parks durably on a signal; approval resumes; the workflow completes', async () => {
    const state = await runScripted(
      ['awaiting-review', 'spec-complete'],
      { specId: '006', maxRuns: 10, maxConsecutiveStalls: 2 },
      async (handle) => {
        // wait until the workflow reports it is parked on the human
        let status = '';
        while (status !== 'awaiting-review') {
          status = (await handle.query(stateQuery)).status;
        }
        await handle.signal(reviewSignal, { approved: true, note: 'journey walked' });
      },
    );
    expect(state.status).toBe('complete');
  }, 120_000);

  it('a rejected review parks the spec', async () => {
    const state = await runScripted(
      ['awaiting-review'],
      { specId: '007', maxRuns: 10, maxConsecutiveStalls: 2 },
      async (handle) => {
        let status = '';
        while (status !== 'awaiting-review') {
          status = (await handle.query(stateQuery)).status;
        }
        await handle.signal(reviewSignal, { approved: false, note: 'not yet' });
      },
    );
    expect(state.status).toBe('parked');
  }, 120_000);

  it('maxRuns is a hard backstop → exhausted', async () => {
    const state = await runScripted(['clean'], { specId: '008', maxRuns: 3, maxConsecutiveStalls: 2 });
    expect(state.status).toBe('exhausted');
    expect(state.runs).toBe(3);
  }, 120_000);
});

describe('a cold account pool is WAITED OUT, not retried into the ground', () => {
  it('NoWarmAccountError sleeps a durable timer to the earliest reset and re-runs the SAME run number', async () => {
    // The retry policy used to own this: 30s initial, ×2, capped at 15 min, 12 attempts —
    // about two hours, after which the activity failed permanently and the child spec
    // workflow FAILED. A five-hour rate-limit window is a normal overnight event, so the
    // engine's own backoff was killing healthy specs. The failure is nonRetryable now and
    // the workflow sleeps to the reset instead.
    const runs: number[] = [];
    const activities: SpecRunActivities = {
      async runWorkerSession(input) {
        runs.push(input.run);
        if (runs.length === 1) {
          // Thrown the way the runner throws it: type is the identity that survives the
          // activity boundary, details carry [earliestWarmAtMs, thrownAtMs].
          const at = Date.now();
          throw new ApplicationFailure(
            'every account is cold (primary COLD 41m · secondary COLD 41m)',
            'NoWarmAccountError',
            true,
            [at + 41 * 60_000, at],
          );
        }
        return { exit: 'spec-complete', costUsd: 1, costKnown: true, commits: true, tasksClosed: 1, progressed: true };
      },
      async checkReviewDecision() {
        return null;
      },
    };
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: TASK_QUEUE, workflowsPath, activities });
    const state = await worker.runUntil(
      env.client.workflow.execute(specRunWorkflow, {
        taskQueue: TASK_QUEUE,
        workflowId: `cold-${Date.now()}`,
        args: [{ specId: '004', maxRuns: 5, maxConsecutiveStalls: 2 }],
      }),
    );
    expect(state.status).toBe('complete');
    // Waiting out a window consumes no budget: the retry carries the same run number, and
    // only the run that actually worked is counted.
    expect(runs).toEqual([1, 1]);
    expect(state.runs).toBe(1);
  }, 120_000);
});

describe('the review BRIDGE — a dashboard decision reaches a parked workflow with no signal', () => {
  it('polls checkReviewDecision while parked; an approval resumes and completes', async () => {
    let polls = 0;
    const activities: SpecRunActivities = {
      async runWorkerSession() {
        return polls >= 1
          ? { exit: 'spec-complete' as const, costUsd: 1, costKnown: true, commits: true, tasksClosed: 1, progressed: true }
          : { exit: 'awaiting-review' as const, costUsd: 1, costKnown: true, commits: false, tasksClosed: 0, progressed: true };
      },
      async checkReviewDecision() {
        polls += 1;
        // first two polls: the manager has not decided yet
        return polls < 3 ? null : { approved: true, note: 'journey walked on the dashboard', by: 'founder' };
      },
    };
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: TASK_QUEUE, workflowsPath, activities });
    const state = await worker.runUntil(
      env.client.workflow.execute(specRunWorkflow, {
        taskQueue: TASK_QUEUE,
        workflowId: `bridge-${Date.now()}`,
        args: [{ specId: '002', maxRuns: 5, maxConsecutiveStalls: 2 }],
      }),
    );
    expect(state.status).toBe('complete');
    expect(polls).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('a bridged rejection parks the spec', async () => {
    const activities: SpecRunActivities = {
      async runWorkerSession() {
        return { exit: 'awaiting-review' as const, costUsd: 1, costKnown: true, commits: false, tasksClosed: 0, progressed: true };
      },
      async checkReviewDecision() {
        return { approved: false, note: 'not yet' };
      },
    };
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: TASK_QUEUE, workflowsPath, activities });
    const state = await worker.runUntil(
      env.client.workflow.execute(specRunWorkflow, {
        taskQueue: TASK_QUEUE,
        workflowId: `bridge-rej-${Date.now()}`,
        args: [{ specId: '002', maxRuns: 5, maxConsecutiveStalls: 2 }],
      }),
    );
    expect(state.status).toBe('parked');
  }, 120_000);
});
