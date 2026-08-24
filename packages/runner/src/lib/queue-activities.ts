/**
 * Queue activities — the store-touching half of the rotation workflow.
 *
 * Everything here is the prototype driver's outer loop, re-expressed: guard the queue
 * (Q1–Q8) before every decision, repair only what evidence makes unambiguous, halt on
 * what it cannot reason about, and never let the review backlog silently grow past the
 * cap that keeps every spec close to the human click that verifies it.
 */
import { readReviewDecision } from '@spicyspec/control-plane';
import { applyRepairs, checkQueue, promoteSignedOff, type Queue, type QueueEvidence } from '@spicyspec/core';
import {
  createNtfyChannel,
  createWebhookChannel,
  notificationFor,
  notifyAll,
  type NotifyChannel,
  type NotifyEvent,
} from '@spicyspec/notify';
import type { OpenNextInput, OpenNextResult, QueueActivities, SettleInput, SettleResult } from '@spicyspec/orchestrator';
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
    async openNextSpec(input: OpenNextInput): Promise<OpenNextResult> {
      const busy = new Set(input?.busy ?? []);
      const maxParallel = Math.max(1, deps.runner.config.maxParallelSpecs);
      const queue: Queue = await store.loadQueue();

      // Evidence is read BEFORE the promotion below, on purpose: `signedOff` is the git
      // tag, which is the same fact the prototype's guardQueue promoted on. `reviewCapBlocks`
      // is lazy (it reads awaitingCount at call time), so recounting after the promotion
      // still gives the cap check the freed slot.
      const ev = await evidence();

      // guardQueue parity (prototype driver.mjs:200-209): credit founder sign-offs FIRST,
      // on EVERY rotation iteration, so an entry that is both signed off and otherwise
      // suspect is credited rather than demoted — and the freed review slot is visible to
      // the cap check in this same pass. Without this promotion the review cap filled,
      // openNextSpec idled forever, and a founder click at 3am resumed nothing.
      const promotions = promoteSignedOff(queue, ev.signedOff);
      for (const id of promotions) {
        await announce('complete', id, 'founder sign-off found — the entry is done and its review slot is freed');
      }
      // The room's sign-off endpoint ALSO records a review decision, which is the path a
      // manager approval takes when no tag is cut. Keyed to its own timestamp so it
      // promotes at most once: a spec re-queued by hand after a past approval must not be
      // auto-retired by the stale record. (The tag has no such key — a tag IS permanent
      // evidence, and the prototype re-credited it on every iteration too.)
      for (const entry of queue.entries) {
        if (entry.status !== 'awaiting-review') continue;
        const decision = await readReviewDecision(store, entry.id);
        if (decision?.approved !== true) continue;
        const promotedKey = `review:promoted:${entry.id}`;
        // A hand-written record with no timestamp still promotes exactly once: falling back
        // to a constant makes the key match forever after, which errs toward "already
        // credited" rather than re-retiring a re-queued spec on every rotation iteration.
        const stamp = decision.at || 'undated';
        if ((await store.getKv(promotedKey)) === stamp) continue;
        entry.status = 'done';
        entry.closedAt = new Date().toISOString();
        await store.setKv(promotedKey, stamp);
        promotions.push(entry.id);
        await announce('complete', entry.id, 'recorded review approval credited — the entry is done and its review slot is freed');
      }
      if (promotions.length) {
        await store.saveQueue(queue);
        await mirrorQueue();
      }

      awaitingCount = queue.entries.filter((e) => e.status === 'awaiting-review').length;

      const check = checkQueue(queue, ev, { maxActive: maxParallel });
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

      // An active entry nobody is working (a restart left it, or capacity freed) resumes first.
      const actives = queue.entries.filter((e) => e.status === 'active');
      const orphanActive = actives.find((e) => !busy.has(e.id));
      if (orphanActive) {
        if (!orphanActive.stage) {
          orphanActive.stage = firstStage;
          await store.saveQueue(queue);
          await mirrorQueue();
        }
        return { kind: 'next', next: { specId: orphanActive.id, stage: orphanActive.stage ?? firstStage } };
      }

      if (actives.length >= maxParallel) {
        return { kind: 'idle', reason: `all ${actives.length} writer slots are busy` };
      }

      if (ev.reviewCapBlocks()) {
        return { kind: 'idle', reason: 'the review backlog is at its cap — a human unblocks it' };
      }

      const pending = queue.entries.find((e) => e.status === 'pending' && !busy.has(e.id));
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
