/**
 * Rotation smoke on the real time-skipping Temporal server: queue activities are mocked,
 * specRunWorkflow runs as a REAL child workflow.
 *
 * The rotation is RESIDENT. There is no 'drained' terminal state any more: nothing openable
 * means idle-and-re-check, because the founder's whole bargain is "the machine stays busy
 * and resumes when I sign off" — and a workflow that returned on idle needed a human to
 * restart it, which is the one thing nobody is awake to do at 3am.
 *
 * Two mechanics of this suite are load-bearing, both learned by hanging it:
 *   * every case gets its OWN task queue. A case that times out leaves its worker holding
 *     the shared queue, and every later Worker.create then fails on an overlapping-worker
 *     registration — one real failure reported as three.
 *   * client polling YIELDS between queries. The time-skipping server only advances its
 *     clock while nothing is pending, so a tight query loop pins it at t0 and the idle
 *     timer never fires.
 */
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SpecRunActivities } from './activities.js';
import type { OpenNextResult, QueueActivities, QueueRunState, SettleInput } from './queue-workflow.js';
import { queueRunWorkflow, queueStateQuery, stopRotationSignal } from './queue-workflow.js';

const workflowsPath = fileURLToPath(new URL('./workflows-entry.ts', import.meta.url));

let env: TestWorkflowEnvironment;
let queueSeq = 0;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 180_000);

afterAll(async () => {
  await env?.teardown();
});

const OUTCOME = (exit: string, progressed = true) =>
  ({ exit, costUsd: 1, costKnown: true, commits: progressed, tasksClosed: progressed ? 1 : 0, progressed }) as never;

/** idleRecheck is tiny here so a resident idle cycles in test time, not in wall minutes. */
const ARGS = { maxRunsPerSpec: 3, maxConsecutiveStalls: 2, maxSpecRuns: 5, idleRecheck: '1 second' };

type Live = {
  query: (q: typeof queueStateQuery) => Promise<QueueRunState>;
  signal: (s: typeof stopRotationSignal) => Promise<void>;
};

interface Script {
  opens: OpenNextResult[];
  runExit?: string;
  progressed?: boolean;
}

async function runRotation(
  script: Script,
  args: Record<string, unknown> = ARGS,
  during?: (handle: Live) => Promise<void>,
) {
  let openCall = 0;
  const settled: SettleInput[] = [];
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
      return OUTCOME(script.runExit ?? 'spec-complete', script.progressed ?? true);
    },
    async checkReviewDecision() {
      return null;
    },
  };
  queueSeq += 1;
  const taskQueue = `spicyspec-queue-test-${queueSeq}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath, activities });
  const state = await worker.runUntil(async () => {
    const handle = await env.client.workflow.start(queueRunWorkflow, {
      taskQueue,
      workflowId: `q-${taskQueue}-${Date.now()}`,
      args: [args as never],
    });
    await during?.(handle as never);
    return handle.result();
  });
  return { state, settled };
}

/** Poll the live query until `ready`, yielding between attempts so the clock can skip. */
async function waitUntil(handle: Live, ready: (s: QueueRunState) => boolean) {
  for (let i = 0; i < 600; i += 1) {
    if (ready(await handle.query(queueStateQuery))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the rotation never reached the awaited state');
}

async function stopWhen(handle: Live, ready: (s: QueueRunState) => boolean) {
  await waitUntil(handle, ready);
  await handle.signal(stopRotationSignal);
}

const whenIdle = (h: Live) => stopWhen(h, (s) => s.status === 'idle');

describe('queueRunWorkflow on a real Temporal test server', () => {
  it('opens, runs the child, settles — then IDLES RESIDENT rather than returning', async () => {
    // CONTRACT CHANGE: this asserted status 'drained' and a returned workflow. Returning on
    // idle is exactly what lost overnight autonomy — the rotation now sleeps a durable timer
    // and re-checks, and only an explicit stop ends it.
    const { state, settled } = await runRotation(
      {
        opens: [
          { kind: 'next', next: { specId: '001', stage: 'specify' } },
          { kind: 'next', next: { specId: '001', stage: 'plan' } },
          { kind: 'idle', reason: 'the review backlog is at its cap — a human unblocks it' },
        ],
      },
      ARGS,
      whenIdle,
    );
    expect(state.status).toBe('stopped');
    expect(state.idleReason).toContain('review backlog');
    expect(state.specRuns).toBe(2);
    expect(state.settled.map((s) => s.stage)).toEqual(['specify', 'plan']);
    expect(settled).toHaveLength(2);
    expect(settled.every((s) => s.status === 'complete')).toBe(true);
  }, 120_000);

  it('an idling rotation picks up work that appears while it sleeps — the 3am sign-off case', async () => {
    // The whole point of the resident idle: openNextSpec is re-invoked on every wake, so a
    // founder sign-off (which frees a review slot inside that activity) resumes the machine
    // with nobody at the keyboard.
    const { state, settled } = await runRotation(
      {
        opens: [
          { kind: 'idle', reason: 'the review backlog is at its cap — a human unblocks it' },
          { kind: 'idle', reason: 'the review backlog is at its cap — a human unblocks it' },
          // the sign-off landed; the slot is free and the next spec opens
          { kind: 'next', next: { specId: '002', stage: 'specify' } },
          { kind: 'idle', reason: 'nothing pending — catalog drained or parked' },
        ],
      },
      ARGS,
      (h) => stopWhen(h, (s) => s.settled.length >= 1),
    );
    expect(settled.map((s) => s.specId)).toEqual(['002']);
    expect(state.specRuns).toBe(1);
  }, 120_000);

  it('`runner halt` (a Temporal cancellation) while idling ends the rotation CLEANLY', async () => {
    // The halt command promises "the current run finishes, then the rotation ends". A
    // resident idle turns cancellation into the only thing waiting, so an uncaught
    // CancelledFailure would leave a CANCELLED rotation in the history for a founder to
    // interpret instead of a stopped one.
    const { state } = await runRotation(
      { opens: [{ kind: 'idle', reason: 'nothing pending — catalog drained or parked' }] },
      ARGS,
      async (handle) => {
        await waitUntil(handle, (s) => s.status === 'idle');
        await (handle as unknown as { cancel: () => Promise<void> }).cancel();
      },
    );
    expect(state.status).toBe('stopped');
    expect(state.specRuns).toBe(0);
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

  it('a stall-park HALTS the rotation instead of marching into the next spec', async () => {
    // Prototype rule (driver.mjs:617-638): repeated stalls are an ENVIRONMENTAL symptom, so
    // feeding the same broken environment the rest of the catalog is the wrong response.
    // The rotation used to settle the park and open the next entry.
    const { state } = await runRotation(
      { opens: [{ kind: 'next', next: { specId: '001', stage: 'execute' } }], runExit: 'no-progress', progressed: false },
      ARGS,
    );
    expect(state.status).toBe('halted');
    expect(state.halts[0]).toContain('stall-park');
    expect(state.halts[0]).toContain('001');
    expect(state.specRuns).toBe(1);
  }, 120_000);
});

describe('parallel rotation', () => {
  it('runs up to maxParallelSpecs children concurrently and settles each', async () => {
    const opened: string[][] = [];
    const pendingIds = ['009', '010', '011', '012'];
    let next = 0;
    const activities: QueueActivities & SpecRunActivities = {
      async openNextSpec(input) {
        opened.push([...input.busy]);
        if (next >= pendingIds.length) return { kind: 'idle', reason: 'nothing pending — catalog drained or parked' };
        const specId = pendingIds[next];
        next += 1;
        return { kind: 'next', next: { specId, stage: 'execute' } };
      },
      async settleSpecOutcome() {
        return { queueStatus: 'awaiting-review', nextStage: null };
      },
      async runWorkerSession() {
        // spec-complete, NOT awaiting-review: a review park costs the child a 30-second
        // durable condition per run, and the client polling this suite would need to hold
        // the time-skipping server still for all of them — 4 children × 3 runs of REAL
        // waiting. The rotation's fill/drain is what this case is about.
        return OUTCOME('spec-complete');
      },
      async checkReviewDecision() {
        return null;
      },
    };
    queueSeq += 1;
    const taskQueue = `spicyspec-queue-test-${queueSeq}`;
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath, activities });
    // maxSpecRuns 4 ends the rotation on its own backstop once all four have run, so this
    // case needs no client polling at all.
    const state = await worker.runUntil(
      env.client.workflow.execute(queueRunWorkflow, {
        taskQueue,
        workflowId: `qp-${taskQueue}-${Date.now()}`,
        args: [{ maxRunsPerSpec: 3, maxConsecutiveStalls: 2, maxSpecRuns: 4, maxParallelSpecs: 3, idleRecheck: '1 second' }],
      }),
    );
    expect(state.status).toBe('exhausted');
    expect(state.settled.map((s) => s.specId).sort()).toEqual(['009', '010', '011', '012']);
    // the fill loop reported growing busy lists — proof children overlapped
    expect(opened.some((b) => b.length >= 2)).toBe(true);
  }, 120_000);
});
