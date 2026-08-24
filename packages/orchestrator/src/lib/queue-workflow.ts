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

export interface OpenNextInput {
  /** spec ids THIS rotation is already working — the activity never re-opens one of them */
  busy: string[];
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
  /** guard (Q1–Q8) + repair the queue, then return a spec the loop should run next */
  openNextSpec(input: OpenNextInput): Promise<OpenNextResult>;
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
  /**
   * How many specs run CONCURRENTLY — one isolated worktree + one reserved account each.
   * Default 1 (single-writer). Raise it to the number of accounts you can burn at once.
   */
  maxParallelSpecs?: number;
}

export interface QueueRunState {
  status: 'drained' | 'halted' | 'exhausted';
  specRuns: number;
  halts: string[];
  settled: Array<{ specId: string; stage: string; runStatus: SpecRunStatus; queueStatus: string }>;
}

export async function queueRunWorkflow(input: QueueRunInput): Promise<QueueRunState> {
  const state: QueueRunState = { status: 'drained', specRuns: 0, halts: [], settled: [] };
  const maxParallel = Math.max(1, input.maxParallelSpecs ?? 1);

  // In-flight children, one per spec. Filled up to maxParallel, drained by Promise.race —
  // each completion settles and refills, so N accounts stay busy without ever double-
  // working one spec (the activity refuses ids on the busy list).
  const inFlight = new Map<string, Promise<{ specId: string; stage: string; state: SpecRunStatus }>>();
  let halted: string[] | null = null;

  while (state.specRuns < input.maxSpecRuns || inFlight.size > 0) {
    // fill
    while (halted === null && state.specRuns < input.maxSpecRuns && inFlight.size < maxParallel) {
      const opened = await queue.openNextSpec({ busy: [...inFlight.keys()] });
      if (opened.kind === 'halt') {
        // Stop OPENING; children already running finish and settle — a guard halt must
        // never orphan in-flight work.
        halted = opened.violations;
        break;
      }
      if (opened.kind === 'idle') break;
      const { specId, stage } = opened.next;
      if (inFlight.has(specId)) break; // activity contract violation — do not spin
      const child = executeChild(specRunWorkflow, {
        args: [
          {
            specId,
            maxRuns: input.maxRunsPerSpec,
            maxConsecutiveStalls: input.maxConsecutiveStalls,
          },
        ],
        workflowId: `spec-${specId}-${stage}-${state.specRuns}`,
      }).then((result) => ({ specId, stage, state: result.status }));
      inFlight.set(specId, child);
      state.specRuns += 1;
    }

    if (inFlight.size === 0) {
      if (halted) {
        state.status = 'halted';
        state.halts = halted;
        return state;
      }
      state.status = 'drained';
      return state;
    }

    const done = await Promise.race(inFlight.values());
    inFlight.delete(done.specId);
    const settled = await queue.settleSpecOutcome({ specId: done.specId, status: done.state });
    state.settled.push({ specId: done.specId, stage: done.stage, runStatus: done.state, queueStatus: settled.queueStatus });
  }

  if (halted) {
    state.status = 'halted';
    state.halts = halted;
    return state;
  }
  state.status = 'exhausted';
  return state;
}
