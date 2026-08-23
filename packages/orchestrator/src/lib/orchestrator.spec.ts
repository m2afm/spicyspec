/**
 * Temporal smoke suite — proves durable execution works on this machine end to end:
 * the workflow runs in a real (time-skipping) Temporal test server, activities are mocked,
 * signals and queries behave, and the stall/review/backstop rules hold.
 *
 * First run downloads the test-server binary; CI caches it.
 */
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
      return { exit, costUsd: 1, costKnown: true, commits: exit === 'clean', tasksClosed: exit === 'clean' ? 1 : 0 };
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

  it('B29 discipline: infra exits never count toward the stall limit', async () => {
    const state = await runScripted(['no-progress', 'account-refused', 'rate-limited', 'no-progress']);
    // two no-progress separated by infra exits still reach the limit — but the infra
    // exits themselves added nothing.
    expect(state.status).toBe('parked');
    expect(state.runs).toBe(4);
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
