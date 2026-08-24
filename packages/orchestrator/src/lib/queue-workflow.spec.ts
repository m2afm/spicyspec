/**
 * Rotation smoke on the real time-skipping Temporal server: queue activities are mocked,
 * specRunWorkflow runs as a REAL child workflow.
 */
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SpecRunActivities } from './activities.js';
import type { OpenNextResult, QueueActivities, SettleInput } from './queue-workflow.js';
import { queueRunWorkflow } from './queue-workflow.js';

const TASK_QUEUE = 'spicyspec-queue-test';
const workflowsPath = fileURLToPath(new URL('./workflows-entry.ts', import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 180_000);

afterAll(async () => {
  await env?.teardown();
});

interface Script {
  opens: OpenNextResult[];
  runExit?: string;
}

async function runRotation(script: Script) {
  let openCall = 0;
  const settled: SettleInput[] = [];
  // one spec entry advancing specify → plan → done, expressed as scripted opens
  const activities: QueueActivities & SpecRunActivities = {
    async openNextSpec() {
      const r = script.opens[Math.min(openCall, script.opens.length - 1)];
      openCall += 1;
      return r;
    },
    async settleSpecOutcome(input) {
      settled.push(input);
      return { queueStatus: 'active', nextStage: null };
    },
    async runWorkerSession() {
      return { exit: (script.runExit ?? 'spec-complete') as never, costUsd: 1, costKnown: true, commits: true, tasksClosed: 1 };
    },
    async checkReviewDecision() {
      return null;
    },
  };
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath,
    activities,
  });
  const state = await worker.runUntil(
    env.client.workflow.execute(queueRunWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: `q-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      args: [{ maxRunsPerSpec: 3, maxConsecutiveStalls: 2, maxSpecRuns: 5 }],
    }),
  );
  return { state, settled };
}

describe('queueRunWorkflow on a real Temporal test server', () => {
  it('opens, runs the child, settles, and drains', async () => {
    const { state, settled } = await runRotation({
      opens: [
        { kind: 'next', next: { specId: '001', stage: 'specify' } },
        { kind: 'next', next: { specId: '001', stage: 'plan' } },
        { kind: 'idle', reason: 'drained' },
      ],
    });
    expect(state.status).toBe('drained');
    expect(state.specRuns).toBe(2);
    expect(state.settled.map((s) => s.stage)).toEqual(['specify', 'plan']);
    expect(settled).toHaveLength(2);
    expect(settled.every((s) => s.status === 'complete')).toBe(true);
  }, 120_000);

  it('a queue-guard halt STOPS the rotation — never runs against unreasonable state', async () => {
    const { state } = await runRotation({
      opens: [{ kind: 'halt', violations: ['Q3 [001,002] 2 entries are active at once'] }],
    });
    expect(state.status).toBe('halted');
    expect(state.halts[0]).toContain('Q3');
    expect(state.specRuns).toBe(0);
  }, 120_000);

  it('maxSpecRuns is a hard backstop', async () => {
    const { state } = await runRotation({
      opens: [{ kind: 'next', next: { specId: '001', stage: 'execute' } }],
    });
    expect(state.status).toBe('exhausted');
    expect(state.specRuns).toBe(5);
  }, 120_000);
});
