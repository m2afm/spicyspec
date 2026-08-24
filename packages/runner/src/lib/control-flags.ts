/**
 * The two-level operator stop, as the runner reads it.
 *
 * The prototype's stop was two files — `STOP` (finish this tick, then exit) and `STOP-NOW`
 * (kill the live worker immediately) — polled at the top of the outer loop and inside the
 * watchdog (driver.mjs:1020 and :486). Here the same two intents are store rows the
 * CONTROL ROOM writes; these are its key strings, mirrored from room-server.ts:132-133,
 * and the room reads them straight back to render its armed state.
 *
 * Presence is armed: the room writes `{armedAt, armedBy}` and clears by DELETING the row,
 * so the ROTATION never interprets the value — any present flag stops it. Clearing belongs
 * to the room's START/RESUME actions; the runner never clears a flag it did not arm, or a
 * founder who armed STOP while a run was mid-flight would find it silently disarmed by the
 * very rotation it was meant to stop.
 *
 * The one exception is `armedBy: 'agent'`, added after the overnight incident: an AGENT
 * armed STOP mid-session, nobody cleared it, and the loop sat dead for eight hours behind a
 * flag no human had asked for. A founder's stop is permanent by definition; an agent's must
 * not outlive its session, so the supervisor sweeps agent flags past a TTL and never
 * touches a founder's. A MISSING `armedBy` reads as 'founder' — the fail-safe direction is
 * NOT auto-clearing something a person may have armed.
 */
import type { Store } from '@spicyspec/store';

/** graceful: the current run finishes, then the rotation opens nothing more */
export const STOP_FLAG_KEY = 'runner:stop';
/** hard: the live session is interrupted now and the run scores as `aborted` */
export const KILL_FLAG_KEY = 'runner:kill-now';

async function armed(store: Store, key: string): Promise<boolean> {
  return (await store.getKv(key)) !== null;
}

/** Has an operator armed a hard kill? Polled by the in-session watchdog every tick. */
export async function isKillArmed(store: Store): Promise<boolean> {
  return armed(store, KILL_FLAG_KEY);
}

/**
 * Should the rotation stop opening new work? EITHER flag says so: a kill that only ended
 * the live session would be followed by the rotation cheerfully opening the next spec,
 * which is not what a button labelled KILL promises.
 */
export async function rotationStopReason(store: Store): Promise<string | null> {
  if (await armed(store, KILL_FLAG_KEY)) {
    return `kill armed from the control room (${KILL_FLAG_KEY}) — the live session is interrupted and the rotation opens nothing further`;
  }
  if (await armed(store, STOP_FLAG_KEY)) {
    return `stop armed from the control room (${STOP_FLAG_KEY}) — in-flight runs finish and settle, then the rotation ends`;
  }
  return null;
}

export type FlagArmer = 'founder' | 'agent';

export interface ControlFlag {
  key: string;
  /** null when the value carried no readable timestamp */
  armedAt: string | null;
  armedBy: FlagArmer;
}

/** Default sweep age for an agent-armed flag. */
export const AGENT_FLAG_TTL_MS = 30 * 60_000;

/**
 * Read a flag's provenance. Absent ⇒ null. Any value that is not `{armedBy: 'agent'}` —
 * including a legacy `{armedAt}` row, a hand-written value, or unparseable text — reads as
 * a FOUNDER flag, because guessing wrong in that direction only leaves the loop paused
 * until a person looks, while guessing wrong the other way overrides a human decision.
 */
export async function readControlFlag(store: Store, key: string): Promise<ControlFlag | null> {
  const raw = await store.getKv(key);
  if (raw === null) return null;
  let value: { armedAt?: unknown; armedBy?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') value = parsed as typeof value;
  } catch {
    /* opaque value — presence is still armed, provenance falls back to founder */
  }
  return {
    key,
    armedAt: typeof value.armedAt === 'string' ? value.armedAt : null,
    armedBy: value.armedBy === 'agent' ? 'agent' : 'founder',
  };
}

/**
 * Is this flag an agent's, and past its TTL?
 *
 * An agent flag with no readable `armedAt` counts as stale: its writer claimed the flag was
 * session-scoped, and a stop whose age cannot be measured must not be the thing that
 * outlives the night. A founder flag is never stale, at any age.
 */
export function isStaleAgentFlag(flag: ControlFlag, nowMs: number, ttlMs: number): boolean {
  if (flag.armedBy !== 'agent') return false;
  if (flag.armedAt === null) return true;
  const armedAtMs = Date.parse(flag.armedAt);
  if (!Number.isFinite(armedAtMs)) return true;
  return nowMs - armedAtMs > ttlMs;
}

export interface FlagSweepResult {
  /** agent flags released by this sweep */
  cleared: ControlFlag[];
  /** flags still armed afterwards — a founder's, or an agent's that is still young */
  held: ControlFlag[];
}

/** Release every stale agent flag; report what stays armed so the room can say why. */
export async function sweepStaleAgentFlags(
  store: Store,
  options: { nowMs: number; ttlMs?: number },
): Promise<FlagSweepResult> {
  const ttlMs = options.ttlMs ?? AGENT_FLAG_TTL_MS;
  const result: FlagSweepResult = { cleared: [], held: [] };
  for (const key of [STOP_FLAG_KEY, KILL_FLAG_KEY]) {
    const flag = await readControlFlag(store, key);
    if (!flag) continue;
    if (isStaleAgentFlag(flag, options.nowMs, ttlMs)) {
      await store.release(key);
      result.cleared.push(flag);
    } else {
      result.held.push(flag);
    }
  }
  return result;
}
