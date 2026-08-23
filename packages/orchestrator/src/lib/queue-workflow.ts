/**
 * The queue rotation — the workflow above specRunWorkflow that keeps a whole catalog
 * moving: guard the queue, open the next spec, run it stage by stage, settle the outcome,
 * repeat. The durable replacement for the prototype driver's outer loop.
 *
 * Queue mutations live in ACTIVITIES (they touch the store); this file only sequences.
 * The guard rules Q1–Q8 (core queue-guard) run inside openNextSpec — a halting violation
 * comes back as `halt` and this workflow STOPS rather than guesses, exactly as the
 * prototype's driver did (rule: never run against a state the loop cannot reason about).
 */
import { executeChild, proxyActivities } from '@temporalio/workflow';
import type { SpecRunStatus } from './workflows.js';
import { specRunWorkflow } from './workflows.js';

export interface NextSpec {
  specId: string;
  stage: string;
}

export type OpenNextResult =
  | { kind: 'next'; next: NextSpec }
  | { kind: 'idle'; reason: string }
  | { kind: 'halt'; violations: string[] };

export interface SettleInput {
  specId: string;
  status: SpecRunStatus;
}

export interface SettleResult {
  queueStatus: string;
  nextStage: string | null;
}

export interface QueueActivities {
  /** guard (Q1–Q8) + repair the queue, then return the spec the loop should run next */
  openNextSpec(): Promise<OpenNextResult>;
  /** apply a spec-run outcome to the queue: advance the stage, or park/awaiting-review */
  settleSpecOutcome(input: SettleInput): Promise<SettleResult>;
}

const queue = proxyActivities<QueueActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});

export interface QueueRunInput {
  maxRunsPerSpec: number;
  maxConsecutiveStalls: number;
  /** hard backstop on child workflows started by one rotation — a runaway must end */
  maxSpecRuns: number;
}

export interface QueueRunState {
  status: 'drained' | 'halted' | 'exhausted';
  specRuns: number;
  halts: string[];
  settled: Array<{ specId: string; stage: string; runStatus: SpecRunStatus; queueStatus: string }>;
}

export async function queueRunWorkflow(input: QueueRunInput): Promise<QueueRunState> {
  const state: QueueRunState = { status: 'drained', specRuns: 0, halts: [], settled: [] };

  while (state.specRuns < input.maxSpecRuns) {
    const opened = await queue.openNextSpec();

    if (opened.kind === 'halt') {
      state.status = 'halted';
      state.halts = opened.violations;
      return state;
    }
    if (opened.kind === 'idle') {
      // Nothing runnable: catalog drained, or everything is parked/awaiting a human.
      state.status = 'drained';
      return state;
    }

    const child = await executeChild(specRunWorkflow, {
      args: [
        {
          specId: opened.next.specId,
          maxRuns: input.maxRunsPerSpec,
          maxConsecutiveStalls: input.maxConsecutiveStalls,
        },
      ],
      workflowId: `spec-${opened.next.specId}-${opened.next.stage}-${state.specRuns}`,
    });
    state.specRuns += 1;

    const settled = await queue.settleSpecOutcome({ specId: opened.next.specId, status: child.status });
    state.settled.push({
      specId: opened.next.specId,
      stage: opened.next.stage,
      runStatus: child.status,
      queueStatus: settled.queueStatus,
    });
  }

  state.status = 'exhausted';
  return state;
}
