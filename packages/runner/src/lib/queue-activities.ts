/**
 * Queue activities — the store-touching half of the rotation workflow.
 *
 * Everything here is the prototype driver's outer loop, re-expressed: guard the queue
 * (Q1–Q8) before every decision, repair only what evidence makes unambiguous, halt on
 * what it cannot reason about, and never let the review backlog silently grow past the
 * cap that keeps every spec close to the human click that verifies it.
 */
import { applyRepairs, checkQueue, type Queue, type QueueEvidence } from '@spicyspec/core';
import type { OpenNextResult, QueueActivities, SettleInput, SettleResult } from '@spicyspec/orchestrator';
import { specDrivenPipeline, stageAfter, type PipelineDefinition } from '@spicyspec/pipeline';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RunnerDeps } from './wiring.js';

const execFileAsync = promisify(execFile);

export interface QueueEvidenceFns {
  specDirExists(id: string): boolean;
  commitsFor(id: string): number;
  signedOff(id: string): boolean;
}

/** Default evidence against the real repo. Cheap, and every rule stays injectable. */
export async function defaultEvidence(repoCwd: string): Promise<QueueEvidenceFns> {
  const git = async (args: string[]): Promise<string> => {
    try {
      const { stdout } = await execFileAsync('git', ['--no-optional-locks', ...args], {
        cwd: repoCwd,
        timeout: 15_000,
        windowsHide: true,
      });
      return stdout;
    } catch {
      return '';
    }
  };

  // Pre-resolved so the evidence interface stays synchronous (core checkQueue is sync).
  const commitCounts = new Map<string, number>();
  const signedOffIds = new Set(
    (await git(['tag', '-l', 'signed-off/*'])).split('\n').filter(Boolean).map((t) => t.replace('signed-off/', '')),
  );
  const log = await git(['log', '--format=%s']);
  for (const subject of log.split('\n')) {
    for (const m of subject.matchAll(/\((\d{3})\)/g)) {
      commitCounts.set(m[1], (commitCounts.get(m[1]) ?? 0) + 1);
    }
  }

  return {
    specDirExists: (id) => existsSync(join(repoCwd, 'specs', id)),
    commitsFor: (id) => commitCounts.get(id) ?? 0,
    signedOff: (id) => signedOffIds.has(id),
  };
}

export interface QueueActivityDeps {
  runner: RunnerDeps;
  pipeline?: PipelineDefinition;
  /** injected for tests; defaults to git/fs evidence against the repo */
  evidenceFn?: () => Promise<QueueEvidenceFns>;
  maxAwaitingReview?: number;
}

export function createQueueActivities(deps: QueueActivityDeps): QueueActivities {
  const pipeline = deps.pipeline ?? specDrivenPipeline;
  const store = deps.runner.store;
  const cap = deps.maxAwaitingReview ?? 3;
  const firstStage = pipeline.stages[0].id;

  const evidence = async (): Promise<QueueEvidence> => {
    const fns = await (deps.evidenceFn ?? (() => defaultEvidence(deps.runner.config.repoCwd)))();
    return {
      ...fns,
      reviewCapBlocks: () => {
        const queue = store.loadQueue();
        return queue.entries.filter((e) => e.status === 'awaiting-review').length >= cap;
      },
    };
  };

  return {
    async openNextSpec(): Promise<OpenNextResult> {
      const queue: Queue = store.loadQueue();
      const ev = await evidence();

      const check = checkQueue(queue, ev);
      if (check.halting.length) {
        // Never run against a state the loop cannot reason about — stop, do not guess.
        return {
          kind: 'halt',
          violations: check.halting.map((v) => `${v.code} [${v.id ?? '-'}] ${v.message}`),
        };
      }
      const repaired = applyRepairs(queue, check.violations);
      if (repaired.changed) store.saveQueue(queue);

      const active = queue.entries.find((e) => e.status === 'active');
      if (active) {
        if (!active.stage) {
          active.stage = firstStage;
          store.saveQueue(queue);
        }
        return { kind: 'next', next: { specId: active.id, stage: active.stage ?? firstStage } };
      }

      if (ev.reviewCapBlocks()) {
        return { kind: 'idle', reason: 'the review backlog is at its cap — a human unblocks it' };
      }

      const pending = queue.entries.find((e) => e.status === 'pending');
      if (!pending) return { kind: 'idle', reason: 'nothing pending — catalog drained or parked' };

      pending.status = 'active';
      pending.stage = pending.stage ?? firstStage;
      store.saveQueue(queue);
      return { kind: 'next', next: { specId: pending.id, stage: pending.stage } };
    },

    async settleSpecOutcome(input: SettleInput): Promise<SettleResult> {
      const queue = store.loadQueue();
      const entry = queue.entries.find((e) => e.id === input.specId);
      if (!entry) throw new Error(`settleSpecOutcome: unknown spec "${input.specId}"`);

      switch (input.status) {
        case 'complete': {
          // A stage finished. Advance; past the last stage the spec waits on a HUMAN —
          // the platform never marks its own work done (RFC-001 §7.5).
          const next = stageAfter(pipeline, entry.stage ?? firstStage);
          if (next) {
            entry.stage = next.id;
          } else {
            entry.status = 'awaiting-review';
          }
          break;
        }
        case 'awaiting-review':
          entry.status = 'awaiting-review';
          break;
        case 'parked':
        case 'exhausted':
          // exhausted = the maxRuns backstop fired — that is a parked spec with a note,
          // never a retirement (a runaway loop must not consume the catalog).
          entry.status = 'parked';
          break;
        default:
          break;
      }

      store.saveQueue(queue);
      return {
        queueStatus: String(entry.status),
        nextStage: entry.status === 'active' ? (entry.stage ?? null) : null,
      };
    },
  };
}
