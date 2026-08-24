/**
 * Runner configuration — zod at the boundary (RFC-001 §4): a typo is a startup error,
 * never a silent misbehavior. Secrets never live here; they are merged at load from the
 * runner's local secret file (gitignored), exactly like the prototype's account split.
 */
import { isAbsolute, resolve } from 'node:path';
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
   * In-session watchdog — kills a live-but-wedged session so the run scores as a
   * CLASSIFIED exit (hung/stalled/timed-out) instead of an activity timeout the retry
   * policy re-runs a dozen times. Defaults are the prototype's tuned values
   * (driver.mjs:462-513), learned on its tick 4: a stall requires BOTH no forward
   * progress over a long horizon AND the worker being quiet right now — an integration
   * tier is legitimately silent for ~12 minutes while healthy.
   */
  watchdog: z
    .object({
      /** hard backstop for "alive but achieving nothing" (prototype maxTickMinutes) */
      maxRunMinutes: z.number().positive().default(240),
      /** no stream event at all for this long — the session is wedged */
      hangMinutes: z.number().positive().default(30),
      /** no commit for this long ... */
      stallMinutes: z.number().positive().default(90),
      /** ... AND no stream event for this long — both required (B6) */
      quietMinutes: z.number().positive().default(12),
      pollSeconds: z.number().positive().default(60),
    })
    .default({ maxRunMinutes: 240, hangMinutes: 30, stallMinutes: 90, quietMinutes: 12, pollSeconds: 60 }),
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
  /**
   * The self-healing supervisor (`spicyspec-runner supervise`).
   *
   * Written after a night the loop spent dead: Temporal, the runner and the dashboard were
   * bare background processes of one shell with no service and no restart, an agent-armed
   * STOP was never cleared, and the rotation workflow had been cancelled. Three independent
   * single points of failure, none of them watched. Every knob here exists so a machine
   * that cannot run one of those processes (no Temporal binary, no dashboard) can turn that
   * repair OFF and still get the others.
   */
  supervise: z
    .object({
      /** false ⇒ report Temporal unreachable instead of starting it */
      manageTemporal: z.boolean().default(true),
      /** a REAL executable — the supervisor spawns without a shell, so no npm/batch shim (B4) */
      temporalBin: z.string().default('temporal'),
      /** null ⇒ derive `server start-dev --db-filename <repoCwd>/.spicyspec/temporal.db --ui-port <port>` */
      temporalArgs: z.array(z.string()).nullable().default(null),
      temporalUiPort: z.number().int().min(1).max(65535).default(8233),
      /** how long a spawned dependency has to answer before the repair counts as failed */
      startTimeoutMs: z.number().int().positive().default(60_000),
      autostartWorker: z.boolean().default(true),
      autostartRotation: z.boolean().default(true),
      /** probed and restarted when set; null ⇒ this machine hosts no control room */
      dashboardPort: z.number().int().min(1).max(65535).nullable().default(null),
      /** a heartbeat older than this is a DEAD worker — liveness is never a record's existence (B17) */
      workerStaleMs: z.number().int().positive().default(90_000),
      /** an AGENT's stop older than this is swept; a founder's is never swept, at any age */
      agentStopTtlMinutes: z.number().positive().default(30),
      intervalSeconds: z.number().positive().default(60),
      /** per-check exponential backoff after a failed repair — never a spawn storm */
      backoffSeconds: z.number().positive().default(30),
      backoffMaxSeconds: z.number().positive().default(900),
      /** detached children write their output here (relative to repoCwd) */
      logDir: z.string().default('.spicyspec/logs'),
    })
    .default({
      manageTemporal: true,
      temporalBin: 'temporal',
      temporalArgs: null,
      temporalUiPort: 8233,
      startTimeoutMs: 60_000,
      autostartWorker: true,
      autostartRotation: true,
      dashboardPort: null,
      workerStaleMs: 90_000,
      agentStopTtlMinutes: 30,
      intervalSeconds: 60,
      backoffSeconds: 30,
      backoffMaxSeconds: 900,
      logDir: '.spicyspec/logs',
    }),
});

export type RunnerConfig = z.infer<typeof RUNNER_CONFIG>;
export type AccountConfigInput = z.infer<typeof ACCOUNT_CONFIG>;

/**
 * @param baseDir when given, relative `repoCwd` and `storePath` resolve against it — the
 * CONFIG FILE's directory, never the process cwd. A rotation launched from another
 * directory once opened a fresh empty store and reported the queue "drained" in 0 runs;
 * where a command is run from must never change which project it acts on. (`handoffPath`,
 * `specsDir`, `compatLoopDir` stay relative to `repoCwd` by contract.)
 */
export function parseRunnerConfig(raw: unknown, baseDir?: string): RunnerConfig {
  const result = RUNNER_CONFIG.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid runner config — ${detail}`);
  }
  const config = result.data;
  if (baseDir) {
    if (!isAbsolute(config.repoCwd)) config.repoCwd = resolve(baseDir, config.repoCwd);
    if (!config.storePath.startsWith('postgres://') && !isAbsolute(config.storePath)) {
      config.storePath = resolve(baseDir, config.storePath);
    }
  }
  return config;
}
