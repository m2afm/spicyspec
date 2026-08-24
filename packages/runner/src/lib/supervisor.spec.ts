/**
 * Supervisor suite — one test per failure that made up the overnight incident, plus the
 * ways self-healing could itself become the outage.
 *
 * Nothing here touches a real process, port, or Temporal server: every dependency the
 * supervisor spawns or probes is injected, so the tests assert the DECISION (spawn / do not
 * spawn / never clear) instead of the side effect.
 */
import { readFileSync } from 'node:fs';
import { openStore, registerRunner, type Store } from '@spicyspec/store';
import type { Notification, NotifyChannel } from '@spicyspec/notify';
import { describe, expect, it } from 'vitest';
import { parseRunnerConfig } from './config.js';
import { KILL_FLAG_KEY, STOP_FLAG_KEY, sweepStaleAgentFlags } from './control-flags.js';
import { readHealthCycle, readHealthEvents, SUPERVISOR_BEAT_KEY, type HealthCheck, type HealthEvent } from './health.js';
import type { SpawnRequest } from './detached-spawn.js';
import { createSupervisor, defaultTemporalArgs, splitAddress, SUPERVISOR_GUARDS_KEY, SUPERVISOR_LOCK_KEY, type SupervisorDeps } from './supervisor.js';

const NOW = Date.parse('2026-08-25T02:00:00.000Z');

interface Harness {
  store: Store;
  spawned: SpawnRequest[];
  notified: Notification[];
  deps: SupervisorDeps;
}

/** Everything healthy by default; each test breaks exactly the one thing it is about. */
function harness(overrides: Partial<SupervisorDeps> = {}, configOverrides: Record<string, unknown> = {}): Harness {
  const store = openStore(':memory:');
  const spawned: SpawnRequest[] = [];
  const notified: Notification[] = [];
  const channel: NotifyChannel = {
    id: 'test',
    send: async (n) => {
      notified.push(n);
    },
  };
  const config = parseRunnerConfig({
    projectName: 'Airvia',
    repoCwd: '/repo',
    accounts: [{ id: 'a' }],
    ...configOverrides,
  });
  const deps: SupervisorDeps = {
    config,
    store,
    configPath: '/repo/spicyspec.runner.json',
    runnerBin: '/cli/bin.js',
    nodeBin: '/node',
    now: () => NOW,
    sleep: async () => undefined,
    probePort: async () => true,
    spawnFn: async (request) => {
      spawned.push(request);
      return 4242;
    },
    describeRotationFn: async () => ({ running: true, detail: 'RUNNING' }),
    dispatchRotationFn: async () => undefined,
    sweepLeasesFn: async () => [],
    notifyChannels: [channel],
    isPidAlive: () => true,
    host: 'workstation',
    pid: 1000,
    log: () => undefined,
    ...overrides,
  };
  // deps.store, not the local one: a test that injects a SHARED store (two supervisors)
  // must get that store back, or its assertions read an empty database.
  return { store: deps.store, spawned, notified, deps };
}

const statusOf = (report: { events: HealthEvent[] }, check: HealthCheck): string | undefined =>
  report.events.find((r) => r.check === check)?.status;

async function heartbeat(store: Store, at: number, taskQueue = 'spicyspec'): Promise<void> {
  await registerRunner(store, {
    id: 'runner-1',
    host: 'workstation',
    pid: 77,
    taskQueue,
    startedAt: new Date(at).toISOString(),
    heartbeatAt: new Date(at).toISOString(),
    accounts: ['a'],
  });
}

describe('a healthy cycle', () => {
  it('repairs nothing, spawns nothing, notifies nobody', async () => {
    const h = harness();
    await heartbeat(h.store, NOW - 5_000);
    const report = await createSupervisor(h.deps).cycle();

    expect(report.healthy).toBe(true);
    expect(report.events.map((r) => r.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(h.spawned).toEqual([]);
    // A supervisor that pings a phone on a healthy night is a supervisor that gets muted.
    expect(h.notified).toEqual([]);
    expect(await readHealthEvents(h.store)).toEqual([]);
  });

  it('still writes the full cycle, ok checks included, for the room to render', async () => {
    const h = harness();
    await heartbeat(h.store, NOW - 5_000);
    await createSupervisor(h.deps).cycle();
    const cycle = await readHealthCycle(h.store);
    expect(cycle?.healthy).toBe(true);
    expect(cycle?.events.map((r) => r.check)).toEqual(['temporal', 'worker', 'rotation', 'stop-flags', 'leases']);
  });

  it('beats under health:supervisor — the room cannot tell "idle" from "unwatched" without it', async () => {
    const h = harness();
    await heartbeat(h.store, NOW - 5_000);
    await createSupervisor(h.deps).cycle();

    const beat = JSON.parse((await h.store.getKv(SUPERVISOR_BEAT_KEY)) ?? 'null');
    expect(beat).toMatchObject({ at: new Date(NOW).toISOString(), intervalMs: 60_000, pid: 1000, healthy: true });
    // Every health:* row the room reads must parse as events or as this beat; a cycle
    // document that did not use the `events` envelope would render as no checks at all.
    for (const row of await h.store.listKv('health:')) {
      expect(() => JSON.parse(row.value)).not.toThrow();
    }
  });
});

describe('check 1 — temporal reachable', () => {
  it('spawns a detached start-dev when the address does not answer, and reports repaired', async () => {
    let up = false;
    const h = harness({ probePort: async () => up, spawnFn: async () => 999 });
    const spawns: SpawnRequest[] = [];
    h.deps.spawnFn = async (request) => {
      spawns.push(request);
      up = true; // the server comes up while the supervisor waits
      return 999;
    };
    await heartbeat(h.store, NOW - 5_000);
    const report = await createSupervisor(h.deps).cycle();

    expect(statusOf(report, 'temporal')).toBe('repaired');
    expect(spawns[0]).toMatchObject({ command: 'temporal', logName: 'temporal' });
    expect(spawns[0].args).toContain('start-dev');
    expect(report.healthy).toBe(true);
  });

  it('never spawns a second Temporal when the address already answers', async () => {
    const h = harness();
    await heartbeat(h.store, NOW - 5_000);
    await createSupervisor(h.deps).cycle();
    expect(h.spawned.filter((s) => s.command === 'temporal')).toEqual([]);
  });

  it('reports unreachable instead of spawning when manageTemporal is false', async () => {
    const h = harness({ probePort: async () => false }, { supervise: { manageTemporal: false } });
    const report = await createSupervisor(h.deps).cycle();
    expect(statusOf(report, 'temporal')).toBe('failed');
    expect(h.spawned).toEqual([]);
    expect(report.healthy).toBe(false);
  });

  it('defers the worker and the rotation while Temporal is down — both would die on connect', async () => {
    const h = harness({ probePort: async () => false }, { supervise: { manageTemporal: false } });
    const report = await createSupervisor(h.deps).cycle();
    expect(statusOf(report, 'worker')).toBe('blocked');
    expect(statusOf(report, 'rotation')).toBe('blocked');
    expect(h.spawned).toEqual([]);
  });
});

describe('check 2 — worker alive', () => {
  it('a FRESH heartbeat is alive: no runner is spawned', async () => {
    const h = harness();
    await heartbeat(h.store, NOW - 10_000);
    const report = await createSupervisor(h.deps).cycle();
    expect(statusOf(report, 'worker')).toBe('ok');
    expect(h.spawned).toEqual([]);
  });

  it('a STALE heartbeat is dead however present the record is (B17) — the runner is respawned', async () => {
    const h = harness();
    await heartbeat(h.store, NOW - 10 * 60_000);
    const spawns: SpawnRequest[] = [];
    h.deps.spawnFn = async (request) => {
      spawns.push(request);
      await heartbeat(h.store, NOW - 1_000); // the respawned runner registers
      return 555;
    };
    const report = await createSupervisor(h.deps).cycle();

    expect(statusOf(report, 'worker')).toBe('repaired');
    expect(spawns[0].command).toBe('/node');
    expect(spawns[0].args).toEqual(['/cli/bin.js', 'start', '--config', '/repo/spicyspec.runner.json']);
  });

  it('a heartbeat on another task queue is not this queue’s worker', async () => {
    const h = harness();
    await heartbeat(h.store, NOW - 1_000, 'some-other-queue');
    h.deps.spawnFn = async () => null;
    const report = await createSupervisor(h.deps).cycle();
    expect(statusOf(report, 'worker')).toBe('failed');
  });
});

describe('check 3 — rotation running', () => {
  it('a RUNNING rotation is left alone', async () => {
    const h = harness();
    await heartbeat(h.store, NOW - 1_000);
    let dispatched = 0;
    h.deps.dispatchRotationFn = async () => {
      dispatched += 1;
    };
    const report = await createSupervisor(h.deps).cycle();
    expect(statusOf(report, 'rotation')).toBe('ok');
    expect(dispatched).toBe(0);
  });

  it.each(['NOT_FOUND', 'CANCELED', 'COMPLETED', 'FAILED', 'TERMINATED'])(
    'a %s rotation is re-dispatched — the incident died behind exactly this',
    async (state) => {
      const h = harness();
      await heartbeat(h.store, NOW - 1_000);
      h.deps.describeRotationFn = async () => ({ running: false, detail: state });
      let dispatched = 0;
      h.deps.dispatchRotationFn = async () => {
        dispatched += 1;
      };
      const report = await createSupervisor(h.deps).cycle();
      expect(statusOf(report, 'rotation')).toBe('repaired');
      expect(dispatched).toBe(1);
    },
  );
});

describe('check 4 — stale agent stop', () => {
  it('a FOUNDER stop is never auto-cleared, at any age — it is reported instead', async () => {
    const h = harness();
    await heartbeat(h.store, NOW - 1_000);
    const ancient = new Date(NOW - 48 * 60 * 60_000).toISOString();
    await h.store.setKv(STOP_FLAG_KEY, JSON.stringify({ armedAt: ancient, armedBy: 'founder' }));

    const report = await createSupervisor(h.deps).cycle();

    expect(statusOf(report, 'stop-flags')).toBe('blocked');
    expect(await h.store.getKv(STOP_FLAG_KEY)).not.toBeNull();
  });

  it('a flag with NO armedBy reads as the founder’s — the fail-safe direction is not clearing', async () => {
    const h = harness();
    await heartbeat(h.store, NOW - 1_000);
    await h.store.setKv(STOP_FLAG_KEY, JSON.stringify({ armedAt: new Date(NOW - 24 * 60 * 60_000).toISOString() }));
    await createSupervisor(h.deps).cycle();
    expect(await h.store.getKv(STOP_FLAG_KEY)).not.toBeNull();
  });

  it('an AGENT stop past the TTL is cleared — the loop sat dead for 8h behind one of these', async () => {
    const h = harness();
    await heartbeat(h.store, NOW - 1_000);
    await h.store.setKv(
      STOP_FLAG_KEY,
      JSON.stringify({ armedAt: new Date(NOW - 31 * 60_000).toISOString(), armedBy: 'agent' }),
    );

    const report = await createSupervisor(h.deps).cycle();

    expect(statusOf(report, 'stop-flags')).toBe('repaired');
    expect(await h.store.getKv(STOP_FLAG_KEY)).toBeNull();
  });

  it('an AGENT stop inside the TTL is still that session’s stop', async () => {
    const h = harness();
    await heartbeat(h.store, NOW - 1_000);
    await h.store.setKv(
      KILL_FLAG_KEY,
      JSON.stringify({ armedAt: new Date(NOW - 60_000).toISOString(), armedBy: 'agent' }),
    );
    const report = await createSupervisor(h.deps).cycle();
    expect(statusOf(report, 'stop-flags')).toBe('blocked');
    expect(await h.store.getKv(KILL_FLAG_KEY)).not.toBeNull();
  });

  it('sweeps both keys and reports what stays armed', async () => {
    const store = openStore(':memory:');
    await store.setKv(STOP_FLAG_KEY, JSON.stringify({ armedAt: new Date(NOW - 60 * 60_000).toISOString(), armedBy: 'agent' }));
    await store.setKv(KILL_FLAG_KEY, JSON.stringify({ armedAt: new Date(NOW - 60 * 60_000).toISOString(), armedBy: 'founder' }));

    const sweep = await sweepStaleAgentFlags(store, { nowMs: NOW, ttlMs: 30 * 60_000 });

    expect(sweep.cleared.map((f) => f.key)).toEqual([STOP_FLAG_KEY]);
    expect(sweep.held.map((f) => f.key)).toEqual([KILL_FLAG_KEY]);
  });

  it('an agent flag whose age cannot be read is swept — an unmeasurable stop must not own the night', async () => {
    const store = openStore(':memory:');
    await store.setKv(STOP_FLAG_KEY, JSON.stringify({ armedBy: 'agent' }));
    const sweep = await sweepStaleAgentFlags(store, { nowMs: NOW, ttlMs: 30 * 60_000 });
    expect(sweep.cleared.map((f) => f.key)).toEqual([STOP_FLAG_KEY]);
  });
});

describe('check 5 — orphaned account leases', () => {
  it('reports a repair when the sweep releases something, and stays quiet when it does not', async () => {
    const h = harness({ sweepLeasesFn: async () => ['account:lease:primary'] });
    await heartbeat(h.store, NOW - 1_000);
    expect(statusOf(await createSupervisor(h.deps).cycle(), 'leases')).toBe('repaired');

    const clean = harness();
    await heartbeat(clean.store, NOW - 1_000);
    expect(statusOf(await createSupervisor(clean.deps).cycle(), 'leases')).toBe('ok');
  });
});

describe('check 6 — dashboard reachable', () => {
  it('is skipped entirely when no dashboard port is configured', async () => {
    const h = harness();
    await heartbeat(h.store, NOW - 1_000);
    const report = await createSupervisor(h.deps).cycle();
    expect(report.events.some((r) => r.check === 'dashboard')).toBe(false);
  });

  it('respawns the control room when its port does not answer', async () => {
    let dashboardUp = false;
    const h = harness({}, { supervise: { dashboardPort: 4477 } });
    h.deps.probePort = async (_host, port) => (port === 4477 ? dashboardUp : true);
    const spawns: SpawnRequest[] = [];
    h.deps.spawnFn = async (request) => {
      spawns.push(request);
      dashboardUp = true;
      return 321;
    };
    await heartbeat(h.store, NOW - 1_000);

    const report = await createSupervisor(h.deps).cycle();

    expect(statusOf(report, 'dashboard')).toBe('repaired');
    expect(spawns[0].args).toEqual(['/cli/bin.js', 'dashboard', '--port', '4477', '--config', '/repo/spicyspec.runner.json']);
  });

  it('leaves a reachable dashboard alone', async () => {
    const h = harness({}, { supervise: { dashboardPort: 4477 } });
    await heartbeat(h.store, NOW - 1_000);
    const report = await createSupervisor(h.deps).cycle();
    expect(statusOf(report, 'dashboard')).toBe('ok');
    expect(h.spawned).toEqual([]);
  });
});

describe('single instance', () => {
  it('the second supervisor spawns NOTHING — two would fight over every restart', async () => {
    const store = openStore(':memory:');
    const first = harness({ store, pid: 1000 });
    await heartbeat(store, NOW - 1_000);
    await createSupervisor(first.deps).cycle();

    const second = harness({ store, pid: 2000, probePort: async () => false });
    const report = await createSupervisor(second.deps).cycle();

    expect(statusOf(report, 'lock')).toBe('blocked');
    expect(report.events).toHaveLength(1);
    expect(second.spawned).toEqual([]);
    // …and it does not overwrite the on-duty supervisor's report with its own one-liner:
    // a scheduled `--once` runs every few minutes beside a live loop.
    expect((await readHealthCycle(store))?.events.map((r) => r.check)).toEqual([
      'temporal',
      'worker',
      'rotation',
      'stop-flags',
      'leases',
    ]);
  });

  it('takes the lock over from a holder this machine can prove is dead', async () => {
    const store = openStore(':memory:');
    await store.setKv(SUPERVISOR_LOCK_KEY, JSON.stringify({ pid: 4321, host: 'workstation', at: '2026-08-24T00:00:00Z' }));
    const h = harness({ store, pid: 9, isPidAlive: () => false });
    await heartbeat(store, NOW - 1_000);

    const report = await createSupervisor(h.deps).cycle();

    expect(report.events.some((r) => r.check === 'lock')).toBe(false);
    expect(JSON.parse((await store.getKv(SUPERVISOR_LOCK_KEY)) ?? '{}')).toMatchObject({ pid: 9 });
  });

  it('leaves a live holder alone even across a restart of the same pid-space', async () => {
    const store = openStore(':memory:');
    // A LIVE holder proves it by refreshing the stamp every cycle — that is what the
    // takeover rule reads. A stale stamp is not a live holder (see the next test).
    await store.setKv(SUPERVISOR_LOCK_KEY, JSON.stringify({ pid: 4321, host: 'workstation', at: new Date(NOW - 30_000).toISOString() }));
    const h = harness({ store, pid: 9, isPidAlive: () => true });
    expect(statusOf(await createSupervisor(h.deps).cycle(), 'lock')).toBe('blocked');
  });

  it('takes over a CROSS-HOST lock that stopped being refreshed — else supervision wedges forever', async () => {
    // The pid of a holder on another machine can never be proven dead from here, so without
    // an expiry a lock leaked by a host that later went away is permanent: nothing supervises
    // and nothing says so. A live supervisor rewrites the row every cycle; silence is absence.
    const store = openStore(':memory:');
    await store.setKv(SUPERVISOR_LOCK_KEY, JSON.stringify({ pid: 4321, host: 'workstation', at: new Date(NOW - 45 * 60_000).toISOString() }));
    const h = harness({ store, pid: 9, isPidAlive: () => true });
    await heartbeat(store, NOW - 1_000);

    const report = await createSupervisor(h.deps).cycle();

    expect(report.events.some((r) => r.check === 'lock')).toBe(false);
    expect(JSON.parse((await store.getKv(SUPERVISOR_LOCK_KEY)) ?? '{}')).toMatchObject({ pid: 9 });
  });

  it('release() hands the lock back so the next supervisor takes it', async () => {
    const store = openStore(':memory:');
    await heartbeat(store, NOW - 1_000);
    const first = createSupervisor(harness({ store, pid: 1000 }).deps);
    await first.cycle();
    await first.release();

    const second = harness({ store, pid: 2000 });
    expect(statusOf(await createSupervisor(second.deps).cycle(), 'lock')).toBe(undefined);
  });
});

describe('bounded and safe', () => {
  it('a throwing check does not abort the cycle — the other five still run', async () => {
    const h = harness({
      sweepLeasesFn: async () => {
        throw new Error('store exploded');
      },
    });
    await heartbeat(h.store, NOW - 1_000);

    const report = await createSupervisor(h.deps).cycle();

    expect(statusOf(report, 'leases')).toBe('failed');
    expect(report.events.map((r) => r.check)).toEqual(['temporal', 'worker', 'rotation', 'stop-flags', 'leases']);
    expect(report.healthy).toBe(false);
  });

  it('backs off after a failed repair instead of respawning every cycle all night', async () => {
    let clock = NOW;
    const h = harness({ probePort: async () => false, now: () => clock }, { supervise: { manageTemporal: true } });
    const spawns: SpawnRequest[] = [];
    h.deps.spawnFn = async (request) => {
      spawns.push(request);
      return null; // the binary is missing; the port never answers
    };
    const supervisor = createSupervisor(h.deps);

    await supervisor.cycle();
    expect(spawns).toHaveLength(1);

    clock += 5_000; // inside the 30s backoff window
    const second = await supervisor.cycle();
    expect(spawns).toHaveLength(1);
    expect(statusOf(second, 'temporal')).toBe('failed');

    clock += 60_000; // past it
    await supervisor.cycle();
    expect(spawns).toHaveLength(2);
  });

  it('records and announces repairs and failed repairs, once each', async () => {
    const h = harness({ sweepLeasesFn: async () => ['account:lease:primary'] });
    await heartbeat(h.store, NOW - 1_000);
    h.deps.describeRotationFn = async () => {
      throw new Error('temporal said no');
    };

    await createSupervisor(h.deps).cycle();

    const events = await readHealthEvents(h.store);
    expect(events.map((e) => `${e.check}:${e.status}`)).toEqual(['rotation:failed', 'leases:repaired']);
    expect(h.notified.map((n) => n.event)).toEqual(['halted', 'parked']);
  });

  it('the ring keeps the most recent events and survives a corrupt value', async () => {
    const h = harness({ sweepLeasesFn: async () => ['account:lease:primary'] });
    await heartbeat(h.store, NOW - 1_000);
    await h.store.setKv('health:events', 'not json at all');
    await createSupervisor(h.deps).cycle();
    expect((await readHealthEvents(h.store)).map((e) => e.check)).toEqual(['leases']);
  });
});

describe('the loop', () => {
  it('stops after the cycle it is in when stop() is called', async () => {
    const h = harness({ intervalMs: 5 });
    await heartbeat(h.store, NOW - 1_000);
    const supervisor = createSupervisor(h.deps);
    supervisor.stop();
    await supervisor.loop({ maxCycles: 3 });
    expect((await readHealthCycle(h.store)) === null).toBe(true);
  });

  it('runs exactly the cycles it is asked for', async () => {
    const h = harness({ intervalMs: 1 });
    await heartbeat(h.store, NOW - 1_000);
    let cycles = 0;
    h.deps.sweepLeasesFn = async () => {
      cycles += 1;
      return [];
    };
    await createSupervisor(h.deps).loop({ maxCycles: 2 });
    expect(cycles).toBe(2);
  });
});

describe('derivations', () => {
  it('splits an address into host and port, defaulting a portless one', () => {
    expect(splitAddress('localhost:7233', 7233)).toEqual({ host: 'localhost', port: 7233 });
    expect(splitAddress('http://10.0.0.4:7999', 7233)).toEqual({ host: '10.0.0.4', port: 7999 });
    expect(splitAddress('temporal.internal', 7233)).toEqual({ host: 'temporal.internal', port: 7233 });
  });

  it('points start-dev at a db file under the repo so a reboot keeps the history', () => {
    const config = parseRunnerConfig({ projectName: 'x', repoCwd: '/repo', accounts: [{ id: 'a' }] });
    const args = defaultTemporalArgs(config);
    expect(args.slice(0, 3)).toEqual(['server', 'start-dev', '--db-filename']);
    expect(args[3].replace(/\\/g, '/')).toMatch(/\/repo\/\.spicyspec\/temporal\.db$/);
    expect(args).toContain('--ui-port');
    // 7233 is start-dev's own default; only a non-default address needs --port
    expect(args).not.toContain('--port');
  });
});

describe('the supervisor must still be there later (the unref\'d-timer outage)', () => {
  it('realSleep holds the event loop open — an unref\'d timer let the process exit mid-await', async () => {
    // The shipped binary ran ONE cycle and exited 0 in a second: nothing else refs the loop
    // on a SQLite store, so an unref'd timer let Node decide there was no work left. Every
    // real process repair died at its first wait, recording nothing and reporting success.
    // The suite could not see it because it injected `sleep: async () => undefined`.
    const src = readFileSync(new URL('./supervisor.ts', import.meta.url), 'utf8');
    const realSleepBody = src.slice(src.indexOf('const realSleep'), src.indexOf('const realSleep') + 200);
    expect(realSleepBody).not.toMatch(/unref/);
    const pauseBody = src.slice(src.indexOf('async function pause'), src.indexOf('async function pause') + 400);
    expect(pauseBody).not.toMatch(/timer\.unref/);
  });

  it('a REAL timer resolves and the finally still runs — the shape that used to exit silently', async () => {
    // Exercised with the real timer, not the injected one: if the timer were unref'd and
    // nothing else held the loop, this promise would never settle in a bare process.
    const marks: string[] = [];
    async function body(): Promise<void> {
      marks.push('enter');
      try {
        await new Promise<void>((r) => setTimeout(r, 20));
        marks.push('after-wait');
      } finally {
        marks.push('finally');
      }
    }
    await body();
    expect(marks).toEqual(['enter', 'after-wait', 'finally']);
  });
});

describe('backoff survives the process, because --once IS a new process every interval', () => {
  it('a failure recorded by one --once run still holds the next one back', async () => {
    const store = openStore(':memory:');
    const clock = NOW;
    // First process: Temporal never answers, so the check spawns, fails and records a guard.
    const first = harness({ store, pid: 100, probePort: async () => false, now: () => clock }, { supervise: { manageTemporal: true } });
    first.deps.spawnFn = async () => null;
    const firstSupervisor = createSupervisor(first.deps);
    await firstSupervisor.cycle();
    await firstSupervisor.release(); // a clean `--once` exit hands the lock back
    const guards = JSON.parse((await store.getKv(SUPERVISOR_GUARDS_KEY)) ?? '[]') as Array<[string, { failures: number }]>;
    expect(guards.length).toBeGreaterThan(0);

    // Second process, same store, same instant: the guard must be read BACK, not reset —
    // otherwise the scheduled task spawns a fresh process every interval, all night, and
    // nothing records the pile-up.
    const spawns: SpawnRequest[] = [];
    const second = harness({ store, pid: 200, probePort: async () => false, now: () => clock }, { supervise: { manageTemporal: true } });
    second.deps.spawnFn = async (request) => {
      spawns.push(request);
      return null;
    };
    const report = await createSupervisor(second.deps).cycle();
    expect(spawns).toHaveLength(0);
    expect(report.events.some((e) => e.detail?.includes('next attempt in'))).toBe(true);
  });
});
