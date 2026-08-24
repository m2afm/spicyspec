/**
 * Activities — where the real work happens. The workflow stays deterministic; everything
 * that touches a provider, the filesystem, or a clock lives here, heartbeating so the
 * engine can tell a long-running healthy session from a dead one (the fix for the
 * prototype's watchdog killing a healthy 12-minute-silent test run, B6).
 */
import { heartbeat } from '@temporalio/activity';
import {
  classify,
  harvestEvents,
  summariseHarvest,
  type Classification,
  type EvidenceSnapshot,
  type HarvestableEvent,
  type HarvestSummary,
} from '@spicyspec/core';
import { collectSession, type ProviderAdapter, type SessionOptions } from '@spicyspec/provider';

export interface WorkerRunInput {
  specId: string;
  run: number;
}

export interface WorkerRunOutcome {
  exit: Classification['exit'];
  costUsd: number;
  costKnown: boolean;
  commits: boolean;
  tasksClosed: number;
  /**
   * Did the run move the work forward (commit, task closed, handoff touched)? The stall
   * counter keys on THIS, not on the exit class — the prototype's rule (driver.mjs:920)
   * was "progress resets, non-progress increments, regardless of exit", and keying on a
   * whitelist of exits left `errored` counting as neither, i.e. retried to the run budget.
   */
  progressed: boolean;
}

export interface ReviewDecisionInput {
  specId: string;
}

export interface ReviewDecisionFound {
  approved: boolean;
  note?: string;
  by?: string;
}

export interface SpecRunActivities {
  runWorkerSession(input: WorkerRunInput): Promise<WorkerRunOutcome>;
  /**
   * The review bridge: a manager records an approve/reject intent in the store (via the
   * control plane); the workflow polls this while parked on a review, so a decision made
   * on the dashboard reaches the run without anyone knowing a workflow id. Must return a
   * decision AT MOST ONCE per recorded intent (delivery is marked in the store).
   */
  checkReviewDecision(input: ReviewDecisionInput): Promise<ReviewDecisionFound | null>;
}

/**
 * Everything about a finished run that is NOT in its `Classification` — the facts a run row
 * needs and only this activity holds. `head` and `startedAt` are here because the run row
 * carried neither: the control room's tick table renders a HEAD link and a start time per
 * run, and both were structurally null while the snapshots and the clock lived only inside
 * runWorkerSession.
 */
export interface RunEvidence {
  harvest: HarvestSummary;
  workerText: string;
  /** HEAD of the worked tree AFTER the session — the run row's commit pointer */
  head: string | null;
  /** ISO instant the session started, from the same clock the watchdog uses */
  startedAt: string;
}

export interface ActivityDeps {
  provider: ProviderAdapter;
  /** build the work packet for this run — pipeline stage prompts (Phase 1: injected) */
  buildPacket(input: WorkerRunInput): Promise<Pick<SessionOptions, 'prompt' | 'cwd' | 'account' | 'model' | 'effort' | 'disallowedTools' | 'protectedPaths'>>;
  /**
   * Evidence snapshots around the session — repo head, task counts. Takes the RUN INPUT:
   * three concurrent activities share one deps object, and a shared "current input"
   * closure raced across lanes — a $30.82 run with real commits classified no-progress
   * because its snapshots were read through another lane's tree.
   */
  snapshot(input: WorkerRunInput): Promise<EvidenceSnapshot>;
  /**
   * Called with the full classification after every run — where the runner settles the
   * account pool, appends the run ledger, and convenes the second-vendor judge with the
   * EVIDENCE (harvest) and the STORY (worker text). Failures here must not mask the run
   * outcome.
   */
  onClassified?(
    cls: Classification,
    accountId: string,
    evidence: RunEvidence,
    input: WorkerRunInput,
  ): Promise<void>;
  /** the review bridge — read (and mark delivered) a manager's recorded decision */
  checkReviewDecision?(specId: string): Promise<ReviewDecisionFound | null>;
  /**
   * Watchdog timings for a live-but-wedged session. Heartbeats prove THIS process is
   * alive; they cannot see a session that streams nothing while achieving nothing — that
   * class ran the full activity timeout and came back as an activity FAILURE the retry
   * policy re-ran, instead of a classified hung/stalled/timed-out run.
   */
  watchdog?: Partial<WatchdogConfig>;
  /**
   * Current HEAD of the tree this run works — the watchdog's forward-progress signal for
   * the stall rule (a commit resets the stall horizon, exactly as the prototype polled
   * headOf() every watchdog tick). Absent, the stall rule falls back to stream quiet only.
   */
  headOf?(input: WorkerRunInput): Promise<string | null>;
  /**
   * Has an operator armed a hard kill (the prototype's STOP-NOW file, here a runner flag)?
   * Polled by the watchdog so a kill lands MID-RUN rather than after the current session
   * finishes; the run then scores as `aborted`, which is never a worker failure.
   */
  killRequested?(input: WorkerRunInput): Promise<boolean>;
  /** the watchdog's clock, injectable so its rules are testable without waiting hours */
  nowMs?(): number;
  /**
   * Live-feed tap: every normalized session event, as it happens. The control room's
   * Current-tick panel replays this — without it the panel can only say "starting up",
   * which reads as a dead system while a session is an hour deep in real work.
   */
  openSessionLog?(input: WorkerRunInput): Promise<{ write(event: unknown): void; close(): void }>;
  /** heartbeat cadence while draining the session stream */
  heartbeatEveryNEvents?: number;
}

/**
 * In-session watchdog timings. Defaults are the prototype's tuned values
 * (driver.mjs:462-513); the two-condition stall rule is B6 — its tick 4 was killed at
 * exactly 30 minutes, 71 tool calls deep, one command short of committing, because the
 * integration tier is quiet for ~12 minutes while healthy. A stall therefore requires
 * BOTH no forward progress over a long horizon AND the worker being quiet right now.
 */
export interface WatchdogConfig {
  maxRunMinutes: number;
  hangMinutes: number;
  stallMinutes: number;
  quietMinutes: number;
  pollSeconds: number;
}

export const DEFAULT_WATCHDOG: WatchdogConfig = {
  maxRunMinutes: 240,
  hangMinutes: 30,
  stallMinutes: 90,
  quietMinutes: 12,
  pollSeconds: 60,
};

/** After this many failed interrupts the run is abandoned and scored — a kill that never
 * takes must not leave the drain loop waiting on a 'done' that never arrives. */
const MAX_KILL_ATTEMPTS = 4;

/** What the watchdog knows, all of it, in milliseconds. */
export interface WatchdogClock {
  startedMs: number;
  /** last stream event of ANY kind — the "is it talking" signal */
  lastEventMs: number;
  /** last observed forward progress (a new HEAD) — the "is it getting anywhere" signal */
  lastProgressMs: number;
  nowMs: number;
  /** an operator asked for a hard kill NOW (the prototype's STOP-NOW file) */
  killRequested?: boolean;
}

export type WatchdogTrip = 'stop-now' | 'hang' | 'stall' | 'timeout' | null;

/**
 * Should this session be killed, and for what?
 *
 * Pure and exported so the rules are tested at the minute, not by waiting hours. Order is
 * load-bearing: an operator's kill outranks every timing rule, the hard backstop outranks
 * hang, and hang outranks stall — so a wedged session is reported by the most specific
 * rule that fired first, and a deliberate kill is never mislabelled as a worker failure
 * (an operator kill scores ABORTED and must never touch the stall limit, B15).
 *
 * The stall rule needs BOTH conditions (B6). The prototype's tick 4 was killed at exactly
 * 30 minutes, 71 tool calls deep, one command short of its first commit, because the
 * integration tier runs ~12 minutes emitting nothing: "no commit yet" alone is not a
 * stall, and a short quiet timeout alone kills healthy work.
 */
export function watchdogVerdict(clock: WatchdogClock, cfg: WatchdogConfig): WatchdogTrip {
  if (clock.killRequested) return 'stop-now';
  const mins = (since: number) => (clock.nowMs - since) / 60_000;
  const quietFor = mins(clock.lastEventMs);
  if (mins(clock.startedMs) > cfg.maxRunMinutes) return 'timeout';
  if (quietFor > cfg.hangMinutes) return 'hang';
  if (mins(clock.lastProgressMs) > cfg.stallMinutes && quietFor > cfg.quietMinutes) return 'stall';
  return null;
}

/**
 * Build the activity implementations with their dependencies injected — the worker process
 * wires real ones; tests wire fakes. Nothing here is reachable from workflow code except
 * through the activity proxy.
 */
export function createActivities(deps: ActivityDeps): SpecRunActivities {
  const every = deps.heartbeatEveryNEvents ?? 25;

  /**
   * Heartbeat, guarded. The only way `heartbeat` throws is being called outside an activity
   * context — a direct-call unit test. Cancellation never arrives this way, so nothing real
   * is being swallowed; what IS prevented is a test-only throw escaping mid-drain and
   * discarding a session's whole record.
   */
  const beat = (details: Record<string, unknown>) => {
    try {
      heartbeat(details);
    } catch {
      /* no activity context (direct-call tests) */
    }
  };

  return {
    async checkReviewDecision(input) {
      return deps.checkReviewDecision ? deps.checkReviewDecision(input.specId) : null;
    },

    async runWorkerSession(input: WorkerRunInput): Promise<WorkerRunOutcome> {
      // Pre-flight kill check, BEFORE leasing an account or spawning a provider session.
      // The kill flag lives outside this workflow and stays armed until the operator
      // clears it, so without this check an armed kill spawns a real session, waits a
      // whole watchdog poll (60s), then aborts — and the rotation re-dispatches, up to
      // maxRunsPerSpec times. That is ~40 billed sessions and 40 account uses for one
      // button press.
      // A store hiccup is NOT a kill (same discipline the watchdog applies): failing to
      // read the flag must never abort work the operator did not ask to stop.
      let killArmed = false;
      try {
        killArmed = deps.killRequested ? await deps.killRequested(input) : false;
      } catch {
        killArmed = false;
      }
      if (killArmed) {
        return { exit: 'aborted', costUsd: 0, costKnown: true, commits: false, tasksClosed: 0, progressed: false };
      }
      const packet = await deps.buildPacket(input);
      const before = await deps.snapshot(input);

      const session = deps.provider.createSession(packet as SessionOptions);
      const sessionLog = deps.openSessionLog ? await deps.openSessionLog(input) : null;

      // Drain with heartbeats: a healthy session may be silent for many minutes inside a
      // test tier; the heartbeat proves THIS process is alive regardless.
      let events = 0;
      let toolCalls = 0;
      let text = '';
      let envelope = null as Awaited<ReturnType<typeof collectSession>>['envelope'];
      let rateLimit = null as Awaited<ReturnType<typeof collectSession>>['rateLimit'];
      // Kept whole for the evidence layer: the judge weighs the story against the
      // commands that actually ran (B8) — a tail window is not a total (B5).
      const harvested: HarvestableEvent[] = [];

      // The watchdog: a session that is alive but wedged emits nothing, so the for-await
      // below would never advance and the activity would run to its timeout — which the
      // retry policy then re-ran as if it were infrastructure. The timer kills the session
      // and records WHY, so classify scores the run (hung/stalled/timed-out) and the stall
      // limit sees it. killedFor was hard-coded null here once; those exit classes were
      // dead code and a wedged session cost 4h × the retry budget.
      const wd: WatchdogConfig = { ...DEFAULT_WATCHDOG, ...deps.watchdog };
      const now = deps.nowMs ?? Date.now;
      const startedMs = now();
      let lastEventMs = startedMs;
      let lastProgressMs = startedMs;
      // Seeded from the pre-run snapshot, as the prototype seeded lastHead from headOf():
      // starting at null makes the FIRST poll look like a fresh commit and silently pushes
      // the stall horizon one poll into the future on every run.
      let lastHead: string | null = before.git.head ?? null;
      let killedFor: WatchdogTrip = null;
      let killAttempts = 0;
      let abandonRun!: () => void;
      const abandoned = new Promise<'abandoned'>((resolveAbandon) => {
        abandonRun = () => resolveAbandon('abandoned');
      });
      const watchdog = setInterval(() => {
        void (async () => {
          beat({ events, watchdog: true });
          if (deps.headOf) {
            try {
              const head = await deps.headOf(input);
              if (head && head !== lastHead) {
                lastHead = head;
                lastProgressMs = now();
              }
            } catch {
              // an unreadable head is not progress — the stall horizon keeps running
            }
          }
          let killRequested = false;
          if (deps.killRequested) {
            try {
              killRequested = await deps.killRequested(input);
            } catch {
              // an unreadable kill flag is not a kill — never abort a healthy run on a
              // store hiccup
            }
          }
          killedFor ??= watchdogVerdict({ startedMs, lastEventMs, lastProgressMs, nowMs: now(), killRequested }, wd);
          // Kill, but do NOT disarm: the prototype cleared its interval before the kill
          // once, so a kill that failed to take was never retried and the loop hung
          // silently. The timer keeps firing until the stream ends; after MAX_KILL_ATTEMPTS
          // the run is abandoned and scored rather than waited on forever.
          if (killedFor) {
            killAttempts += 1;
            await session.interrupt().catch(() => undefined);
            if (killAttempts >= MAX_KILL_ATTEMPTS) abandonRun();
          }
        })();
      }, wd.pollSeconds * 1000);
      watchdog.unref?.();

      const iterator = session.events()[Symbol.asyncIterator]();
      try {
        while (true) {
          // Racing the abandon latch, not a bare for-await: a session that never emits
          // again would otherwise park this loop until the activity timeout, and the
          // engine reports that as an infrastructure FAILURE the retry policy re-runs
          // rather than as a classified run.
          const pending = iterator.next();
          // A next() left pending when the abandon latch wins is orphaned on purpose —
          // swallow its eventual rejection so an abandoned session cannot crash the
          // process with an unhandled rejection after the run is already scored.
          pending.catch(() => undefined);
          const step = await Promise.race([pending, abandoned]);
          if (step === 'abandoned' || step.done) break;
          const event = step.value;
          events += 1;
          lastEventMs = now();
          sessionLog?.write(event);
          if (events % every === 0) beat({ events });
          switch (event.type) {
            case 'tool_use':
              toolCalls += 1;
              harvested.push({ type: 'tool_use', id: event.id, name: event.name, input: event.input });
              break;
            case 'tool_result':
              harvested.push({ type: 'tool_result', toolUseId: event.toolUseId, isError: event.isError, text: event.text });
              break;
            case 'assistant_text':
              if (event.topLevel) text += (text ? '\n' : '') + event.text;
              break;
            case 'rate_limit':
              rateLimit = event.info;
              break;
            case 'result':
              envelope = event.envelope;
              break;
            default:
              break;
          }
        }
      } finally {
        clearInterval(watchdog);
        await iterator.return?.().catch(() => undefined);
      }

      sessionLog?.close();
      const after = await deps.snapshot(input);
      const cls = classify(
        { killedFor, resultEnvelope: envelope, rateLimit, text, toolCalls },
        before,
        after,
      );

      if (deps.onClassified) {
        try {
          const summary = summariseHarvest(harvestEvents(harvested));
          await deps.onClassified(
            cls,
            packet.account.id,
            { harvest: summary, workerText: text, head: after.git.head ?? null, startedAt: new Date(startedMs).toISOString() },
            input,
          );
        } catch {
          // Pool/ledger/judge bookkeeping must never mask the run outcome the workflow needs.
        }
      }

      return {
        exit: cls.exit,
        costUsd: cls.costUsd,
        costKnown: cls.costKnown,
        commits: cls.commits,
        tasksClosed: cls.tasksClosed,
        progressed: cls.progressed,
      };
    },
  };
}

/** re-export for tests that build outcomes without a session */
export { collectSession };
