/**
 * The supervisor — the thing that was missing the night the loop died.
 *
 * What actually happened: the founder left the rotation running and found it dead ~8 hours
 * later, from two independent causes. (1) A STOP flag armed in the store by an AGENT was
 * never cleared, and the rotation workflow had been CANCELED — so even a live worker would
 * have halted at openNextSpec. (2) NOTHING supervised the processes: `temporal server
 * start-dev`, `spicyspec-runner start` and `spicyspec-runner dashboard` were bare
 * background processes of one shell, with no service, no scheduled task and no restart. Any
 * crash, reboot or terminal teardown was permanent death.
 *
 * So: one cycle, six checks, in dependency order, each of which REPAIRS what it finds
 * broken and is a no-op when it is healthy. Every repair is recorded in the store and
 * pushed to the notify channels; a healthy cycle is silent, because a supervisor that
 * notifies on success is a supervisor whose notifications get muted.
 *
 * Three rules keep self-healing from becoming its own outage:
 *   - a single-instance store lock, so two supervisors never race to spawn the same process;
 *   - per-check exponential backoff, so a permanently-broken dependency is retried on a
 *     widening interval instead of spawned every minute all night;
 *   - each check is independently try/caught, so one throwing check cannot take the cycle —
 *     and with it the other five repairs — down with it.
 */
import { notifyAll, type Notification, type NotifyChannel } from '@spicyspec/notify';
import { listRunners, type Store } from '@spicyspec/store';
import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRunnerConfig, type RunnerConfig } from './config.js';
import { sweepStaleAgentFlags } from './control-flags.js';
import { spawnDetached, type SpawnDetachedFn } from './detached-spawn.js';
import {
  appendHealthEvents,
  writeHealthCycle,
  writeSupervisorBeat,
  type HealthCheck,
  type HealthCycle,
  type HealthEvent,
  type HealthStatus,
} from './health.js';
import { notifyChannelsFor } from './notify-channels.js';
import { openConfiguredStore } from './open-store.js';
import { rotationWorkflowId } from './rotation-id.js';
import { sweepOrphanedLeases } from './wiring.js';

/** One supervisor per project store; the value carries the holder so a dead one is takeable. */
export const SUPERVISOR_LOCK_KEY = 'supervisor:lock';

/**
 * Backoff state, in the STORE rather than in memory. Named under `supervisor:` and NOT
 * `health:` on purpose — the control room sweeps the whole `health:` prefix to build its
 * panel, and a state blob parked there is read as a report nobody wrote. The scheduled task runs
 * `supervise --once` — a fresh process every interval — so a per-process Map reset on every
 * sweep and the documented "30s doubling to 15 min, never a spawn storm" was inert exactly
 * where it mattered: a dependency slower than its start budget got a brand-new spawn every
 * few minutes, all night, with nothing recording the pile-up.
 */
export const SUPERVISOR_GUARDS_KEY = 'supervisor:guards';

/**
 * A supervisor rewrites the lock every cycle. Three missed refreshes means it is gone — the
 * same shape as the worker-liveness rule (a fresh heartbeat, never a record's existence).
 * Without an expiry, a lock leaked by a host that later went away could never be taken and
 * supervision wedged permanently and silently — the outage this feature exists to end.
 */
const LOCK_STALE_AFTER_MS = 10 * 60_000;

export interface RotationState {
  running: boolean;
  /** the Temporal status name, or NOT_FOUND — quoted in the health record */
  detail: string;
}

export type ProbeFn = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

export interface SupervisorDeps {
  config: RunnerConfig;
  store: Store;
  /** absolute path; handed to every subcommand the supervisor spawns */
  configPath: string;
  /** the runner CLI entry the spawned subcommands run (dist/bin.js) */
  runnerBin?: string;
  nodeBin?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  probePort?: ProbeFn;
  spawnFn?: SpawnDetachedFn;
  describeRotationFn?: () => Promise<RotationState>;
  dispatchRotationFn?: () => Promise<void>;
  sweepLeasesFn?: (store: Store) => Promise<string[]>;
  notifyChannels?: NotifyChannel[];
  isPidAlive?: (pid: number) => boolean;
  host?: string;
  pid?: number;
  /** overrides config.supervise.intervalSeconds (the CLI's --interval) */
  intervalMs?: number;
  log?: (line: string) => void;
}

export interface Supervisor {
  /** run every check once, repairing what is broken */
  cycle(): Promise<HealthCycle>;
  /** cycle forever (or `maxCycles` times), sleeping the configured interval between */
  loop(options?: { maxCycles?: number }): Promise<void>;
  /** wake a sleeping loop and end it after the current cycle */
  stop(): void;
  /** hand the single-instance lock back */
  release(): Promise<void>;
}

/* ----------------------------------------------------------------- defaults ---- */

/**
 * NOT unref'd, deliberately. An unref'd timer does not hold the event loop open, and on the
 * default SQLite store nothing else does (node:sqlite is synchronous, spawned children are
 * unref'd, the probe socket only exists after the sleep resolves) — so the process EXITED
 * mid-await with code 0. Live consequence: `supervise --interval 5` ran exactly one cycle in
 * one second, and every real process repair died at its first wait, recording nothing,
 * notifying nobody, leaking the lock, and reporting success. The supervisor's whole job is
 * to still be there later; a timer that lets the process die is the one bug it cannot have.
 */
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A TCP connect is the whole probe: a port that accepts is a server that is up. */
export const probeTcp: ProbeFn = (host, port, timeoutMs) =>
  new Promise((resolvePromise) => {
    const socket = new Socket();
    let settled = false;
    const done = (up: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(up);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });

/** Only ESRCH proves a pid is gone; EPERM means alive and not ours (same rule as the lease sweep). */
function defaultIsPidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function messageOf(err: unknown): string {
  return String((err as Error)?.message ?? err).split('\n')[0].slice(0, 300);
}

function isNotFound(err: unknown): boolean {
  const name = String((err as Error)?.name ?? '');
  return name.includes('NotFound') || /not\s*found/i.test(messageOf(err));
}

export function splitAddress(address: string, fallbackPort: number): { host: string; port: number } {
  const bare = address.replace(/^[a-z]+:\/\//i, '');
  const cut = bare.lastIndexOf(':');
  if (cut < 0) return { host: bare || '127.0.0.1', port: fallbackPort };
  const port = Number(bare.slice(cut + 1));
  return {
    host: bare.slice(0, cut) || '127.0.0.1',
    port: Number.isInteger(port) && port > 0 ? port : fallbackPort,
  };
}

/**
 * Describe the rotation. NotFound, CANCELED, COMPLETED, FAILED and TERMINATED all mean the
 * same thing to a supervisor — nothing is working the queue — and the incident's rotation
 * was in exactly one of those states (CANCELED) behind an otherwise healthy stack.
 */
export async function describeRotation(config: RunnerConfig): Promise<RotationState> {
  const { Client, Connection } = await import('@temporalio/client');
  const connection = await Connection.connect({ address: config.temporal.address });
  try {
    const client = new Client({ connection, namespace: config.temporal.namespace });
    const description = await client.workflow.getHandle(rotationWorkflowId(config.projectName)).describe();
    const status = String(description.status?.name ?? 'UNKNOWN');
    return { running: status === 'RUNNING', detail: status };
  } catch (err) {
    if (isNotFound(err)) return { running: false, detail: 'NOT_FOUND' };
    throw err;
  } finally {
    await connection.close();
  }
}

/**
 * Ignition, shared by the `run` subcommand and the supervisor's rotation repair — one
 * definition so a supervised restart cannot drift from what a founder gets by hand.
 */
export async function dispatchRotation(config: RunnerConfig): Promise<{ workflowId: string; started: boolean }> {
  const { Client, Connection } = await import('@temporalio/client');
  const workflowId = rotationWorkflowId(config.projectName);
  const connection = await Connection.connect({ address: config.temporal.address });
  try {
    const client = new Client({ connection, namespace: config.temporal.namespace });
    await client.workflow.start('queueRunWorkflow', {
      taskQueue: config.temporal.taskQueue,
      workflowId,
      args: [{ maxRunsPerSpec: 40, maxConsecutiveStalls: 2, maxSpecRuns: 200, maxParallelSpecs: config.maxParallelSpecs }],
    });
    return { workflowId, started: true };
  } catch (err) {
    if (String((err as Error).name).includes('WorkflowExecutionAlreadyStarted')) return { workflowId, started: false };
    throw err;
  } finally {
    await connection.close();
  }
}

/** Temporal's dev server, pointed at a db file that survives a reboot. */
export function defaultTemporalArgs(config: RunnerConfig): string[] {
  const { port } = splitAddress(config.temporal.address, 7233);
  const args = [
    'server',
    'start-dev',
    '--db-filename',
    resolve(config.repoCwd, '.spicyspec', 'temporal.db'),
    '--ui-port',
    String(config.supervise.temporalUiPort),
  ];
  // start-dev listens on 7233 by default; only a non-default address needs to say so.
  if (port !== 7233) args.push('--port', String(port));
  return args;
}

/* -------------------------------------------------------------- supervisor ---- */

interface Guard {
  failures: number;
  nextAttemptMs: number;
  detail: string;
}

interface CheckOutcome {
  event: HealthEvent;
  /** false for observations that repeat every cycle — they would flood the ring */
  record: boolean;
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const config = deps.config;
  const supervise = config.supervise;
  const store = deps.store;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const probe = deps.probePort ?? probeTcp;
  const spawnFn = deps.spawnFn ?? spawnDetached;
  const sweepLeases = deps.sweepLeasesFn ?? sweepOrphanedLeases;
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const channels = deps.notifyChannels ?? notifyChannelsFor(config);
  const host = deps.host ?? hostname();
  const pid = deps.pid ?? process.pid;
  const intervalMs = deps.intervalMs ?? supervise.intervalSeconds * 1000;
  // eslint-disable-next-line no-console
  const log = deps.log ?? ((line: string) => console.log(line));
  const nodeBin = deps.nodeBin ?? process.execPath;
  const runnerBin = deps.runnerBin ?? fileURLToPath(new URL('../bin.js', import.meta.url));
  const logDir = resolve(config.repoCwd, supervise.logDir);
  const temporalAddress = splitAddress(config.temporal.address, 7233);

  const guards = new Map<HealthCheck, Guard>();
  let holdsLock = false;
  let stopped = false;
  let wake: (() => void) | null = null;

  const iso = () => new Date(now()).toISOString();
  const mk = (check: HealthCheck, status: HealthStatus, detail: string): HealthEvent => ({
    at: iso(),
    check,
    status,
    detail,
  });

  function noteFailure(check: HealthCheck, detail: string): void {
    const failures = (guards.get(check)?.failures ?? 0) + 1;
    const delayMs = Math.min(supervise.backoffSeconds * 1000 * 2 ** (failures - 1), supervise.backoffMaxSeconds * 1000);
    guards.set(check, { failures, nextAttemptMs: now() + delayMs, detail });
  }

  /** Poll until `ready`, spending at most `budgetMs`: 0.5s, 1s, 2s, 4s, 8s, 8s… */
  async function waitFor(ready: () => Promise<boolean>, budgetMs: number): Promise<number | null> {
    let waited = 0;
    let delay = 500;
    while (waited < budgetMs) {
      const step = Math.min(delay, budgetMs - waited);
      await sleep(step);
      waited += step;
      if (await ready()) return waited;
      delay = Math.min(delay * 2, 8_000);
    }
    return null;
  }

  const spawnRunnerSubcommand = (args: string[], logName: string) =>
    spawnFn({
      command: nodeBin,
      args: [runnerBin, ...args, '--config', deps.configPath],
      cwd: config.repoCwd,
      logDir,
      logName,
    });

  /* ------------------------------------------------------------ the checks ---- */

  const temporalUp = () => probe(temporalAddress.host, temporalAddress.port, 2_000);

  async function checkTemporal(): Promise<HealthEvent> {
    if (await temporalUp()) return mk('temporal', 'ok', `reachable at ${config.temporal.address}`);
    if (!supervise.manageTemporal) {
      return mk(
        'temporal',
        'failed',
        `${config.temporal.address} is unreachable and manageTemporal is false — start Temporal yourself`,
      );
    }
    const args = supervise.temporalArgs ?? defaultTemporalArgs(config);
    const spawnedPid = await spawnFn({
      command: supervise.temporalBin,
      args,
      cwd: config.repoCwd,
      logDir,
      logName: 'temporal',
    });
    const waited = await waitFor(temporalUp, supervise.startTimeoutMs);
    if (waited === null) {
      return mk(
        'temporal',
        'failed',
        `spawned ${supervise.temporalBin} (pid ${spawnedPid ?? 'none'}) but ${config.temporal.address} never answered within ${supervise.startTimeoutMs}ms — see ${logDir}/temporal.log`,
      );
    }
    return mk(
      'temporal',
      'repaired',
      `${config.temporal.address} was down; spawned ${supervise.temporalBin} (pid ${spawnedPid ?? 'unknown'}), reachable after ${waited}ms`,
    );
  }

  /** Liveness is a FRESH heartbeat, never the record's existence (prototype B17). */
  async function freshRunners(): Promise<string[]> {
    const at = now();
    return (await listRunners(store, at))
      .filter((r) => r.taskQueue === config.temporal.taskQueue)
      .filter((r) => at - Date.parse(r.heartbeatAt) < supervise.workerStaleMs)
      .map((r) => r.id);
  }

  async function checkWorker(): Promise<HealthEvent> {
    const alive = await freshRunners();
    if (alive.length) return mk('worker', 'ok', `${alive.length} runner(s) heartbeating: ${alive.join(', ')}`);
    if (!supervise.autostartWorker) {
      return mk('worker', 'failed', `no runner has heartbeat in ${supervise.workerStaleMs}ms and autostartWorker is false`);
    }
    const spawnedPid = await spawnRunnerSubcommand(['start'], 'runner');
    const waited = await waitFor(async () => (await freshRunners()).length > 0, supervise.startTimeoutMs);
    if (waited === null) {
      return mk(
        'worker',
        'failed',
        `spawned the runner (pid ${spawnedPid ?? 'none'}) but no heartbeat appeared within ${supervise.startTimeoutMs}ms — see ${logDir}/runner.log`,
      );
    }
    return mk(
      'worker',
      'repaired',
      `no fresh heartbeat; spawned the runner (pid ${spawnedPid ?? 'unknown'}), heartbeating after ${waited}ms`,
    );
  }

  async function checkRotation(): Promise<HealthEvent> {
    const workflowId = rotationWorkflowId(config.projectName);
    const state = await (deps.describeRotationFn ?? (() => describeRotation(config)))();
    if (state.running) return mk('rotation', 'ok', `${workflowId} is RUNNING`);
    if (!supervise.autostartRotation) {
      return mk('rotation', 'failed', `${workflowId} is ${state.detail} and autostartRotation is false`);
    }
    await (deps.dispatchRotationFn ?? (async () => void (await dispatchRotation(config))))();
    return mk('rotation', 'repaired', `${workflowId} was ${state.detail} — dispatched a fresh rotation`);
  }

  async function checkStopFlags(): Promise<HealthEvent> {
    const sweep = await sweepStaleAgentFlags(store, {
      nowMs: now(),
      ttlMs: supervise.agentStopTtlMinutes * 60_000,
    });
    const held = sweep.held.map((f) => `${f.key} armed by ${f.armedBy}${f.armedAt ? ` at ${f.armedAt}` : ''}`).join('; ');
    if (sweep.cleared.length) {
      const cleared = sweep.cleared
        .map((f) => `${f.key} (armed by an agent${f.armedAt ? ` at ${f.armedAt}` : ', undated'})`)
        .join('; ');
      return mk(
        'stop-flags',
        'repaired',
        `cleared ${cleared} — older than the ${supervise.agentStopTtlMinutes}-minute agent TTL${held ? `; still armed: ${held}` : ''}`,
      );
    }
    if (sweep.held.length) {
      // Reported, never cleared: a founder's stop is the one thing self-healing must not
      // undo. The room reads this to say WHY the loop is idle instead of showing it dead.
      return mk('stop-flags', 'blocked', `${held} — the rotation is idle by request; clear it from the control room`);
    }
    return mk('stop-flags', 'ok', 'no stop or kill flag armed');
  }

  async function checkLeases(): Promise<HealthEvent> {
    const swept = await sweepLeases(store);
    if (!swept.length) return mk('leases', 'ok', 'no orphaned account leases');
    return mk('leases', 'repaired', `released ${swept.length} orphaned account lease(s): ${swept.join(', ')}`);
  }

  async function checkDashboard(): Promise<HealthEvent | null> {
    const port = supervise.dashboardPort;
    if (port === null) return null;
    const up = () => probe('127.0.0.1', port, 2_000);
    if (await up()) return mk('dashboard', 'ok', `reachable on 127.0.0.1:${port}`);
    const spawnedPid = await spawnRunnerSubcommand(['dashboard', '--port', String(port)], 'dashboard');
    const waited = await waitFor(up, supervise.startTimeoutMs);
    if (waited === null) {
      return mk(
        'dashboard',
        'failed',
        `spawned the dashboard (pid ${spawnedPid ?? 'none'}) but 127.0.0.1:${port} never answered within ${supervise.startTimeoutMs}ms — see ${logDir}/dashboard.log`,
      );
    }
    return mk(
      'dashboard',
      'repaired',
      `127.0.0.1:${port} was down; spawned the dashboard (pid ${spawnedPid ?? 'unknown'}), reachable after ${waited}ms`,
    );
  }

  /* ------------------------------------------------------------ the harness ---- */

  async function guarded(check: HealthCheck, fn: () => Promise<HealthEvent | null>): Promise<CheckOutcome | null> {
    const guard = guards.get(check);
    if (guard && now() < guard.nextAttemptMs) {
      const seconds = Math.ceil((guard.nextAttemptMs - now()) / 1000);
      return {
        event: mk(
          check,
          'failed',
          `still broken after ${guard.failures} repair attempt(s); next attempt in ${seconds}s — last failure: ${guard.detail}`,
        ),
        record: false,
      };
    }
    try {
      const event = await fn();
      if (event === null) return null;
      if (event.status === 'failed') noteFailure(check, event.detail);
      else guards.delete(check);
      return { event, record: event.status === 'repaired' || event.status === 'failed' };
    } catch (err) {
      // One check's exception must never cost the other five their repairs.
      const detail = `the check itself threw: ${messageOf(err)}`;
      noteFailure(check, detail);
      return { event: mk(check, 'failed', detail), record: true };
    }
  }

  /**
   * Claim the single-instance lock, taking over from a holder this machine can prove is
   * dead — the same stale-pid takeover the account leases use. Without it, two supervisors
   * would each spawn a Temporal and a runner while each watched the other's processes fail
   * to be the ones it started.
   */
  async function ensureLock(): Promise<{ acquired: boolean; detail: string }> {
    if (holdsLock) {
      // Refresh the stamp: the takeover rule above reads it as proof of life.
      await store.setKv(SUPERVISOR_LOCK_KEY, JSON.stringify({ pid, host, at: iso() }));
      return { acquired: true, detail: 'lock held' };
    }
    const value = JSON.stringify({ pid, host, at: iso() });
    if (await store.tryReserve(SUPERVISOR_LOCK_KEY, value)) {
      holdsLock = true;
      return { acquired: true, detail: `lock taken by pid ${pid} on ${host}` };
    }
    const raw = await store.getKv(SUPERVISOR_LOCK_KEY);
    let holder: { pid?: number; host?: string; at?: string } = {};
    try {
      holder = raw ? (JSON.parse(raw) as typeof holder) : {};
    } catch {
      holder = {};
    }
    // A holder on another machine cannot be proven dead by pid — but it CAN be proven
    // absent: a live supervisor rewrites this row every cycle, so a stamp older than
    // LOCK_STALE_AFTER_MS means nobody is supervising.
    const stampMs = holder.at ? Date.parse(holder.at) : NaN;
    const expired = !Number.isFinite(stampMs) || now() - stampMs > LOCK_STALE_AFTER_MS;
    const dead = typeof holder.pid !== 'number' || (holder.host === host && !isPidAlive(holder.pid)) || expired;
    if (dead) {
      await store.release(SUPERVISOR_LOCK_KEY);
      if (await store.tryReserve(SUPERVISOR_LOCK_KEY, value)) {
        holdsLock = true;
        const why = expired ? 'a lock that stopped being refreshed' : `dead pid ${holder.pid ?? 'unknown'}`;
        return { acquired: true, detail: `took the lock over from ${why}` };
      }
    }
    return {
      acquired: false,
      detail: `another supervisor holds ${SUPERVISOR_LOCK_KEY} (pid ${holder.pid ?? 'unknown'} on ${holder.host ?? 'unknown host'}) — standing down, spawning nothing`,
    };
  }

  async function announce(events: readonly HealthEvent[]): Promise<void> {
    if (!channels.length) return;
    for (const event of events) {
      const notification: Notification = {
        // The notify vocabulary belongs to the notify package and does not name self-healing:
        // a repair rides the `parked` lane (something needed attention) and a failed repair
        // the `halted` lane (top priority — the loop is down and could not fix itself).
        event: event.status === 'repaired' ? 'parked' : 'halted',
        specId: null,
        title:
          event.status === 'repaired'
            ? `${config.projectName}: supervisor repaired ${event.check}`
            : `${config.projectName}: supervisor CANNOT repair ${event.check}`,
        body: event.detail,
      };
      const result = await notifyAll(channels, notification);
      if (result.failures.length) {
        await store.setKv('notify:last-failures', JSON.stringify({ at: iso(), failures: result.failures }));
      }
    }
  }

  /** Pull the persisted backoff state in; a fresh `--once` process starts with an empty Map. */
  async function loadGuards(): Promise<void> {
    try {
      const raw = await store.getKv(SUPERVISOR_GUARDS_KEY);
      if (!raw) return;
      const rows = JSON.parse(raw) as Array<[HealthCheck, Guard]>;
      if (!Array.isArray(rows)) return;
      for (const [check, guard] of rows) {
        if (guard && typeof guard.nextAttemptMs === 'number') guards.set(check, guard);
      }
    } catch {
      /* a corrupt guard file means no backoff, never a dead cycle */
    }
  }

  async function saveGuards(): Promise<void> {
    try {
      await store.setKv(SUPERVISOR_GUARDS_KEY, JSON.stringify([...guards.entries()]));
    } catch {
      /* bookkeeping must never cost a repair */
    }
  }

  async function cycle(): Promise<HealthCycle> {
    await loadGuards();
    const results: HealthEvent[] = [];
    const recorded: HealthEvent[] = [];
    const push = (outcome: CheckOutcome | null) => {
      if (!outcome) return;
      results.push(outcome.event);
      if (outcome.record) recorded.push(outcome.event);
    };

    const lock = await ensureLock();
    if (!lock.acquired) {
      // Nothing is written from here: a supervisor that is not on duty must not overwrite
      // the on-duty one's report with a one-line document, or a stray `--once` from the
      // scheduled task would blank the room's health panel every few minutes.
      return { at: iso(), healthy: true, events: [mk('lock', 'blocked', lock.detail)] };
    }
    const temporal = await guarded('temporal', checkTemporal);
    push(temporal);
    // A worker or a rotation started against a dead Temporal dies on connect; deferring is
    // what stops the cycle from spawning a runner a minute, all night, into nothing.
    if (temporal?.event.status === 'failed') {
      const why = 'Temporal is unreachable — deferred to the cycle after Temporal comes back';
      push({ event: mk('worker', 'blocked', why), record: false });
      push({ event: mk('rotation', 'blocked', why), record: false });
    } else {
      push(await guarded('worker', checkWorker));
      push(await guarded('rotation', checkRotation));
    }
    push(await guarded('stop-flags', checkStopFlags));
    push(await guarded('leases', checkLeases));
    push(await guarded('dashboard', checkDashboard));

    const report: HealthCycle = {
      at: iso(),
      healthy: results.every((r) => r.status !== 'failed'),
      events: results,
    };
    // Three writes, three different questions the room asks: the ring is the history of what
    // went wrong, the cycle document is the current picture (ok checks included), and the
    // beat is how the room tells "idle" from "nobody has been watching for eight hours".
    await appendHealthEvents(store, recorded);
    await saveGuards();
    await writeHealthCycle(store, report);
    await writeSupervisorBeat(store, { at: report.at, intervalMs, pid, host, healthy: report.healthy });
    await announce(recorded.filter((e) => e.status === 'repaired' || e.status === 'failed'));
    return report;
  }

  async function pause(ms: number): Promise<void> {
    await new Promise<void>((resolvePromise) => {
      // Also NOT unref'd — see realSleep. This timer IS the interval between cycles; if it
      // does not hold the loop open there is no next cycle.
      const timer = setTimeout(() => {
        wake = null;
        resolvePromise();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolvePromise();
      };
    });
  }

  return {
    cycle,

    async loop(options): Promise<void> {
      const max = options?.maxCycles ?? Infinity;
      for (let n = 0; n < max && !stopped; n += 1) {
        const report = await cycle();
        for (const r of report.events) log(`[${r.status}] ${r.check} — ${r.detail}`);
        // A second supervisor exits rather than idling in a loop it can never act in.
        if (report.events.some((r) => r.check === 'lock' && r.status === 'blocked')) return;
        if (stopped || n + 1 >= max) return;
        await pause(intervalMs);
      }
    },

    stop(): void {
      stopped = true;
      wake?.();
    },

    async release(): Promise<void> {
      if (!holdsLock) return;
      holdsLock = false;
      await store.release(SUPERVISOR_LOCK_KEY);
    },
  };
}

/* ------------------------------------------------------------- the command ---- */

export interface SuperviseCommandOptions {
  /** where the sweep appends its own transcript; null disables file logging */
  logPath?: string | null;
  configPath: string;
  once: boolean;
  intervalSeconds: number | null;
  log?: (line: string) => void;
}

/**
 * `spicyspec-runner supervise`. `--once` exits 0 when everything is healthy or was
 * repaired and 1 when something is still broken, which is the contract a Windows scheduled
 * task or a systemd timer reports on — the reboot-survival answer that does not depend on
 * this process staying alive.
 */
/**
 * Append one line to the supervisor's log, tolerantly.
 *
 * The scheduled task used to redirect the whole process with cmd's `>>`. When ANYTHING else
 * held that file — an overlapping sweep, a tail, an editor — the redirect failed before node
 * ever started: the sweep ran no checks, repaired nothing, wrote zero bytes and reported
 * failure with no diagnosis. Reproduced by holding the file open and running the launcher:
 * exit 1, log grew by 0 bytes. Appending per line from inside the process opens and closes
 * around each write, so a concurrent writer costs one line at worst instead of the night.
 */
function appendLogLine(path: string | null, line: string): void {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line + '\n', 'utf8');
  } catch {
    /* a log that cannot be written must never cost a repair */
  }
}

export async function superviseCommand(options: SuperviseCommandOptions): Promise<number> {
  const configPath = resolve(options.configPath);
  const config = parseRunnerConfig(JSON.parse(await readFile(configPath, 'utf8')), dirname(configPath));
  const logPath = options.logPath ?? join(resolve(config.repoCwd, config.supervise.logDir), 'supervisor.log');
  const log =
    options.log ??
    ((line: string) => {
      // eslint-disable-next-line no-console
      console.log(line);
      appendLogLine(logPath, line);
    });
  const store = await openConfiguredStore(config.storePath);
  const supervisor = createSupervisor({
    config,
    store,
    configPath,
    log,
    intervalMs: options.intervalSeconds === null ? undefined : options.intervalSeconds * 1000,
  });
  const stop = () => supervisor.stop();
  try {
    if (options.once) {
      const report = await supervisor.cycle();
      for (const r of report.events) log(`[${r.status}] ${r.check} — ${r.detail}`);
      return report.healthy ? 0 : 1;
    }
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    log(`supervising ${config.projectName} every ${options.intervalSeconds ?? config.supervise.intervalSeconds}s  (Ctrl+C to stop)`);
    await supervisor.loop();
    return 0;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await supervisor.release();
    await store.close();
  }
}
