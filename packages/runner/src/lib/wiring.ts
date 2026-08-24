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
import { snapshot, type FullSnapshot } from './git-snapshot.js';

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

  const snapshotFn =
    deps.snapshotFn ??
    ((input: WorkerRunInput) =>
      snapshot({
        cwd: cfg.repoCwd,
        tasksFile: `${cfg.repoCwd}/specs/${input.specId}/tasks.md`,
        handoffFile: `${cfg.repoCwd}/HANDOFF.md`,
        // B2: the runner's own state (the store, parked file) must never dirty the tree
        selfOwnedPaths: cfg.worker.protectedPaths,
      }));

  let lastInput: WorkerRunInput = { specId: 'unknown', run: 0 };

  const activityDeps: ActivityDeps = {
    provider: deps.provider,

    async buildPacket(input: WorkerRunInput) {
      lastInput = input;
      const pool = await loadPoolFromStore(deps);
      const nowMs = deps.nowMs ?? Date.now;
      const account = pickAccount(pool, nowMs());
      if (!account) {
        // The activity fails; Temporal's retry policy re-runs it after backoff — the
        // durable equivalent of the prototype's sleep-to-earliest-reset.
        throw new NoWarmAccountError(earliestWarmMs(pool), describePool(pool, nowMs()));
      }

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
          { what: '`HANDOFF.md`', why: 'the baton — position, gate state, traps. Verify against the tree.' },
          { what: `\`specs/${input.specId}/tasks.md\``, why: 'your work list. The open items are the job.' },
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
        cwd: cfg.repoCwd,
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

    snapshot: () => snapshotFn(lastInput),

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

    async onClassified(cls, accountId, evidence) {
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
          specId: lastInput.specId,
          runNumber: lastInput.run,
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
        await deps.store.setKv(judgeKey(lastInput.specId), JSON.stringify(judged));
      }

      await deps.store.appendRun({
        tick: lastInput.run,
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
    },
  };

  return createActivities(activityDeps);
}
