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
import { notificationFor, notifyAll, type NotifyChannel, type NotifyEvent } from '@spicyspec/notify';
import type { OpenNextInput, OpenNextResult, QueueActivities, SettleInput, SettleResult } from '@spicyspec/orchestrator';
import { specDrivenPipeline, stageAfter, type PipelineDefinition } from '@spicyspec/pipeline';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { exportQueueView } from './compat-view.js';
import { rotationStopReason } from './control-flags.js';
import { runsRootFor, writeParkDiagnosis } from './parked-writer.js';
import { consumeReviewDecision, isReviewDecisionConsumed, markRecordedDecisionConsumed } from './review-consumption.js';
import { notifyChannelsFor } from './notify-channels.js';
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
  return deps.notifyChannels ?? notifyChannelsFor(deps.runner.config);
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
      // The operator stop, read at the ONE boundary where new work is opened — the
      // prototype polled its STOP files at exactly this point in the outer loop
      // (driver.mjs:1020). A `halt` is what ends the rotation cleanly: in-flight children
      // finish and settle, nothing new opens, and the workflow returns instead of idling
      // resident. This is what makes the room's "stop armed" promise true even when its
      // halt CLI could not be reached — the flag alone is enough.
      //
      // The flags are NOT cleared here. The room arms them and its START/RESUME actions
      // release them; a rotation that disarmed its own stop would leave a founder's click
      // undone by the very loop it was meant to stop.
      const stopReason = await rotationStopReason(store);
      if (stopReason) return { kind: 'halt', violations: [stopReason] };

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
        // The tag is permanent evidence and is re-credited on every iteration, as the
        // prototype did. But the room's sign-off writes the tag AND a review decision, so a
        // tag-credited entry left an UNSPENT decision behind — still live evidence the pass
        // below would credit to a hand re-queue months later. Spending it here is what
        // closes that: one sign-off, one consumption, whichever path saw it first.
        // Best effort: the TAG is the permanent evidence and is re-credited every
        // iteration, so a store hiccup spending the paired decision must not throw out of
        // a promotion the tag already justifies.
        try {
          await markRecordedDecisionConsumed(store, id, await readReviewDecision(store, id));
        } catch {
          /* the tag stands on its own; the decision is spent on a later iteration */
        }
        await announce('complete', id, 'founder sign-off found — the entry is done and its review slot is freed');
      }
      // The room's sign-off endpoint ALSO records a review decision, which is the path a
      // manager approval takes when no tag is cut. Consumed through the marker the workflow
      // bridge shares, so a decision either consumer has spent is spent for both.
      // COMMIT THE QUEUE FIRST, THEN SPEND. A decision marked consumed while its entry is
      // still 'awaiting-review' is a decision nothing can ever credit: unlike the tag path
      // (permanent evidence, re-credited every iteration), a recorded-decision approval
      // exists once. Crashing between the two used to lose the founder's approval outright.
      const pendingSpend: Array<{ id: string; decision: { at?: string; approved?: boolean } }> = [];
      for (const entry of queue.entries) {
        if (entry.status !== 'awaiting-review') continue;
        const decision = await readReviewDecision(store, entry.id);
        if (decision?.approved !== true) continue;
        if ((await isReviewDecisionConsumed(store, entry.id, decision))) continue;
        entry.status = 'done';
        entry.closedAt = new Date().toISOString();
        promotions.push(entry.id);
        pendingSpend.push({ id: entry.id, decision });
      }
      if (promotions.length) {
        await store.saveQueue(queue);
        await mirrorQueue();
      }
      for (const { id, decision } of pendingSpend) {
        // The atomic claim still decides the winner if the workflow bridge raced us here;
        // losing it only means the decision was already credited, and the entry above is
        // 'done' either way.
        await consumeReviewDecision(store, id, decision).catch(() => false);
        await announce('complete', id, 'recorded review approval credited — the entry is done and its review slot is freed');
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
        case 'stopped': {
          // The operator killed the run from the dashboard. That is not a worker outcome
          // (B15) and must not touch the entry: the spec stays ACTIVE at its current
          // stage, so clearing the stop resumes exactly where it left off. Parking it
          // here would demand a founder decision for a button the founder just pressed.
          await announce('stopped', entry.id, 'operator kill — the spec stays active at its stage');
          break;
        }
        case 'parked':
        case 'exhausted': {
          // exhausted = the maxRuns backstop fired — that is a parked spec with a note,
          // never a retirement (a runaway loop must not consume the catalog).
          entry.status = 'parked';
          // The forensic half: a notification is not a record, and a park with no written
          // diagnosis is one the founder cannot clear — the room lists it as a defect of its
          // own. Best effort on purpose: a filesystem that refuses the append must not
          // block the queue transition it describes (C3).
          try {
            writeParkDiagnosis(join(deps.runner.config.repoCwd, deps.runner.config.parkedPath), runsRootFor(deps.runner.config.repoCwd), {
              specId: entry.id,
              parkedFor: input.parkedFor,
              status: input.status,
              lastExit: input.lastExit,
              stalls: input.stalls,
              runs: input.runs,
            });
          } catch {
            /* the diagnosis is evidence, never a gate */
          }
          await announce('parked', entry.id, input.status === 'exhausted' ? 'the maxRuns backstop fired' : '');
          break;
        }
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
