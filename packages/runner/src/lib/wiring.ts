/**
 * Runner wiring — the composition root: pool from the store, packets from the pipeline,
 * sessions from the provider, classification settled back into the store.
 *
 * This file replaces the prototype's driver internals. Every dependency is injectable so
 * the wiring itself is testable without a repo, a Temporal server, or a live provider.
 */
import {
  buildPool,
  describePool,
  earliestWarmMs,
  markCold,
  markLimitType,
  markRefused,
  pickOrder,
  poolState,
  recordUse,
  type Classification,
  type Pool,
  type PoolAccount,
} from '@spicyspec/core';
import { ApplicationFailure } from '@temporalio/client';
import { readReviewDecision } from '@spicyspec/control-plane';
import { buildJudgePrompt, cliJudgeProvider, judgeChain, type JudgeProvider, type JudgeResult } from '@spicyspec/judge';
import { createActivities, type ActivityDeps, type SpecRunActivities, type WorkerRunInput } from '@spicyspec/orchestrator';
import { buildPacket, specDrivenPipeline, type PacketContext, type PipelineDefinition, type PredecessorVerdict } from '@spicyspec/pipeline';
import { packSectionsFor, type GatePack } from '@spicyspec/packs';
import type { ProviderAdapter } from '@spicyspec/provider';
import type { Store } from '@spicyspec/store';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunnerConfig } from './config.js';
import { appendLedgerView, exportAccountsView } from './compat-view.js';
import { isKillArmed } from './control-flags.js';
import { createQueueActivities } from './queue-activities.js';
import { snapshot, type FullSnapshot } from './git-snapshot.js';
import { runsRootFor } from './parked-writer.js';
import { consumeReviewDecision } from './review-consumption.js';
import { findSpecDir } from './spec-dir.js';
import { openSessionLogDir } from './session-log.js';
import { ensureWorktree } from './worktree.js';

export interface RunnerDeps {
  config: RunnerConfig;
  store: Store;
  provider: ProviderAdapter;
  pipeline?: PipelineDefinition;
  /** gate packs installed for this project — their checklists ride the packet at gated stages */
  packs?: GatePack[];
  /** secrets keyed by account id, merged at build time — never persisted in the store */
  secrets?: Record<string, { env?: Record<string, string> }>;
  /** injected for tests */
  snapshotFn?: (input: WorkerRunInput) => Promise<FullSnapshot>;
  worktreeFn?: typeof ensureWorktree;
  judgeProviders?: JudgeProvider[];
  judgeChainFn?: typeof judgeChain;
  nowMs?: () => number;
  nowIso?: () => string;
}

const execFileAsync = promisify(execFile);

const judgeKey = (specId: string) => `judge:last:${specId}`;

/**
 * Minutes a run is credited with, from the turn count — the prototype's estimate, because a
 * subscription session reports turns and not wall time. Exported and used by BOTH surfaces
 * that state a duration (the store's run row and the compat LEDGER row): they were computed
 * in two places, so the control room's `minutes` total and the original room's could differ
 * on the same run.
 */
export const durationMinutesFor = (turns: number): number => Math.max(1, Math.round(turns / 3));

/** Map a judge verdict to what the next run's packet carries. */
export function verdictForPacket(result: JudgeResult | null): PredecessorVerdict | null {
  if (!result?.verdict) return null;
  const v = result.verdict;
  return {
    assessment: v.assessment,
    claimsUnverified: v.claimsUnverified,
    correction: v.honest ? undefined : v.reason,
    nextAction: v.action === 'continue' ? undefined : `${v.action} — ${v.reason}`,
  };
}

/** A lease whose recorded holder pid is not alive on this machine is orphaned. */
function isLeaseHolderDead(pid: number | undefined): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Startup lease sweep — a killed runner leaves fresh-looking leases behind (its
 * onClassified never ran), and the very first re-ignited packet build then finds every
 * account "leased" and fails the whole rotation. Leases carry the claiming pid; at
 * startup, any lease whose pid is dead on this machine is released. Cross-machine
 * runners will need runner-id heartbeats instead — today's deployment is one runner
 * per machine per project.
 */
export async function sweepOrphanedLeases(store: RunnerDeps['store']): Promise<string[]> {
  const swept: string[] = [];
  for (const { key, value } of await store.listKv('account:lease:')) {
    let pid: number | undefined;
    try {
      pid = (JSON.parse(value) as { pid?: number }).pid;
    } catch {
      pid = undefined;
    }
    if (pid === undefined || isLeaseHolderDead(pid)) {
      await store.release(key);
      swept.push(key);
    }
  }
  return swept;
}

/**
 * Every account cold (or leased). An ApplicationFailure, NOT a plain Error, and
 * nonRetryable, on purpose: the retry policy's exponential backoff capped out after ~2h
 * of hot retries and then FAILED the spec — on a normal overnight 5-hour window. The
 * workflow catches this type instead and sleeps a durable timer to the earliest reset
 * (the prototype's sleepUntil, driver.mjs:743-749). Details carry [earliestWarmAtMs,
 * thrownAtMs] so the workflow computes the wait without touching its own clock.
 *
 * `type` is the identity the workflow matches on, and it is the ONLY one available there:
 * a failure crosses the activity boundary as serialized data, so no subclass survives the
 * trip. Do NOT assign `name` — the base declares it read-only, and assigning threw a
 * TypeError that replaced this failure with a meaningless one at the throw site.
 */
export const NO_WARM_ACCOUNT = 'NoWarmAccountError';

export class NoWarmAccountError extends ApplicationFailure {
  constructor(public readonly earliestWarmAtMs: number | null, poolDescription: string, thrownAtMs: number) {
    super(`every account is cold (${poolDescription})`, NO_WARM_ACCOUNT, true, [earliestWarmAtMs, thrownAtMs]);
  }
}

/**
 * Build the pool fresh from store state on every pick — cooldowns recorded by a previous
 * process survive (C4), and two activities never share a stale in-memory pool.
 */
export async function loadPoolFromStore(deps: RunnerDeps): Promise<Pool> {
  return buildPool(deps.config.accounts, deps.secrets ?? {}, await deps.store.loadPoolState());
}

/** Settle a run's classification into the pool — the single place cooldown rules live. */
export async function settlePool(deps: RunnerDeps, cls: Classification, accountId: string): Promise<void> {
  const nowMs = deps.nowMs ?? Date.now;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const pool = await loadPoolFromStore(deps);

  recordUse(pool, accountId);
  if (cls.rateLimitType) markLimitType(pool, accountId, cls.rateLimitType, nowIso());
  if (cls.exit === 'rate-limited') markCold(pool, accountId, cls.rateResetsAt ?? null, nowMs());
  if (cls.exit === 'account-refused') markRefused(pool, accountId, cls.refusal ?? 'refused', nowMs(), nowIso());

  await deps.store.savePoolState(poolState(pool));
}

/** The real activity set the Temporal worker registers. */
export function createRunnerActivities(deps: RunnerDeps): SpecRunActivities {
  const pipeline = deps.pipeline ?? specDrivenPipeline;
  const cfg = deps.config;

  const workCwdBySpec = new Map<string, string>();
  const leasedAccountBySpec = new Map<string, string>();

  const snapshotFn =
    deps.snapshotFn ??
    (async (input: WorkerRunInput) => {
      // Snapshots read the tree the session WORKS — the spec's worktree in parallel mode.
      const base = workCwdBySpec.get(input.specId) ?? cfg.repoCwd;
      // Real tenants name spec dirs `<id>-<slug>` (Airvia); resolve, never assume.
      const specDir = await findSpecDir(base, cfg.specsDir, input.specId);
      return snapshot({
        cwd: base,
        tasksFile: specDir ? `${base}/${specDir}/tasks.md` : null,
        handoffFile: `${base}/${cfg.handoffPath}`,
        // B2: the runner's own state (the store, parked file) must never dirty the tree
        selfOwnedPaths: cfg.worker.protectedPaths,
      });
    });

  const activityDeps: ActivityDeps = {
    provider: deps.provider,

    // In-session watchdog timings — config with the prototype's defaults (240/30/90/12).
    watchdog: cfg.watchdog,

    // The watchdog's forward-progress signal: HEAD of the tree this run works. A commit
    // resets the stall horizon, exactly as the prototype's headOf poll did — without it
    // a worker mid-verify with commits landing would trip the stall rule (B6).
    async headOf(input: WorkerRunInput) {
      const cwd = workCwdBySpec.get(input.specId) ?? cfg.repoCwd;
      try {
        const { stdout } = await execFileAsync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], {
          cwd,
          timeout: 15_000,
          windowsHide: true,
        });
        return stdout.trim() || null;
      } catch {
        return null;
      }
    },

    /**
     * The control room's KILL, reaching the live session. Declared by the watchdog since
     * it existed but supplied by nobody, so the only kill that ever landed was a hard
     * process kill of the runner tree — which produces no classified run at all, where the
     * whole point of `aborted` is that an operator kill is recorded and is never scored as
     * a worker failure (B15). Armed = the row exists; clearing is the room's RESUME.
     */
    killRequested: () => isKillArmed(deps.store),

    async buildPacket(input: WorkerRunInput) {
      const pool = await loadPoolFromStore(deps);
      const nowMs = deps.nowMs ?? Date.now;

      // Lease an account: with N concurrent sessions, N packet builds race — pickAccount
      // alone would triple-book the least-used one. tryReserve is the atomic claim; a
      // lease older than 6h is stale (its holder died mid-run) and is broken.
      //
      // Candidates walk in core pickOrder — reserve-last (seven_day held back), then
      // fewest uses. This loop once sorted by uses alone, which bypassed the C4 reserve
      // rule at exactly the moment it exists for: a warm weekly account with zero uses
      // out-ranked every five-hour account and the week's quota went to ordinary runs.
      // The lease only SERIALIZES the chosen account; core owns the choice.
      let account: PoolAccount | null = null;
      const leased = new Set<string>();
      for (const candidate of pickOrder(pool, nowMs())) {
        const leaseKey = `account:lease:${candidate.id}`;
        const claim = JSON.stringify({ specId: input.specId, run: input.run, at: nowMs(), pid: process.pid });
        if (await deps.store.tryReserve(leaseKey, claim)) {
          account = candidate;
          break;
        }
        const heldRaw = await deps.store.getKv(leaseKey);
        const held = heldRaw ? (JSON.parse(heldRaw) as { at?: number; pid?: number }) : {};
        if (nowMs() - (held.at ?? 0) > 6 * 3600_000 || isLeaseHolderDead(held.pid)) {
          await deps.store.release(leaseKey);
          if (await deps.store.tryReserve(leaseKey, claim)) {
            account = candidate;
            break;
          }
        }
        leased.add(candidate.id);
      }
      if (!account) {
        // Every warm account is leased to a concurrent session, or the pool is cold.
        // NonRetryable by construction: the workflow catches this type and sleeps a
        // durable timer to the earliest reset instead of hot-retrying (see the class).
        throw new NoWarmAccountError(
          earliestWarmMs(pool),
          describePool(pool, nowMs()) + (leased.size ? ` · leased: ${[...leased].join(',')}` : ''),
          nowMs(),
        );
      }
      leasedAccountBySpec.set(input.specId, account.id);

      // Parallel mode: each concurrent spec works its OWN worktree on branch spec/<id> —
      // one tree, one writer (B12), N trees, N writers.
      let workCwd = cfg.repoCwd;
      if (cfg.maxParallelSpecs > 1) {
        const worktree = await (deps.worktreeFn ?? ensureWorktree)(cfg.repoCwd, input.specId);
        workCwd = worktree.path;
      }
      workCwdBySpec.set(input.specId, workCwd);

      const snap = await snapshotFn(input);
      // Stage comes from the queue entry (the rotation workflow advances it); the
      // task-list heuristic is only the fallback for a spec the queue does not know.
      const queueStage = (await deps.store.loadQueue()).entries.find((e) => e.id === input.specId)?.stage;
      const stage =
        pipeline.stages.find((s) => s.id === queueStage) ??
        (snap.tasks.exists ? pipeline.stages.find((s) => s.id === 'execute') ?? pipeline.stages[0] : pipeline.stages[0]);

      // The judge's verdict on the predecessor run steers this one (unverified claims are
      // re-checked, corrections applied) — the prototype tracker's loop, made durable.
      const storedVerdict = await deps.store.getKv(judgeKey(input.specId));
      const predecessorVerdict = storedVerdict
        ? verdictForPacket(JSON.parse(storedVerdict) as JudgeResult)
        : null;

      const ctx: PacketContext = {
        projectName: cfg.projectName,
        runNumber: input.run,
        specId: input.specId,
        stage,
        position: {
          branch: snap.git.branch,
          head: snap.git.head,
          headSubject: snap.git.headSubject,
          dirty: snap.git.dirty,
          dirtyPaths: snap.git.dirtyPaths,
          tasksDone: snap.tasks.done,
          tasksOpen: snap.tasks.open,
          nextTaskIds: snap.tasks.nextTaskIds,
        },
        readFirst: [
          { what: `\`${cfg.handoffPath}\``, why: 'the baton — position, gate state, traps. Verify against the tree.' },
          {
            what: `\`${(await findSpecDir(cfg.repoCwd, cfg.specsDir, input.specId)) ?? `${cfg.specsDir}/${input.specId}`}/\``,
            why: 'the spec directory — tasks.md is the work list; the open items are the job.',
          },
        ],
        protectedPaths: cfg.worker.protectedPaths,
        gateRecordPath: cfg.gateExportPath,
        parkedPath: cfg.parkedPath,
        predecessorVerdict,
        // Installed packs whose checklist joins THIS stage ride the packet as
        // evidence-demanding sections — the seat is told to prove each item, not tick it.
        extraSections: packSectionsFor(stage, deps.packs ?? []),
      };

      return {
        prompt: buildPacket(ctx),
        cwd: workCwd,
        account: { id: account.id, env: account.env, configDir: account.configDir },
        model: cfg.worker.model,
        effort: cfg.worker.effort,
        disallowedTools: cfg.worker.disallowedTools,
        protectedPaths: cfg.worker.protectedPaths,
        // Every path inside protected space the packet PROMISES access to must be
        // excepted — a promise the hook denies is B25 mirrored. Live proof: 009's plan
        // gate died on denied gates.jsonl appends and denied absolute-path writes inside
        // its own worktree (worktrees live UNDER .spicyspec/), was misread as no-progress
        // and wrongly parked.
        protectedPathExceptions: [cfg.parkedPath, cfg.gateExportPath, '.spicyspec/worktrees/'],
      };
    },

    snapshot: (input) => snapshotFn(input),

    // The review bridge: a manager's dashboard decision (store-KV intent) reaches the
    // parked workflow through this poll. Consumed AT MOST ONCE, and through the marker the
    // ROTATION shares — a decision this bridge spends must not still read as live evidence
    // to the promotion pass months later (see review-consumption.ts).
    async checkReviewDecision(specId) {
      const decision = await readReviewDecision(deps.store, specId);
      if (!decision) return null;
      if (!(await consumeReviewDecision(deps.store, specId, decision))) return null;
      return { approved: decision.approved, note: decision.note, by: decision.by };
    },

    async openSessionLog(input) {
      const queueNow = await deps.store.loadQueue();
      const entry = queueNow.entries.find((e) => e.id === input.specId);
      return openSessionLogDir(runsRootFor(cfg.repoCwd), {
        number: input.run,
        spec: input.specId,
        stage: entry?.stage ?? 'execute',
        account: leasedAccountBySpec.get(input.specId) ?? 'unknown',
        startedAt: new Date().toISOString(),
      });
    },

    async onClassified(cls, accountId, evidence, input) {
      // The session is over — free the account for the next concurrent packet build.
      await deps.store.release(`account:lease:${accountId}`).catch(() => undefined);
      leasedAccountBySpec.delete(input.specId);
      await settlePool(deps, cls, accountId);

      // Second-vendor honesty check — evidence first, story second. A dead chain is
      // recorded, never silent (C3), and never blocks the run it was judging.
      const providers =
        deps.judgeProviders ??
        cfg.judges.map((j) => cliJudgeProvider({ id: j.id, bin: j.bin, args: j.args, timeoutMs: j.timeoutMs }));
      let judged: JudgeResult | null = null;
      if (providers.length) {
        const prompt = buildJudgePrompt({
          projectName: cfg.projectName,
          specId: input.specId,
          runNumber: input.run,
          classification: {
            exit: cls.exit,
            commits: cls.commits,
            tasksClosed: cls.tasksClosed,
            costUsd: cls.costUsd,
            costKnown: cls.costKnown,
          },
          harvest: evidence.harvest,
          workerText: evidence.workerText,
        });
        judged = await (deps.judgeChainFn ?? judgeChain)(providers, prompt);
        await deps.store.setKv(judgeKey(input.specId), JSON.stringify(judged));
      }

      // Retry identity (the prototype ledger's `attempt` tag, driver.mjs:804-877): an
      // infra attempt keeps its run number and is retried, so two rows can share a tick.
      // Without the tag the report counted the same run twice and the founder could not
      // tell a real run from an infra retry in the tick table.
      const attempt =
        cls.exit === 'rate-limited'
          ? 'rate-limited-retry'
          : cls.exit === 'account-refused'
            ? 'account-refused-retry'
            : cls.exit === 'no-attempt'
              ? 'no-attempt-retry'
              : null;

      // The control room reads every field below off the run row and has no other source
      // for any of them. Five were missing, so five numbers were STRUCTURALLY zero or '—'
      // no matter what the run did: minutes and the minutes total, the HEAD link, the start
      // time, the account panel's rate/utilization/window chips, and the redFirst column.
      // Readers use `?? null`, so the row stays backward compatible with rows written before
      // these existed — absence means unknown there, never clean.
      const durationMinutes = durationMinutesFor(cls.turns);
      await deps.store.appendRun({
        tick: input.run,
        attempt,
        spec: input.specId,
        exit: cls.exit,
        costUsd: cls.costUsd,
        tasksClosed: cls.tasksClosed,
        commits: cls.commits,
        overageStatus: cls.overageStatus,
        usedOverage: cls.usedOverage,
        account: accountId,
        // Same value the compat LEDGER row below carries: computed once so the two surfaces
        // cannot state different durations for one run.
        durationMinutes,
        startedAt: evidence.startedAt,
        head: evidence.head,
        rateStatus: cls.rateStatus,
        utilization: cls.utilization,
        rateResetsAt: cls.rateResetsAt,
        // Handed to the judge since harvest existed, and to nobody else — so the room's
        // redFirst column rendered '—' (unknown) forever, including on the clean runs where
        // an empty list is the answer.
        redFirstResidue: evidence.harvest.redFirstResidue,
        judgedBy: judged?.judgedBy ?? null,
        judgeHonest: judged?.verdict?.honest ?? null,
        judgeAction: judged?.verdict?.action ?? null,
        judgeFailures: judged?.failures?.length ?? 0,
      });

      // Loop Control Room view: ledger row + accounts mirror (read-only projections).
      if (cfg.compatLoopDir) {
        const compat = { repoCwd: cfg.repoCwd, loopDir: cfg.compatLoopDir };
        const queueNow = await deps.store.loadQueue();
        const entry = queueNow.entries.find((e) => e.id === input.specId);
        await appendLedgerView(deps.store, compat, {
          exit: cls.exit,
          costUsd: cls.costUsd,
          tasksClosed: cls.tasksClosed,
          account: accountId,
          specId: input.specId,
          stage: entry?.stage ?? 'execute',
          durationMinutes,
          head: evidence.head ?? undefined,
          // The ORIGINAL room derives its `window HH:MM` chip from the last LEDGER row's
          // rateResetsAt (ui/server.mjs:619) — the field was never written, so that chip
          // could not render over this engine.
          rateResetsAt: cls.rateResetsAt,
          note: `run ${input.run} of spec ${input.specId}`,
        }).catch(() => undefined);
        await exportAccountsView(deps.store, compat).catch(() => undefined);
      }
    },
  };

  return createActivities(activityDeps);
}

/**
 * EVERY activity the Temporal worker must register — spec-run AND queue rotation.
 *
 * Found by the first real ignition: startRunner registered only the spec-run set, so the
 * rotation failed in 16 seconds with "openNextSpec is not registered". The rotation smoke
 * had masked it by composing the two sets by hand. One composition function now, used by
 * the production entry and the smokes alike — a wiring that only tests exercise is not
 * wired.
 */
export function createAllActivities(deps: RunnerDeps) {
  return {
    ...createRunnerActivities(deps),
    ...createQueueActivities({ runner: deps, pipeline: deps.pipeline }),
  };
}
