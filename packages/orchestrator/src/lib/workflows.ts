/**
 * The spec-run workflow — Temporal replaces the prototype's hand-rolled driver loop.
 *
 * Everything the prototype implemented by hand and got wrong at least once — watchdogs,
 * stall counters, restart survival, waiting on a human for days — is expressed here as
 * durable-execution primitives: activities with heartbeats, workflow state that survives
 * any process death, and signals for human decisions.
 *
 * DETERMINISM: this file runs inside the Temporal workflow sandbox. No Date.now(), no
 * Math.random(), no I/O — activities do the real work. (The same discipline the prototype
 * enforced for replayable scripts.)
 */
import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type { SpecRunActivities, WorkerRunOutcome } from './activities.js';

export interface SpecRunInput {
  specId: string;
  /** hard backstop on run count — a runaway loop must end (prototype maxTicksPerSpec) */
  maxRuns: number;
  /** consecutive non-progressing runs before the spec parks (prototype maxConsecutiveStalls) */
  maxConsecutiveStalls: number;
}

export type SpecRunStatus =
  | 'running'
  | 'awaiting-review'
  | 'complete'
  | 'parked'
  | 'exhausted';

export interface SpecRunState {
  status: SpecRunStatus;
  runs: number;
  stalls: number;
  lastExit: string | null;
}

export interface ReviewDecision {
  approved: boolean;
  note?: string;
}

/** A human review lands as a signal — the workflow waits for days at zero cost. */
export const reviewSignal = defineSignal<[ReviewDecision]>('review');
/** Live state for dashboards, read without touching workflow history. */
export const stateQuery = defineQuery<SpecRunState>('state');

const activities = proxyActivities<SpecRunActivities>({
  // AI worker sessions legitimately run for hours; the heartbeat is what detects a dead
  // one — the prototype's watchdog killed a healthy 12-minute-silent test run (B6), and
  // heartbeats are the engine-level fix.
  startToCloseTimeout: '4 hours',
  heartbeatTimeout: '20 minutes',
  retry: {
    // Session failures are OUTCOMES, not throws — an activity throw here means
    // infrastructure: no warm account (retry until one frees or warms), a provider 529,
    // a store hiccup. maximumAttempts: 2 killed a healthy re-ignition in seconds when
    // stale leases held all accounts; patience is the durable equivalent of the
    // prototype's sleep-to-earliest-reset, with no loop-of-doom risk since failing
    // SPECS never throw.
    initialInterval: '30 seconds',
    backoffCoefficient: 2,
    maximumInterval: '15 minutes',
    maximumAttempts: 12,
  },
});

/** Exits that mean "the run moved the work forward". */
const FORWARD_EXITS = new Set(['clean', 'spec-complete', 'awaiting-review']);
/** Exits that count toward the stall limit. Infra exits NEVER do (B15/B29 discipline). */
const STALL_EXITS = new Set(['stalled', 'no-progress', 'hung', 'timed-out']);

export async function specRunWorkflow(input: SpecRunInput): Promise<SpecRunState> {
  const state: SpecRunState = { status: 'running', runs: 0, stalls: 0, lastExit: null };

  let pendingDecision: ReviewDecision | null = null;
  setHandler(reviewSignal, (decision) => {
    pendingDecision = decision;
  });
  setHandler(stateQuery, () => state);

  while (state.runs < input.maxRuns) {
    const outcome: WorkerRunOutcome = await activities.runWorkerSession({
      specId: input.specId,
      run: state.runs + 1,
    });
    state.runs += 1;
    state.lastExit = outcome.exit;

    if (outcome.exit === 'spec-complete') {
      state.status = 'complete';
      return state;
    }

    if (outcome.exit === 'awaiting-review') {
      // Park on the human, durably: the workflow survives restarts, reboots, and weeks of
      // silence while it waits — the mechanism whose absence caused 91% of the
      // prototype's idle time. Two ways a decision arrives: the review SIGNAL (anything
      // holding a workflow handle), or the BRIDGE — a manager records approve/reject on
      // the dashboard, the store carries the intent, and this poll collects it. The
      // dashboard needs no workflow id and no Temporal client.
      state.status = 'awaiting-review';
      pendingDecision = null;
      while (pendingDecision === null) {
        const signaled = await condition(() => pendingDecision !== null, '30 seconds');
        if (!signaled) {
          const polled = await activities.checkReviewDecision({ specId: input.specId });
          if (polled) pendingDecision = { approved: polled.approved, note: polled.note };
        }
      }
      const decision = pendingDecision as unknown as ReviewDecision;
      if (!decision.approved) {
        state.status = 'parked';
        return state;
      }
      state.status = 'running';
      state.stalls = 0;
      continue;
    }

    if (STALL_EXITS.has(outcome.exit)) {
      state.stalls += 1;
      if (state.stalls >= input.maxConsecutiveStalls) {
        state.status = 'parked';
        return state;
      }
      continue;
    }

    if (FORWARD_EXITS.has(outcome.exit)) {
      state.stalls = 0;
    }
    // Infra exits (account-refused, rate-limited, aborted, no-attempt) fall through:
    // neither forward nor stall — the run is simply retried on the next iteration.
  }

  state.status = 'exhausted';
  return state;
}
