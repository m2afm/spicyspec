/**
 * The health record — what the supervisor found, what it repaired, and what it could not.
 *
 * The overnight incident this exists for was invisible twice over: the loop had been dead
 * for eight hours AND nothing anywhere said so. So every non-healthy observation lands in
 * the store the control room already reads: a capped ring of repairs and failures
 * (`health:events`) plus the FULL last cycle (`health:last-cycle`), ok checks included,
 * which is what lets the room answer "why is the loop idle right now".
 *
 * Only `repaired` and `failed` enter the ring. Recording every healthy check would push a
 * night's real events out of a 200-entry window inside an hour — the ring is the record of
 * things that went wrong, the cycle key is the current picture.
 *
 * Read-modify-write is safe here ONLY because the supervisor holds a single-instance lock
 * (supervisor.ts); no other writer touches these keys.
 */
import type { Store } from '@spicyspec/store';

export type HealthCheck = 'lock' | 'temporal' | 'worker' | 'rotation' | 'stop-flags' | 'leases' | 'dashboard';

/** `blocked` = deliberately not repaired (a founder's stop, a dependency that is down). */
export type HealthStatus = 'ok' | 'repaired' | 'failed' | 'blocked';

export interface HealthEvent {
  at: string;
  check: HealthCheck;
  status: HealthStatus;
  detail: string;
}

export interface HealthCycle {
  at: string;
  /** false when any check is still `failed` — the `--once` exit code reads this */
  healthy: boolean;
  /**
   * Named `events`, not `results`: the control room parses any `health:*` row as events and
   * understands an `{ events: [...] }` envelope, so this document doubles as the room's
   * source of GREEN rows — the ring below only ever carries what went wrong.
   */
  events: HealthEvent[];
}

/** The supervisor's own heartbeat: without it the room cannot tell idle from unwatched. */
export interface SupervisorBeat {
  at: string;
  /** the room calls the supervisor silent after three of these */
  intervalMs: number;
  pid: number;
  host: string;
  healthy: boolean;
}

export const HEALTH_EVENTS_KEY = 'health:events';
export const HEALTH_CYCLE_KEY = 'health:last-cycle';
/** read by the control room to answer "is anybody watching this loop at all" */
export const SUPERVISOR_BEAT_KEY = 'health:supervisor';
export const HEALTH_EVENTS_CAP = 200;

function parseArray(raw: string | null): HealthEvent[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HealthEvent[]) : [];
  } catch {
    // A corrupt ring must not stop the supervisor from recording the next repair.
    return [];
  }
}

export async function readHealthEvents(store: Store): Promise<HealthEvent[]> {
  return parseArray(await store.getKv(HEALTH_EVENTS_KEY));
}

export async function appendHealthEvents(
  store: Store,
  events: readonly HealthEvent[],
  cap = HEALTH_EVENTS_CAP,
): Promise<void> {
  if (!events.length) return;
  const ring = await readHealthEvents(store);
  ring.push(...events);
  await store.setKv(HEALTH_EVENTS_KEY, JSON.stringify(ring.slice(-cap)));
}

export async function writeHealthCycle(store: Store, cycle: HealthCycle): Promise<void> {
  await store.setKv(HEALTH_CYCLE_KEY, JSON.stringify(cycle));
}

export async function writeSupervisorBeat(store: Store, beat: SupervisorBeat): Promise<void> {
  await store.setKv(SUPERVISOR_BEAT_KEY, JSON.stringify(beat));
}

export async function readHealthCycle(store: Store): Promise<HealthCycle | null> {
  const raw = await store.getKv(HEALTH_CYCLE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HealthCycle;
  } catch {
    return null;
  }
}
