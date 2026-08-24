/**
 * The two-level operator stop, as the runner reads it.
 *
 * The prototype's stop was two files — `STOP` (finish this tick, then exit) and `STOP-NOW`
 * (kill the live worker immediately) — polled at the top of the outer loop and inside the
 * watchdog (driver.mjs:1020 and :486). Here the same two intents are store rows the
 * CONTROL ROOM writes; these are its key strings, mirrored from room-server.ts:132-133,
 * and the room reads them straight back to render its armed state.
 *
 * Presence is armed: the room writes `{armedAt}` and clears by DELETING the row, so a
 * value is never interpreted. Clearing belongs to the room's START/RESUME actions, which
 * release both keys — the runner never clears a flag it did not arm, or a founder who
 * armed STOP while a run was mid-flight would find it silently disarmed by the very
 * rotation it was meant to stop.
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
