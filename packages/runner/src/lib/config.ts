/**
 * Runner configuration — zod at the boundary (RFC-001 §4): a typo is a startup error,
 * never a silent misbehavior. Secrets never live here; they are merged at load from the
 * runner's local secret file (gitignored), exactly like the prototype's account split.
 */
import { z } from 'zod';

export const ACCOUNT_CONFIG = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  enabled: z.boolean().default(true),
  env: z.record(z.string(), z.string()).default({}),
  configDir: z.string().nullable().default(null),
});

export const RUNNER_CONFIG = z.object({
  projectName: z.string().min(1),
  /** repository the workers build in */
  repoCwd: z.string().min(1),
  /** Temporal connection */
  temporal: z
    .object({
      address: z.string().default('localhost:7233'),
      namespace: z.string().default('default'),
      taskQueue: z.string().default('spicyspec'),
    })
    .default({ address: 'localhost:7233', namespace: 'default', taskQueue: 'spicyspec' }),
  /** runner-local state database */
  storePath: z.string().default('.spicyspec/runner.db'),
  worker: z
    .object({
      model: z.string().optional(),
      effort: z.string().optional(),
      disallowedTools: z.array(z.string()).default([]),
      /** ENFORCED via the provider's permission hook, and named in the packet */
      protectedPaths: z.array(z.string()).default(['.spicyspec/']),
    })
    .default({ disallowedTools: [], protectedPaths: ['.spicyspec/'] }),
  accounts: z.array(ACCOUNT_CONFIG).min(1),
  /**
   * Second-vendor judge chain, tried in order — plural on purpose: the prototype's
   * single-vendor tracker died to a quota mid-run and the honesty check silently
   * vanished. `bin` must be a REAL executable (node.exe + script args), never a bare
   * npm shim (prototype B4).
   */
  judges: z
    .array(
      z.object({
        id: z.string().min(1),
        bin: z.string().min(1),
        args: z.array(z.string()).default([]),
        timeoutMs: z.number().int().positive().default(300_000),
      }),
    )
    .default([]),
  /** review backlog cap — how many specs may wait on a human before the loop idles */
  maxAwaitingReview: z.number().int().positive().default(3),
  /**
   * Concurrent specs — one isolated git worktree + one reserved account each. 1 = the
   * single-writer default; raise toward your account count for parallel throughput.
   */
  maxParallelSpecs: z.number().int().positive().default(1),
  /**
   * Where the loop reaches a human. The prototype's dominant waste — 91% of all idle —
   * was a run waiting on a person who did not know they were being waited on.
   */
  notify: z
    .object({
      channels: z
        .array(
          z.discriminatedUnion('type', [
            z.object({ type: z.literal('ntfy'), topic: z.string().min(1), server: z.string().optional() }),
            z.object({ type: z.literal('webhook'), url: z.string().url() }),
          ]),
        )
        .default([]),
    })
    .default({ channels: [] }),
  /** where gate verdicts are exported for the git-auditable trail */
  gateExportPath: z.string().default('.spicyspec/gates.jsonl'),
  parkedPath: z.string().default('.spicyspec/PARKED.md'),
  /** the baton file whose mtime marks a handoff update (Airvia keeps it at .specify/HANDOFF.md) */
  handoffPath: z.string().default('HANDOFF.md'),
  /** where spec directories live; a spec id matches `<id>` or `<id>-<slug>` */
  specsDir: z.string().default('specs'),
  /**
   * Loop Control Room compatibility: when set (e.g. `.specify/loop`), the runner projects
   * QUEUE.json / LEDGER.jsonl / ACCOUNTS.json / RUN.lock into that directory so the
   * original control-room UI keeps working over the new engine. The store stays the truth;
   * the files are read-only views.
   */
  compatLoopDir: z.string().nullable().default(null),
});

export type RunnerConfig = z.infer<typeof RUNNER_CONFIG>;
export type AccountConfigInput = z.infer<typeof ACCOUNT_CONFIG>;

export function parseRunnerConfig(raw: unknown): RunnerConfig {
  const result = RUNNER_CONFIG.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid runner config — ${detail}`);
  }
  return result.data;
}
