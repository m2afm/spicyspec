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
  pickAccount,
  poolState,
  recordUse,
  type Classification,
  type Pool,
} from '@spicyspec/core';
import { readReviewDecision } from '@spicyspec/control-plane';
import { buildJudgePrompt, cliJudgeProvider, judgeChain, type JudgeProvider, type JudgeResult } from '@spicyspec/judge';
import { createActivities, type ActivityDeps, type SpecRunActivities, type WorkerRunInput } from '@spicyspec/orchestrator';
import { buildPacket, specDrivenPipeline, type PacketContext, type PipelineDefinition, type PredecessorVerdict } from '@spicyspec/pipeline';
import { packSectionsFor, type GatePack } from '@spicyspec/packs';
import type { ProviderAdapter } from '@spicyspec/provider';
import type { Store } from '@spicyspec/store';
import type { RunnerConfig } from './config.js';
import { appendLedgerView, exportAccountsView } from './compat-view.js';
import { createQueueActivities } from './queue-activities.js';
import { snapshot, type FullSnapshot } from './git-snapshot.js';
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

const judgeKey = (specId: string) => `judge:last:${specId}`;

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

export class NoWarmAccountError extends Error {
  constructor(public readonly earliestWarmAtMs: number | null, poolDescription: string) {
    super(`every account is cold (${poolDescription})`);
    this.name = 'NoWarmAccountError';
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

    async buildPacket(input: WorkerRunInput) {
      const pool = await loadPoolFromStore(deps);
      const nowMs = deps.nowMs ?? Date.now;

      // Lease an account: with N concurrent sessions, N packet builds race — pickAccount
      // alone would triple-book the least-used one. tryReserve is the atomic claim; a
      // lease older than 6h is stale (its holder died mid-run) and is broken.
      let account = null as ReturnType<typeof pickAccount>;
      const leased = new Set<string>();
      for (const candidate of [...pool.accounts].sort((a, b) => a.uses - b.uses)) {
        if (candidate.coldUntilMs > nowMs()) continue;
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
        // The activity fails; Temporal's retry re-runs it after backoff — the durable
        // equivalent of the prototype's sleep-to-earliest-reset.
        throw new NoWarmAccountError(
          earliestWarmMs(pool),
          describePool(pool, nowMs()) + (leased.size ? ` · leased: ${[...leased].join(',')}` : ''),
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
        // The one file inside protected space the packet PROMISES append access to —
        // the hook must honor the promise (B25 mirrored).
        protectedPathExceptions: [cfg.parkedPath],
      };
    },

    snapshot: (input) => snapshotFn(input),

    // The review bridge: a manager's dashboard decision (store-KV intent) reaches the
    // parked workflow through this poll. Delivered AT MOST ONCE — the delivery marker
    // pins the decision's own timestamp, so a NEW decision (different `at`) delivers
    // again while a retried poll of the same one does not.
    async checkReviewDecision(specId) {
      const decision = await readReviewDecision(deps.store, specId);
      if (!decision) return null;
      const deliveredKey = `review:delivered:${specId}`;
      if ((await deps.store.getKv(deliveredKey)) === decision.at) return null;
      await deps.store.setKv(deliveredKey, decision.at);
      return { approved: decision.approved, note: decision.note, by: decision.by };
    },

    async openSessionLog(input) {
      const queueNow = await deps.store.loadQueue();
      const entry = queueNow.entries.find((e) => e.id === input.specId);
      return openSessionLogDir(`${cfg.repoCwd}/.spicyspec/runs`, {
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

      await deps.store.appendRun({
        tick: input.run,
        spec: input.specId,
        exit: cls.exit,
        costUsd: cls.costUsd,
        tasksClosed: cls.tasksClosed,
        commits: cls.commits,
        overageStatus: cls.overageStatus,
        usedOverage: cls.usedOverage,
        account: accountId,
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
          durationMinutes: Math.max(1, Math.round(cls.turns / 3)),
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
