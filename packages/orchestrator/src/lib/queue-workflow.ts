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
import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  executeChild,
  isCancellation,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { SpecRunState, SpecRunStatus } from './workflows.js';
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

/** How long an idle rotation sleeps before re-checking the queue — a sign-off recorded at
 * 3am is collected within a minute, not whenever someone restarts the loop. The prototype
 * slept ten minutes here; a minute costs nothing (a durable timer is free while it waits)
 * and the founder's click is answered while they are still looking at the screen. */
const IDLE_RECHECK = '60 seconds';

/** Idle wakes before continue-as-new trims the history (240 × 60s ≈ 4h of pure idling). */
const IDLE_CYCLES_PER_HISTORY_WINDOW = 240;

/** The ONLY way a healthy resident rotation ends — the prototype's STOP file, as a signal.
 * In-flight children finish and settle first; a stop must never orphan live work. */
export const stopRotationSignal = defineSignal('stopRotation');
/** Live rotation state for dashboards, read without touching workflow history. */
export const queueStateQuery = defineQuery<QueueRunState>('queueState');

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
  /**
   * How long an idle rotation sleeps before re-checking, as a Temporal duration string.
   * Defaults to IDLE_RECHECK; overridable so a suite can prove the resident-idle path
   * without waiting a minute of skipped time per wake.
   */
  idleRecheck?: string;
  /** child workflows already run before a continue-as-new — never set by callers */
  carriedSpecRuns?: number;
}

export interface QueueRunState {
  /**
   * 'running'/'idle' are live (query-visible) states; the rest are terminal. There is no
   * 'drained' any more: a rotation with nothing openable IDLES RESIDENT and re-checks —
   * returning here was the gap that lost overnight autonomy (a spec signed off at 3am
   * found no loop to resume).
   */
  status: 'running' | 'idle' | 'halted' | 'exhausted' | 'stopped';
  /** why the rotation is idling, verbatim from openNextSpec — the control room shows it */
  idleReason: string | null;
  specRuns: number;
  halts: string[];
  settled: Array<{ specId: string; stage: string; runStatus: SpecRunStatus; queueStatus: string }>;
}

export async function queueRunWorkflow(input: QueueRunInput): Promise<QueueRunState> {
  const state: QueueRunState = {
    status: 'running',
    idleReason: null,
    specRuns: input.carriedSpecRuns ?? 0,
    halts: [],
    settled: [],
  };

  let stopRequested = false;
  setHandler(stopRotationSignal, () => {
    stopRequested = true;
  });
  setHandler(queueStateQuery, () => state);

  // In-flight children, one per spec. Filled up to maxParallel, drained by Promise.race —
  // each completion settles and refills, so N accounts stay busy without ever double-
  // working one spec (the activity refuses ids on the busy list).
  const maxParallel = Math.max(1, input.maxParallelSpecs ?? 1);
  const inFlight = new Map<string, Promise<{ specId: string; stage: string; result: SpecRunState }>>();
  let halted: string[] | null = null;
  let idleCycles = 0;

  while (state.specRuns < input.maxSpecRuns || inFlight.size > 0) {
    // fill — but never past a stop request or a halt: children already running finish
    // and settle; nothing new opens.
    while (halted === null && !stopRequested && state.specRuns < input.maxSpecRuns && inFlight.size < maxParallel) {
      const opened = await queue.openNextSpec({ busy: [...inFlight.keys()] });
      if (opened.kind === 'halt') {
        halted = opened.violations;
        break;
      }
      if (opened.kind === 'idle') {
        state.idleReason = opened.reason;
        break;
      }
      state.idleReason = null;
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
      }).then((result) => ({ specId, stage, result }));
      inFlight.set(specId, child);
      state.specRuns += 1;
    }

    if (inFlight.size === 0) {
      if (halted) {
        state.status = 'halted';
        state.halts = halted;
        return state;
      }
      if (stopRequested) {
        state.status = 'stopped';
        return state;
      }
      if (state.specRuns >= input.maxSpecRuns) break; // the backstop below names it

      // IDLE RESIDENT. Nothing is openable — review backlog at cap, or nothing pending —
      // so sleep a durable timer and re-check. openNextSpec promotes signed-off entries
      // on every call, which is what lets a founder sign-off (at any hour) free a review
      // slot and resume the machine with nobody at the keyboard. The prototype did this
      // with a 10-minute STOP-aware sleep loop (driver.mjs:1057-1062).
      state.status = 'idle';
      idleCycles += 1;
      try {
        await condition(() => stopRequested, input.idleRecheck ?? IDLE_RECHECK);
      } catch (err) {
        // `spicyspec-runner halt` cancels this workflow, and its own message promises "the
        // current run finishes, then the rotation ends". Reaching here means nothing is in
        // flight, so a cancellation IS that graceful ending — swallow it and return a
        // clean 'stopped' instead of leaving a CANCELLED rotation in the history for a
        // founder to interpret. Nothing cancellable may be awaited after this point.
        if (!isCancellation(err)) throw err;
        state.status = 'stopped';
        return state;
      }
      if (stopRequested) {
        state.status = 'stopped';
        return state;
      }
      if (idleCycles >= IDLE_CYCLES_PER_HISTORY_WINDOW) {
        // Bound the history a long-idling rotation accumulates. Settled records are
        // dropped with the history — the store's queue and run rows are the durable
        // record; this list is a live-query convenience only.
        await continueAsNew<typeof queueRunWorkflow>({ ...input, carriedSpecRuns: state.specRuns });
      }
      continue;
    }

    state.status = 'running';
    const done = await Promise.race(inFlight.values());
    inFlight.delete(done.specId);
    const settled = await queue.settleSpecOutcome({ specId: done.specId, status: done.result.status });
    state.settled.push({ specId: done.specId, stage: done.stage, runStatus: done.result.status, queueStatus: settled.queueStatus });

    // A stall-park HALTS the rotation — the prototype's rule (driver.mjs:617-638):
    // repeated stalls are an environmental symptom a human should see, and marching on
    // to the next spec feeds the same broken environment the rest of the catalog.
    if (done.result.parkedFor === 'stalls' && halted === null) {
      halted = [
        `stall-park: spec ${done.specId} parked after consecutive non-progressing runs — ` +
          'an environmental symptom, not a verdict on the work; read its last two run directories before re-queueing',
      ];
    }
  }

  if (halted) {
    state.status = 'halted';
    state.halts = halted;
    return state;
  }
  state.status = 'exhausted';
  return state;
}
