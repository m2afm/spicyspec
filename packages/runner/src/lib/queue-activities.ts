/**
 * Queue activities — the store-touching half of the rotation workflow.
 *
 * Everything here is the prototype driver's outer loop, re-expressed: guard the queue
 * (Q1–Q8) before every decision, repair only what evidence makes unambiguous, halt on
 * what it cannot reason about, and never let the review backlog silently grow past the
 * cap that keeps every spec close to the human click that verifies it.
 */
import { applyRepairs, checkQueue, type Queue, type QueueEvidence } from '@spicyspec/core';
import {
  createNtfyChannel,
  createWebhookChannel,
  notificationFor,
  notifyAll,
  type NotifyChannel,
  type NotifyEvent,
} from '@spicyspec/notify';
import type { OpenNextResult, QueueActivities, SettleInput, SettleResult } from '@spicyspec/orchestrator';
import { specDrivenPipeline, stageAfter, type PipelineDefinition } from '@spicyspec/pipeline';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { exportQueueView } from './compat-view.js';
import { findSpecDir } from './spec-dir.js';
import type { RunnerDeps } from './wiring.js';

const execFileAsync = promisify(execFile);

export interface QueueEvidenceFns {
  specDirExists(id: string): boolean;
  commitsFor(id: string): number;
  signedOff(id: string): boolean;
}

/** Default evidence against the real repo. Cheap, and every rule stays injectable. */
export async function defaultEvidence(repoCwd: string, specsDir = 'specs'): Promise<QueueEvidenceFns> {
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

  // Pre-resolved (sync interface): `<id>` or `<id>-<slug>` both count as the spec existing.
  const specDirs = new Set<string>();
  try {
    const { readdir } = await import('node:fs/promises');
    for (const name of await readdir(join(repoCwd, specsDir))) specDirs.add(name);
  } catch {
    /* no specs dir yet */
  }
  void findSpecDir; // resolution rule documented there; the set below applies the same match
  return {
    specDirExists: (id) =>
      existsSync(join(repoCwd, specsDir, id)) || [...specDirs].some((n) => n === id || n.startsWith(`${id}-`)),
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
  /** injected for tests; defaults to the channels in runner config */
  notifyChannels?: NotifyChannel[];
}

/** Build the notification channels a runner config declares. */
export function channelsFromConfig(deps: QueueActivityDeps): NotifyChannel[] {
  if (deps.notifyChannels) return deps.notifyChannels;
  return deps.runner.config.notify.channels.map((c) =>
    c.type === 'ntfy' ? createNtfyChannel({ topic: c.topic, server: c.server }) : createWebhookChannel({ url: c.url }),
  );
}

export function createQueueActivities(deps: QueueActivityDeps): QueueActivities {
  const pipeline = deps.pipeline ?? specDrivenPipeline;
  const store = deps.runner.store;
  const compat = deps.runner.config.compatLoopDir
    ? { repoCwd: deps.runner.config.repoCwd, loopDir: deps.runner.config.compatLoopDir }
    : null;
  const mirrorQueue = async () => {
    if (compat) await exportQueueView(store, compat).catch(() => undefined);
  };
  const cap = deps.maxAwaitingReview ?? deps.runner.config.maxAwaitingReview;
  const firstStage = pipeline.stages[0].id;
  const channels = channelsFromConfig(deps);
  const projectName = deps.runner.config.projectName;

  // Failures are recorded in the store KV so the dashboard can show a broken channel;
  // a dead channel never blocks the transition it announces (C3).
  const announce = async (event: NotifyEvent, specId: string | null, detail = '') => {
    if (!channels.length) return;
    const result = await notifyAll(channels, notificationFor(event, projectName, specId, detail));
    if (result.failures.length) {
      await store.setKv('notify:last-failures', JSON.stringify({ at: new Date().toISOString(), failures: result.failures }));
    }
  };

  let awaitingCount = 0;
  const evidence = async (): Promise<QueueEvidence> => {
    const fns = await (deps.evidenceFn ?? (() => defaultEvidence(deps.runner.config.repoCwd, deps.runner.config.specsDir)))();
    return {
      ...fns,
      reviewCapBlocks: () => {
        // pre-resolved below: core checkQueue is synchronous
        return awaitingCount >= cap;
      },
    };
  };

  return {
    async openNextSpec(): Promise<OpenNextResult> {
      const queue: Queue = await store.loadQueue();
      awaitingCount = queue.entries.filter((e) => e.status === 'awaiting-review').length;
      const ev = await evidence();

      const check = checkQueue(queue, ev);
      if (check.halting.length) {
        // Never run against a state the loop cannot reason about — stop, do not guess.
        const violations = check.halting.map((v) => `${v.code} [${v.id ?? '-'}] ${v.message}`);
        await announce('halted', null, violations.join('; '));
        return { kind: 'halt', violations };
      }
      const repaired = applyRepairs(queue, check.violations);
      if (repaired.changed) {
        await store.saveQueue(queue);
        await mirrorQueue();
      }

      const active = queue.entries.find((e) => e.status === 'active');
      if (active) {
        if (!active.stage) {
          active.stage = firstStage;
          await store.saveQueue(queue);
          await mirrorQueue();
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
      await store.saveQueue(queue);
      await mirrorQueue();
      return { kind: 'next', next: { specId: pending.id, stage: pending.stage } };
    },

    async settleSpecOutcome(input: SettleInput): Promise<SettleResult> {
      const queue = await store.loadQueue();
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
            await announce('awaiting-review', entry.id);
          }
          break;
        }
        case 'awaiting-review':
          entry.status = 'awaiting-review';
          await announce('awaiting-review', entry.id);
          break;
        case 'parked':
        case 'exhausted':
          // exhausted = the maxRuns backstop fired — that is a parked spec with a note,
          // never a retirement (a runaway loop must not consume the catalog).
          entry.status = 'parked';
          await announce('parked', entry.id, input.status === 'exhausted' ? 'the maxRuns backstop fired' : '');
          break;
        default:
          break;
      }

      await store.saveQueue(queue);
      await mirrorQueue();
      return {
        queueStatus: String(entry.status),
        nextStage: entry.status === 'active' ? (entry.stage ?? null) : null,
      };
    },
  };
}
