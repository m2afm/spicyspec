/**
 * The in-session watchdog.
 *
 * Everything here exists because the exit classes `hung`, `stalled` and `timed-out` were
 * UNREACHABLE: the drain loop called classify with `killedFor: null` unconditionally, so a
 * live-but-wedged session ran the whole activity timeout and the engine reported that as an
 * infrastructure failure the retry policy re-ran — hours of quota per wedge, and a stall
 * limit that could never see the thing it exists to park.
 */
import type { ProviderAdapter, WorkerEvent } from '@spicyspec/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createActivities,
  DEFAULT_WATCHDOG,
  watchdogVerdict,
  type ActivityDeps,
  type WatchdogClock,
} from './activities.js';

const MIN = 60_000;
const T0 = 1_000_000_000;

const clock = (over: Partial<WatchdogClock> = {}): WatchdogClock => ({
  startedMs: T0,
  lastEventMs: T0,
  lastProgressMs: T0,
  nowMs: T0,
  ...over,
});

describe('watchdogVerdict — the rules, at the minute', () => {
  it('a talking, committing session is never killed', () => {
    const at = T0 + 200 * MIN; // three hours in, still under the hard backstop
    expect(watchdogVerdict(clock({ nowMs: at, lastEventMs: at, lastProgressMs: at }), DEFAULT_WATCHDOG)).toBeNull();
  });

  it('B6: quiet for 12 minutes with no commit for 90 is NOT a stall — the integration tier is silent while healthy', () => {
    // The prototype killed its tick 4 at exactly 30 minutes, 71 tool calls deep and one
    // command short of committing, because a ~12-minute test tier emits nothing. Neither
    // condition alone may fire: "no commit yet" is normal, and so is a long quiet Bash.
    const noCommitOnly = clock({ nowMs: T0 + 100 * MIN, lastEventMs: T0 + 100 * MIN, lastProgressMs: T0 });
    expect(watchdogVerdict(noCommitOnly, DEFAULT_WATCHDOG)).toBeNull();
    const quietOnly = clock({ nowMs: T0 + 20 * MIN, lastEventMs: T0 + 7 * MIN, lastProgressMs: T0 + 20 * MIN });
    expect(watchdogVerdict(quietOnly, DEFAULT_WATCHDOG)).toBeNull();
  });

  it('both conditions together are a stall', () => {
    const wedged = clock({ nowMs: T0 + 100 * MIN, lastEventMs: T0 + 80 * MIN, lastProgressMs: T0 });
    expect(watchdogVerdict(wedged, DEFAULT_WATCHDOG)).toBe('stall');
  });

  it('total silence past hangMinutes is a hang, and outranks the stall rule', () => {
    const silent = clock({ nowMs: T0 + 120 * MIN, lastEventMs: T0, lastProgressMs: T0 });
    expect(watchdogVerdict(silent, DEFAULT_WATCHDOG)).toBe('hang');
  });

  it('the hard backstop outranks everything: alive, talking, and achieving nothing for 4h', () => {
    const forever = clock({ nowMs: T0 + 241 * MIN, lastEventMs: T0 + 241 * MIN, lastProgressMs: T0 + 241 * MIN });
    expect(watchdogVerdict(forever, DEFAULT_WATCHDOG)).toBe('timeout');
  });

  it("an operator's kill outranks every timing rule and is never a worker failure", () => {
    // classify maps 'stop-now' to ABORTED, which the workflow refuses to score (B15) — so
    // a founder pressing Kill on a perfectly healthy session must not leave a stall behind.
    const healthy = clock({ killRequested: true });
    expect(watchdogVerdict(healthy, DEFAULT_WATCHDOG)).toBe('stop-now');
    const alsoWedged = clock({ nowMs: T0 + 241 * MIN, lastEventMs: T0, killRequested: true });
    expect(watchdogVerdict(alsoWedged, DEFAULT_WATCHDOG)).toBe('stop-now');
  });
});

/* --------------------------------------------------------------- the live session ---- */

/** A session that never ends and never emits — the exact shape the watchdog exists for. */
function wedgedSession(interrupts: string[]) {
  return {
    id: 'fake',
    createSession: () => ({
      events: (): AsyncGenerator<WorkerEvent> =>
        ({
          [Symbol.asyncIterator]() {
            return this;
          },
          next: () => new Promise<never>(() => undefined),
          return: async () => ({ done: true, value: undefined }),
        }) as unknown as AsyncGenerator<WorkerEvent>,
      interrupt: async () => {
        interrupts.push('interrupt');
      },
    }),
  } as unknown as ProviderAdapter;
}

function depsFor(provider: ProviderAdapter, nowMs: () => number): ActivityDeps {
  const snap = {
    git: { head: 'h1', dirty: false },
    tasks: { exists: true, done: 1, open: 2 },
    handoff: { mtimeMs: 1 },
  };
  return {
    provider,
    nowMs,
    watchdog: { ...DEFAULT_WATCHDOG, pollSeconds: 1 },
    buildPacket: async () => ({
      prompt: 'p',
      cwd: '/repo',
      account: { id: 'primary', env: {}, configDir: null },
      disallowedTools: [],
      protectedPaths: [],
    }),
    snapshot: async () => snap,
  } as unknown as ActivityDeps;
}

describe('runWorkerSession — a wedged session is KILLED and SCORED, not waited out', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a session that never emits is interrupted and classified `hung` (killedFor was hard-coded null)', async () => {
    const interrupts: string[] = [];
    let fake = T0;
    const run = createActivities(depsFor(wedgedSession(interrupts), () => fake)).runWorkerSession({
      specId: '006',
      run: 1,
    });
    // Walk the clock past hangMinutes one poll at a time, exactly as the interval would.
    for (let i = 0; i < 40; i += 1) {
      fake += MIN;
      await vi.advanceTimersByTimeAsync(1000);
    }
    const outcome = await run;
    expect(outcome.exit).toBe('hung');
    expect(interrupts.length).toBeGreaterThan(0);
  });

  it('a kill that never takes is abandoned after 4 attempts, not waited on forever', async () => {
    // The prototype cleared its interval before killing, so a kill that failed to take was
    // never retried and the loop hung silently with nothing left to resolve it.
    const interrupts: string[] = [];
    let fake = T0;
    const run = createActivities(depsFor(wedgedSession(interrupts), () => fake)).runWorkerSession({
      specId: '006',
      run: 1,
    });
    for (let i = 0; i < 40; i += 1) {
      fake += MIN;
      await vi.advanceTimersByTimeAsync(1000);
    }
    await run;
    expect(interrupts.length).toBe(4);
  });

  it('an armed kill interrupts the live session and the run scores `aborted`', async () => {
    const interrupts: string[] = [];
    let fake = T0;
    const deps = depsFor(wedgedSession(interrupts), () => fake);
    deps.killRequested = async () => true;
    const run = createActivities(deps).runWorkerSession({ specId: '006', run: 1 });
    for (let i = 0; i < 6; i += 1) await vi.advanceTimersByTimeAsync(1000);
    const outcome = await run;
    expect(outcome.exit).toBe('aborted');
    expect(interrupts.length).toBeGreaterThan(0);
  });

  it('a store hiccup reading the kill flag is not a kill', async () => {
    const interrupts: string[] = [];
    let fake = T0;
    const deps = depsFor(wedgedSession(interrupts), () => fake);
    deps.killRequested = async () => {
      throw new Error('store unavailable');
    };
    const run = createActivities(deps).runWorkerSession({ specId: '006', run: 1 });
    // stay well under every timing rule: nothing may be killed
    for (let i = 0; i < 6; i += 1) {
      fake += MIN;
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(interrupts).toEqual([]);
    // let the timing rules finish the run so the test does not leak a pending promise
    for (let i = 0; i < 40; i += 1) {
      fake += MIN;
      await vi.advanceTimersByTimeAsync(1000);
    }
    await run;
  });

  it('a new HEAD resets the stall horizon — a committing worker survives its quiet spells', async () => {
    const interrupts: string[] = [];
    let fake = T0;
    let commits = 0;
    const deps = depsFor(wedgedSession(interrupts), () => fake);
    // Commits keep landing, and the worker speaks just often enough to stay under
    // hangMinutes: neither stall condition holds, so nothing may be killed.
    deps.headOf = async () => `h${commits}`;
    const events: WorkerEvent[] = [];
    for (let i = 0; i < 200; i += 1) {
      events.push({ type: 'assistant_text', text: 'working', topLevel: true } as WorkerEvent);
    }
    deps.provider = {
      id: 'fake',
      createSession: () => ({
        events: async function* () {
          for (const e of events) {
            fake += 10 * MIN;
            commits += 1;
            yield e;
          }
          yield { type: 'result', envelope: { total_cost_usd: 1, num_turns: 2, result: 'RUN_STATUS: continuing' } } as WorkerEvent;
        },
        interrupt: async () => {
          interrupts.push('interrupt');
        },
      }),
    } as unknown as ProviderAdapter;
    const outcome = await createActivities(deps).runWorkerSession({ specId: '006', run: 1 });
    expect(interrupts).toEqual([]);
    expect(outcome.exit).not.toBe('stalled');
    expect(outcome.exit).not.toBe('hung');
  });
});
