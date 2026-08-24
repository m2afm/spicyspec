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
import {
  ActivityFailure,
  ApplicationFailure,
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
} from '@temporalio/workflow';
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
  /**
   * Attempt ordinal of the CURRENT run number: 1 on real work, climbing only while infra
   * retries (rate-limited / account-refused / no-attempt) re-run the same number — the
   * prototype's `-a2` suffix, surfaced so a dashboard can tell a real run from a retry.
   */
  attempt: number;
  /** why the spec parked, when it did — the rotation halts on 'stalls', nothing else */
  parkedFor: 'stalls' | 'review-rejected' | 'blocked' | 'infra-retry-cap' | null;
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
  // heartbeats are the engine-level fix. 5h, not 4h: the in-session watchdog's hard
  // backstop (maxRunMinutes 240) must fire FIRST and produce a CLASSIFIED timed-out run;
  // when the two were equal the activity timeout raced it and won as an activity FAILURE
  // the retry policy re-ran.
  startToCloseTimeout: '5 hours',
  heartbeatTimeout: '20 minutes',
  retry: {
    // Session failures are OUTCOMES, not throws — an activity throw here means
    // infrastructure: a provider 529, a store hiccup. maximumAttempts: 2 killed a healthy
    // re-ignition in seconds when stale leases held all accounts. A COLD POOL is not
    // retried here at all: NoWarmAccountError is nonRetryable and the loop below sleeps a
    // durable timer to the earliest reset — hot-retrying a 5-hour window burned the whole
    // attempt budget in ~2h and then FAILED the spec on a normal overnight rate limit.
    initialInterval: '30 seconds',
    backoffCoefficient: 2,
    maximumInterval: '15 minutes',
    maximumAttempts: 12,
  },
});

/**
 * Infra exits: the account, not the work. Retried under the SAME run number with a retry
 * identity, never a stall, never budget — the prototype's rule (driver.mjs:804-877),
 * because a night of account cold-cycling once pushed a healthy spec toward the run
 * backstop and 'exhausted' is one step from parked.
 */
const INFRA_EXITS = new Set(['rate-limited', 'account-refused', 'no-attempt']);

/**
 * Backstop for a truly wedged pool (every retry refused, forever). The prototype had no
 * cap — its refusals marked accounts cold so the sleep-to-reset path took over — but a
 * loop with no exit is a defect class of its own, so past this many consecutive infra
 * retries the spec parks with a diagnosis instead of spinning.
 */
const MAX_CONSECUTIVE_INFRA_RETRIES = 20;

/** Extract the cold-pool wait from a NoWarmAccountError, or null if this is any other failure. */
function coldPoolWaitMs(err: unknown): number | null {
  const cause = err instanceof ActivityFailure ? err.cause : err;
  if (!(cause instanceof ApplicationFailure) || cause.type !== 'NoWarmAccountError') return null;
  const [earliestWarmAtMs, thrownAtMs] = (cause.details ?? []) as [number | null, number | null];
  if (typeof earliestWarmAtMs !== 'number' || typeof thrownAtMs !== 'number') {
    // No reset time on record (empty pool state) — the prototype's fixed cooldown.
    return 15 * 60_000;
  }
  // +60s buffer past the reset, and never a hot spin when the reset is already past
  // (every warm account leased by a concurrent session reports earliestWarmAtMs ≤ now).
  return Math.max(60_000, earliestWarmAtMs - thrownAtMs + 60_000);
}

export async function specRunWorkflow(input: SpecRunInput): Promise<SpecRunState> {
  const state: SpecRunState = { status: 'running', runs: 0, stalls: 0, lastExit: null, attempt: 1, parkedFor: null };

  let pendingDecision: ReviewDecision | null = null;
  setHandler(reviewSignal, (decision) => {
    pendingDecision = decision;
  });
  setHandler(stateQuery, () => state);

  let infraRetries = 0;

  while (state.runs < input.maxRuns) {
    let outcome: WorkerRunOutcome;
    try {
      outcome = await activities.runWorkerSession({
        specId: input.specId,
        run: state.runs + 1,
      });
    } catch (err) {
      const waitMs = coldPoolWaitMs(err);
      if (waitMs !== null) {
        // Every account is cold: sleep a durable Temporal timer to the earliest reset —
        // the prototype's sleepUntil (driver.mjs:743-749), free while it waits, and
        // unbounded on purpose: a 5-hour or 7-day window is simply waited out.
        await sleep(waitMs);
        continue; // same run number — waiting out a window consumes no budget
      }
      throw err;
    }
    state.lastExit = outcome.exit;

    if (INFRA_EXITS.has(outcome.exit)) {
      infraRetries += 1;
      if (infraRetries >= MAX_CONSECUTIVE_INFRA_RETRIES) {
        state.status = 'parked';
        state.parkedFor = 'infra-retry-cap';
        return state;
      }
      state.attempt += 1;
      continue; // same run number, no budget consumed, never a stall
    }
    infraRetries = 0;
    state.attempt = 1;
    state.runs += 1;

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
        state.parkedFor = 'review-rejected';
        return state;
      }
      state.status = 'running';
      state.stalls = 0;
      continue;
    }

    if (outcome.exit === 'blocked') {
      // The worker declared a wall a retry cannot climb (permission grant, human-only
      // decision). Park NOW with the declaration intact — burning stall-limit runs on a
      // known wall is pure quota loss.
      state.status = 'parked';
      state.parkedFor = 'blocked';
      return state;
    }

    if (outcome.exit === 'aborted') {
      // An operator kill is not a worker outcome and must never be scored as one (B15) —
      // so no stall. It DOES consume its run, unlike an infra retry: the kill flag lives
      // outside this workflow, so a non-scoring abort would re-dispatch instantly and spin
      // for as long as the operator held the kill down. The budget is the only brake here.
      continue;
    }

    // Every remaining scored exit follows the prototype's single stall rule
    // (driver.mjs:920): progress resets the counter, non-progress increments it —
    // REGARDLESS of exit class. 'errored' counts like the rest; a whitelist of "stall
    // exits" once left it counting as neither, which was an infinite-retry shape capped
    // only by the run budget.
    if (outcome.progressed) {
      state.stalls = 0;
      continue;
    }
    state.stalls += 1;
    if (state.stalls >= input.maxConsecutiveStalls) {
      state.status = 'parked';
      state.parkedFor = 'stalls';
      return state;
    }
  }

  state.status = 'exhausted';
  return state;
}
