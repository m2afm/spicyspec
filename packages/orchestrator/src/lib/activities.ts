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
    evidence: { harvest: HarvestSummary; workerText: string },
    input: WorkerRunInput,
  ): Promise<void>;
  /** the review bridge — read (and mark delivered) a manager's recorded decision */
  checkReviewDecision?(specId: string): Promise<ReviewDecisionFound | null>;
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
 * Build the activity implementations with their dependencies injected — the worker process
 * wires real ones; tests wire fakes. Nothing here is reachable from workflow code except
 * through the activity proxy.
 */
export function createActivities(deps: ActivityDeps): SpecRunActivities {
  const every = deps.heartbeatEveryNEvents ?? 25;

  return {
    async checkReviewDecision(input) {
      return deps.checkReviewDecision ? deps.checkReviewDecision(input.specId) : null;
    },

    async runWorkerSession(input: WorkerRunInput): Promise<WorkerRunOutcome> {
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

      for await (const event of session.events()) {
        events += 1;
        sessionLog?.write(event);
        if (events % every === 0) heartbeat({ events });
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

      sessionLog?.close();
      const after = await deps.snapshot(input);
      const cls = classify(
        { killedFor: null, resultEnvelope: envelope, rateLimit, text, toolCalls },
        before,
        after,
      );

      if (deps.onClassified) {
        try {
          const summary = summariseHarvest(harvestEvents(harvested));
          await deps.onClassified(cls, packet.account.id, { harvest: summary, workerText: text }, input);
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
      };
    },
  };
}

/** re-export for tests that build outcomes without a session */
export { collectSession };
