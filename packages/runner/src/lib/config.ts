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
  /** where gate verdicts are exported for the git-auditable trail */
  gateExportPath: z.string().default('.spicyspec/gates.jsonl'),
  parkedPath: z.string().default('.spicyspec/PARKED.md'),
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
