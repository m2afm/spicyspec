/**
 * Activities — where the real work happens. The workflow stays deterministic; everything
 * that touches a provider, the filesystem, or a clock lives here, heartbeating so the
 * engine can tell a long-running healthy session from a dead one (the fix for the
 * prototype's watchdog killing a healthy 12-minute-silent test run, B6).
 */
import { heartbeat } from '@temporalio/activity';
import { classify, type Classification, type EvidenceSnapshot } from '@spicyspec/core';
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

export interface SpecRunActivities {
  runWorkerSession(input: WorkerRunInput): Promise<WorkerRunOutcome>;
}

export interface ActivityDeps {
  provider: ProviderAdapter;
  /** build the work packet for this run — pipeline stage prompts (Phase 1: injected) */
  buildPacket(input: WorkerRunInput): Promise<Pick<SessionOptions, 'prompt' | 'cwd' | 'account' | 'model' | 'effort' | 'disallowedTools' | 'protectedPaths'>>;
  /** evidence snapshots around the session — repo head, task counts (Phase 1: injected) */
  snapshot(): Promise<EvidenceSnapshot>;
  /**
   * Called with the full classification after every run — where the runner settles the
   * account pool (mark cold on a limit, sideline on a refusal, record the observed
   * window) and appends the run ledger. Failures here must not mask the run outcome.
   */
  onClassified?(cls: Classification, accountId: string): Promise<void>;
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
    async runWorkerSession(input: WorkerRunInput): Promise<WorkerRunOutcome> {
      const packet = await deps.buildPacket(input);
      const before = await deps.snapshot();

      const session = deps.provider.createSession(packet as SessionOptions);

      // Drain with heartbeats: a healthy session may be silent for many minutes inside a
      // test tier; the heartbeat proves THIS process is alive regardless.
      let events = 0;
      let toolCalls = 0;
      let text = '';
      let envelope = null as Awaited<ReturnType<typeof collectSession>>['envelope'];
      let rateLimit = null as Awaited<ReturnType<typeof collectSession>>['rateLimit'];

      for await (const event of session.events()) {
        events += 1;
        if (events % every === 0) heartbeat({ events });
        switch (event.type) {
          case 'tool_use':
            toolCalls += 1;
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

      const after = await deps.snapshot();
      const cls = classify(
        { killedFor: null, resultEnvelope: envelope, rateLimit, text, toolCalls },
        before,
        after,
      );

      if (deps.onClassified) {
        try {
          await deps.onClassified(cls, packet.account.id);
        } catch {
          // Pool/ledger bookkeeping must never mask the run outcome the workflow needs.
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
