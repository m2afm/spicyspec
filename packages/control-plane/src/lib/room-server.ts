/**
 * The Loop Control Room — spicyspec edition. THE product dashboard.
 *
 * The frontend (room/app.html + React bundles) is the founder tooling proven on the
 * prototype, vendored byte-identical. This server implements the API it speaks, over the
 * spicyspec store: catalog and totals from the queue/ledger, owed-by-you checklists built
 * from each spec's own acceptance scenarios (vendored founder-brief), check state in the
 * store's directory, sign-off gated on the checklist and recorded BOTH as the git tag the
 * guards read AND as the review decision the parked workflow collects.
 *
 * Same security model as the original, hardened after prototype B32: host allowlist,
 * sec-fetch-site rejection, and a per-start token injected into the page — every
 * state-changing POST requires it.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { closingGate, DEFAULT_VERIFICATION_PATTERNS, parseGateRecords, type GateRecord } from '@spicyspec/core';
import type { Store } from '@spicyspec/store';

const execFileAsync = promisify(execFile);
const ROOM = fileURLToPath(new URL('../../room/', import.meta.url));

/* ------------------------------------------------------- vendored prototype modules ---- */
/* Plain-JS modules shipped in room/ — imported dynamically, typed at the boundary. */
interface BriefModule {
  specDirFor(root: string, id: string): string | null;
  buildBrief(root: string, args: { kind: string; id: string; parkedKey: string | null }): Record<string, unknown>;
  listOwed(root: string, queueEntries: unknown[]): Array<Record<string, unknown>>;
  parseParked(root: string, relPath?: string): { items: Array<{ date: string | null; reason: string }>; problems: string[] };
}
interface ChecksModule {
  loadChecks(path: string): Record<string, unknown>;
  setCheck(path: string, itemKey: string, checkKey: string, value: boolean): Record<string, unknown>;
  setNote(path: string, itemKey: string, checkKey: string, text: string): Record<string, unknown>;
  markSignedOff(path: string, itemKey: string): void;
  progressFor(state: Record<string, unknown>, itemKey: string, brief: Record<string, unknown>): {
    complete: boolean;
    blockingDone: number;
    blockingTotal: number;
    remaining: Array<{ section: string; title: string }>;
    startedAt: string | null;
    signedOffAt: string | null;
  };
}

interface AgentsModule {
  ROOT_ID: string;
  createRegistry(meta?: Record<string, unknown>): Record<string, unknown>;
  ingest(reg: Record<string, unknown>, event: unknown): Iterable<string>;
  snapshot(reg: Record<string, unknown>, opts?: { detail?: boolean }): { agents: Array<Record<string, unknown>>; counts: Record<string, number> };
  agentDetail(reg: Record<string, unknown>, id: string): Record<string, unknown> | null;
}

interface RoleMessage {
  at: string;
  from: string;
  text: string;
  costUsd?: number;
  activity?: unknown[];
  error?: string | null;
}

interface RolesModule {
  ROLE_IDS: string[];
  ROLE_DEFS: Record<string, { id: string; name: string; permissionMode: string }>;
  rolesSnapshot(stateDir: string): Array<Record<string, unknown>>;
  loadSession(stateDir: string, id: string): { sessionId: string | null; turns?: number; costUsd?: number; lastAt?: string | null };
  readMessages(stateDir: string, id: string, limit?: number): RoleMessage[];
  readTasks(stateDir: string, id: string): Array<Record<string, unknown>>;
  addTask(stateDir: string, id: string, task: { text: unknown; scheduledFor?: unknown }): Record<string, unknown>;
  updateTask(stateDir: string, id: string, taskId: string, patch: Record<string, unknown>): Record<string, unknown> | null;
  readMandate(stateDir: string, id: string): string | null;
  writeMandate(stateDir: string, id: string, text: unknown): void;
  isBusy(id: string): boolean;
  say(args: {
    stateDir: string;
    root: string;
    id: string;
    text: string;
    config: Record<string, unknown>;
    onEvent?: (e: Record<string, unknown>) => void;
  }): Promise<RoleMessage>;
}

interface NarrativeModule {
  describeWhereWeAre(input: Record<string, unknown>): Record<string, unknown>;
}

async function vendored(): Promise<{ brief: BriefModule; checks: ChecksModule; agents: AgentsModule; roles: RolesModule; narrative: NarrativeModule }> {
  const brief = (await import(new URL('founder-brief.mjs', new URL('../../room/', import.meta.url)).href)) as unknown as BriefModule;
  const checks = (await import(new URL('founder-checks.mjs', new URL('../../room/', import.meta.url)).href)) as unknown as ChecksModule;
  const agents = (await import(new URL('agents.mjs', new URL('../../room/', import.meta.url)).href)) as unknown as AgentsModule;
  const roles = (await import(new URL('roles.mjs', new URL('../../room/', import.meta.url)).href)) as unknown as RolesModule;
  const narrative = (await import(new URL('narrative.mjs', new URL('../../room/', import.meta.url)).href)) as unknown as NarrativeModule;
  return { brief, checks, agents, roles, narrative };
}

/* ---------------------------------------------------------------------- options ---- */

export interface RoomOptions {
  store: Store;
  projectName: string;
  repoCwd: string;
  /** configured account ids — the panel shows THESE from the start; state overlays them */
  accountIds?: string[];
  /** where founder-checks.json lives (orchestrator state) */
  stateDir: string;
  /** the runner CLI entry, for the START/STOP actions */
  runnerBin: string;
  configPath: string;
  host?: string;
  port?: number;
}

export interface RunningRoom {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/**
 * The two-level stop, as store flags — the prototype's STOP and STOP-NOW marker files.
 * `runner:stop` is read at a run boundary (the run in flight finishes, then the rotation
 * halts); `runner:kill-now` is read by the live run and ends the session where it stands.
 * Both stay armed until RESUME clears them, and this server reads them back as armed state
 * so the header's Kill button never claims a state it does not have.
 */
export const STOP_KEY = 'runner:stop';
export const KILL_KEY = 'runner:kill-now';

/* ------------------------------------------------------------------------ health ---- */

/**
 * The supervisor's report, as the founder reads it.
 *
 * This section exists because of one night: the room said RUNNING / LIVE FEED for eight
 * hours while the rotation workflow was CANCELED and a STOP flag armed by an AGENT was never
 * cleared. Every chip on the page was true, and every one of them described a PROCESS; none
 * described PROGRESS. So the room now reads what the supervisor writes about each thing it
 * watches, and says plainly when the supervisor itself has gone quiet.
 *
 * The writer is the supervisor (packages/runner) — this file only ever reads these keys, and
 * treats every field as untrusted: a malformed or absent report renders as "no supervisor
 * reporting", never as a crash and never as health.
 */
export const HEALTH_KEY = 'health:events';
export const SUPERVISOR_KEY = 'health:supervisor';

/** What the supervisor writes per check. `detail` is optional; every field may be junk. */
export interface HealthEvent {
  at: string;
  check: string;
  status: string;
  detail?: string;
}

export type HealthStatus = 'ok' | 'repaired' | 'failed' | 'blocked' | 'unknown';

/**
 * The checks the founder named, in the order they matter when the loop is dead: is there an
 * engine, is anything hosting it, is work dispatched, can I see it, is it allowed to move,
 * can it get an account. Anything else the supervisor reports is appended rather than
 * dropped — a check the room refuses to render is a check nobody watches.
 */
const CHECK_ROSTER: Array<{ check: string; label: string; aliases: string[] }> = [
  { check: 'temporal', label: 'Temporal', aliases: ['temporal-server', 'server'] },
  { check: 'worker', label: 'Worker heartbeat', aliases: ['worker-heartbeat', 'heartbeat', 'runner'] },
  { check: 'rotation', label: 'Rotation', aliases: ['workflow', 'rotation-workflow'] },
  { check: 'dashboard', label: 'Dashboard', aliases: ['room', 'control-room'] },
  { check: 'stop-flags', label: 'Stop flags', aliases: ['stopflags', 'stop', 'flags'] },
  { check: 'accounts', label: 'Account leases', aliases: ['account-leases', 'leases', 'pool'] },
];

/**
 * Checks the supervisor reports that the founder did not name. They still get a row — a check
 * the room refuses to render is a check nobody watches — but a hand-written label beats the
 * prettifier: 'lock' is the supervisor's single-instance lock, not a door.
 */
const EXTRA_LABELS: Record<string, string> = { lock: 'Supervisor lock' };

const CANONICAL_CHECK = new Map<string, string>();
for (const row of CHECK_ROSTER) {
  CANONICAL_CHECK.set(row.check, row.check);
  for (const alias of row.aliases) CANONICAL_CHECK.set(alias, row.check);
}

/** Reported words vary by writer; the five states the panel can colour do not. */
const STATUS_ALIASES: Record<string, HealthStatus> = {
  ok: 'ok', healthy: 'ok', up: 'ok', pass: 'ok', green: 'ok',
  repaired: 'repaired', healed: 'repaired', restarted: 'repaired', fixed: 'repaired', cleared: 'repaired',
  failed: 'failed', fail: 'failed', down: 'failed', error: 'failed', broken: 'failed',
  blocked: 'blocked', skipped: 'blocked', manual: 'blocked',
};

export interface HealthRow {
  check: string;
  label: string;
  status: HealthStatus;
  /** exactly the word the supervisor used — normalising it away would hide a new state */
  reported: string | null;
  detail: string | null;
  checkedAt: string | null;
  lastRepairAt: string | null;
  lastRepairDetail: string | null;
}

export interface SupervisorHealth {
  reporting: boolean;
  lastAt: string | null;
  /** silence longer than this is reported as "not reporting" */
  staleAfterMs: number;
  /** the one command that fixes it — a self-healer nobody can install is not installed */
  advice: string | null;
}

/** Default grace before silence is called silence: three 60s beats, plus slack. */
const SUPERVISOR_STALE_MS = 5 * 60_000;
const HEALTH_EVENTS_SHOWN = 20;
export const INSTALL_HINT = 'supervisor not reporting — install with: spicyspec-runner install-autostart';

const isEventish = (v: unknown): v is HealthEvent =>
  typeof v === 'object' && v !== null && typeof (v as HealthEvent).check === 'string';

/**
 * Every shape the supervisor might have chosen, accepted: a JSON array, a `{ events: [...] }`
 * envelope, one bare event, or newline-delimited JSON. The writer lives in another package
 * and the room must not dictate its storage — but it must also never render a guess as a
 * fact, so anything unparseable yields no events at all.
 */
export function parseHealthEvents(raw: string | null | undefined): HealthEvent[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const out: HealthEvent[] = [];
  const take = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) take(v);
      return;
    }
    if (isEventish(value)) {
      out.push(value);
      return;
    }
    if (typeof value === 'object' && value !== null && Array.isArray((value as { events?: unknown }).events)) {
      take((value as { events: unknown[] }).events);
    }
  };
  try {
    take(JSON.parse(raw));
    return out;
  } catch {
    /* not one document — fall through to the line-delimited reading */
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      take(JSON.parse(line));
    } catch {
      /* one bad line must not void the whole report */
    }
  }
  return out;
}

const eventTime = (e: HealthEvent): number => {
  const t = Date.parse(String(e.at));
  return Number.isFinite(t) ? t : 0;
};

/**
 * Newest last, capped, and deduplicated — the raw report under the rows.
 *
 * The supervisor records a repair in TWO places on purpose: the capped failures ring
 * (`health:events`) and the full cycle document (`health:last-cycle`, ok checks included).
 * Both are read, so without this every repair would be narrated twice — a small lie in the
 * one panel whose whole job is not telling them.
 */
export function recentHealthEvents(events: HealthEvent[]): HealthEvent[] {
  const seen = new Set<string>();
  const unique: HealthEvent[] = [];
  for (const e of events) {
    const id = `${e.at}|${e.check}|${e.status}|${e.detail ?? ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(e);
  }
  return unique.sort((a, b) => eventTime(a) - eventTime(b)).slice(-HEALTH_EVENTS_SHOWN);
}

/**
 * One row per supervised check, newest report wins, plus the last repair recorded for it. A
 * check with no report at all is still a ROW — "not reported yet" is the most important thing
 * this panel can say, and a missing row says nothing at all.
 */
/**
 * `git status --porcelain` pads its status field to two columns, so a worktree-modified entry
 * begins with a SPACE (' M path'). git() trims the whole stdout, which ate that space on the
 * FIRST line only — and a fixed slice(3) then ate a real character with it, so the tree strip
 * read 'picyspec.runner.json'. Match the status field instead of counting characters that are
 * not always there.
 */
export function dirtyPathsFrom(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .map((line) => line.replace(/^\s*[A-Z?!ADMRCU ]{1,2}\s+/, '').trim())
    .filter((line) => line.length > 0);
}

export function healthRows(events: HealthEvent[]): HealthRow[] {
  const key = (raw: unknown): string => {
    const id = String(raw ?? '').toLowerCase().trim();
    return CANONICAL_CHECK.get(id) ?? id;
  };
  const byCheck = new Map<string, HealthEvent[]>();
  for (const e of events) {
    const id = key(e.check);
    if (!id) continue;
    const bucket = byCheck.get(id) ?? [];
    bucket.push(e);
    byCheck.set(id, bucket);
  }
  const extras = [...byCheck.keys()].filter((k) => !CHECK_ROSTER.some((r) => r.check === k)).sort();
  const order = [
    ...CHECK_ROSTER.map((r) => ({ check: r.check, label: r.label })),
    ...extras.map((check) => ({
      check,
      label: EXTRA_LABELS[check] ?? check.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    })),
  ];

  return order.map(({ check, label }) => {
    const sorted = (byCheck.get(check) ?? []).slice().sort((a, b) => eventTime(a) - eventTime(b));
    const latest = sorted[sorted.length - 1] ?? null;
    const repair = sorted.filter((e) => STATUS_ALIASES[String(e.status).toLowerCase().trim()] === 'repaired').pop() ?? null;
    return {
      check,
      label,
      status: latest ? STATUS_ALIASES[String(latest.status).toLowerCase().trim()] ?? 'unknown' : 'unknown',
      reported: latest ? String(latest.status) : null,
      detail: latest?.detail != null ? String(latest.detail) : null,
      checkedAt: latest ? String(latest.at) : null,
      lastRepairAt: repair ? String(repair.at) : null,
      lastRepairDetail: repair?.detail != null ? String(repair.detail) : null,
    };
  });
}

/**
 * Is the supervisor itself alive? Its own heartbeat record is preferred; failing that, the
 * newest health event is proof it ran. Both absent means nobody is watching — which the room
 * says in the same words as the command that fixes it.
 */
export function supervisorHealth(events: HealthEvent[], record: string | null | undefined, now: number): SupervisorHealth {
  let beatAt: number | null = null;
  let staleAfterMs = SUPERVISOR_STALE_MS;
  try {
    const rec = record ? (JSON.parse(record) as { at?: unknown; intervalMs?: unknown }) : null;
    const t = Date.parse(String(rec?.at));
    if (Number.isFinite(t)) beatAt = t;
    // The supervisor's own interval, tripled: one missed beat is a slow disk, three is a dead
    // supervisor. A record without an interval keeps the default grace.
    if (typeof rec?.intervalMs === 'number' && rec.intervalMs > 0) staleAfterMs = Math.max(rec.intervalMs * 3, 90_000);
  } catch {
    /* a corrupt record is not a heartbeat */
  }
  const newestEvent = events.reduce((max, e) => Math.max(max, eventTime(e)), 0);
  if (newestEvent > (beatAt ?? 0)) beatAt = newestEvent;

  const reporting = beatAt != null && beatAt > 0 && now - beatAt < staleAfterMs;
  return {
    reporting,
    lastAt: beatAt && beatAt > 0 ? new Date(beatAt).toISOString() : null,
    staleAfterMs,
    advice: reporting ? null : INSTALL_HINT,
  };
}

/* -------------------------------------------------------------------- stop flags ---- */

/**
 * Who armed a stop, and when. The overnight incident turned on this: an AGENT armed
 * `runner:stop`, nothing ever cleared it, because nothing could tell an agent's flag from the
 * founder's. The room stamps `armedBy: 'founder'` on every flag it arms, the supervisor
 * auto-clears only flags that are NOT the founder's, and the armed chip names the author so a
 * founder can tell "I did this" from "something did this to me".
 */
export interface ArmedFlag {
  armedAt: string | null;
  armedBy: string | null;
}

export const FOUNDER = 'founder';

/** An armed flag with an unreadable body is still armed — the flag's existence is the fact. */
export function parseArmedFlag(raw: string | null | undefined): ArmedFlag | null {
  if (raw == null) return null;
  try {
    const rec = JSON.parse(raw) as { armedAt?: unknown; armedBy?: unknown };
    return {
      armedAt: typeof rec?.armedAt === 'string' ? rec.armedAt : null,
      armedBy: typeof rec?.armedBy === 'string' ? rec.armedBy : null,
    };
  } catch {
    return { armedAt: null, armedBy: null };
  }
}

/* ---------------------------------------------------------------------- top line ---- */

export type LoopState = 'WORKING' | 'STOPPING' | 'KILLING' | 'IDLE' | 'STOPPED';

export interface TopLine {
  state: LoopState;
  /** why, in founder words — null only while WORKING */
  reason: string | null;
  tone: 'on' | 'warn' | 'off';
}

export interface TopLineInput {
  running: boolean;
  lanes: number;
  stop: ArmedFlag | null;
  kill: ArmedFlag | null;
  /** the rotation row of the supervisor's report, when it has one */
  rotation: HealthRow | null;
  awaitingFounder: number;
  reviewCap: number;
  pending: number;
  parked: number;
  heartbeatAt: string | null;
  now: number;
}

/** "3h ago" / "12m ago" — the granularity the page's own `ago` uses, so the two agree. */
function sinceLabel(iso: string | null, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'at an unrecorded time';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${(s / 3600).toFixed(1)}h ago`;
}

const armedPhrase = (flag: ArmedFlag | null, now: number): string =>
  `armed by ${flag?.armedBy ?? 'an unrecorded author'} ${sinceLabel(flag?.armedAt ?? null, now)}`;

/**
 * WORKING versus NOT WORKING, in one look — the whole point of this function.
 *
 * `running` alone used to drive the header, and `running` is nothing but a fresh runner
 * heartbeat. So on the night the rotation was cancelled and a stop flag sat armed, the page
 * said RUNNING: a live process, zero progress, for eight hours. A heartbeat is now necessary
 * and never sufficient — a lane in flight is what "working" means, and every other
 * combination has to state its reason.
 */
export function topLine(input: TopLineInput): TopLine {
  const { running, lanes, stop, kill, rotation, awaitingFounder, reviewCap, pending, parked, now } = input;

  if (!running) {
    return {
      state: 'STOPPED',
      reason: input.heartbeatAt
        ? `no runner heartbeat since ${sinceLabel(input.heartbeatAt, now)} — nothing is hosting the loop (spicyspec-runner start)`
        : 'no runner has ever registered — nothing is hosting the loop (spicyspec-runner start)',
      tone: 'off',
    };
  }

  // Armed-and-still-working is its own state: the lane in flight is real work that is about
  // to be the last of it. Collapsing it into WORKING promises ticks that will not come.
  if (lanes > 0) {
    if (kill) return { state: 'KILLING', reason: `kill-now ${armedPhrase(kill, now)} — the live session is being interrupted`, tone: 'warn' };
    if (stop) return { state: 'STOPPING', reason: `stop ${armedPhrase(stop, now)} — this lane finishes, then the rotation ends`, tone: 'warn' };
    return { state: 'WORKING', reason: null, tone: 'on' };
  }

  // A worker is alive and NOTHING is in flight. This is the state that spent a night
  // impersonating RUNNING, so it is never reported without a reason.
  if (kill) return { state: 'IDLE', reason: `kill-now ${armedPhrase(kill, now)} — the rotation opens nothing further until Clear stop`, tone: 'warn' };
  if (stop) return { state: 'IDLE', reason: `stop ${armedPhrase(stop, now)} — the rotation opens nothing further until Clear stop`, tone: 'warn' };
  if (rotation && (rotation.status === 'failed' || rotation.status === 'blocked')) {
    return { state: 'IDLE', reason: `rotation ${rotation.reported ?? rotation.status}${rotation.detail ? ` — ${rotation.detail}` : ''}`, tone: 'warn' };
  }
  if (reviewCap > 0 && awaitingFounder >= reviewCap) {
    return { state: 'IDLE', reason: `review cap reached — ${awaitingFounder} spec(s) awaiting you, cap ${reviewCap}; sign one off to free a slot`, tone: 'warn' };
  }
  if (pending === 0) {
    return { state: 'IDLE', reason: `queue drained — nothing pending${parked > 0 ? `, ${parked} parked` : ''}`, tone: 'warn' };
  }
  return { state: 'IDLE', reason: `no rotation dispatched — ${pending} spec(s) pending and no lane in flight; press Start`, tone: 'warn' };
}

/* -------------------------------------------------------------- supervisor read ---- */

export interface SupervisorReport {
  supervisor: SupervisorHealth;
  rows: HealthRow[];
  events: HealthEvent[];
}

/**
 * Gather the supervisor's report from the store. Both plausible storages are read — the one
 * `health:events` document and any `health:*` rows — and merged, so the room does not break
 * the day the supervisor changes how it writes. Every failure path returns an EMPTY report:
 * the panel then says "no supervisor reporting", which is the truth, instead of nothing,
 * which is what a crash renders.
 */
export async function readSupervisorReport(store: Store, now: number): Promise<SupervisorReport> {
  let events: HealthEvent[] = [];
  let record: string | null = null;
  try {
    const rows = await store.listKv('health:');
    for (const row of rows) {
      if (row.key === SUPERVISOR_KEY) {
        record = row.value;
        continue;
      }
      events = events.concat(parseHealthEvents(row.value));
    }
    if (!rows.some((r) => r.key === HEALTH_KEY)) events = events.concat(parseHealthEvents(await store.getKv(HEALTH_KEY)));
    if (record == null) record = await store.getKv(SUPERVISOR_KEY);
  } catch {
    /* a store that cannot answer is a supervisor that is not reporting */
  }
  return { supervisor: supervisorHealth(events, record, now), rows: healthRows(events), events: recentHealthEvents(events) };
}

/**
 * The rotation's review cap, straight from the runner config the loop actually runs on
 * (packages/runner config.ts `maxAwaitingReview`, default 3). Read here rather than passed in
 * because the callers of this room are other packages; an unreadable config falls back to the
 * runner's own default so the reason "review cap reached" can never be invented out of zero.
 */
export function reviewCapOf(configPath: string): number {
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const cap = raw['maxAwaitingReview'];
    if (typeof cap === 'number' && Number.isInteger(cap) && cap > 0) return cap;
  } catch {
    /* no config here — the default below is the runner's own */
  }
  return 3;
}

const STATUS_TO_ROOM: Record<string, string> = {
  'awaiting-review': 'awaiting-founder',
  done: 'done',
  parked: 'parked',
  pending: 'pending',
  active: 'active',
};

/* ------------------------------------------------------------------- state build ---- */

/** The last non-empty line of a CLI's output — what these commands print as their answer. */
const lastLine = (text: string): string => text.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';

/**
 * Epoch milliseconds from a provider rate-limit timestamp. The provider reports SECONDS
 * (core classify.ts rateResetsAt, the same field markCold multiplies by 1000), so a bare
 * `* 1000` on a value that already arrived in ms would put the 'window HH:MM' chip in the
 * year 33000. Anything past 1e12 is already ms.
 */
const epochMs = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value > 1e12 ? value : value * 1000;
};

async function git(repoCwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['--no-optional-locks', ...args], {
      cwd: repoCwd,
      timeout: 15_000,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

export interface SpecProgress {
  done: number;
  open: number;
  held: number;
  unmarked: number;
  /** rows explicitly handed to a later spec — not this spec's work, shown but not counted */
  deferred: number;
  /** total EXCLUDING deferred rows, so the bar measures this spec */
  total: number;
  /** every row in the file, deferred included, for the line beside the bar */
  deferredTotal: number;
  waves: number;
  currentWave: string | null;
}

/**
 * Task progress, counted by task ID and by list item only — a line port of the prototype's
 * specProgress (ui/server.mjs:102-125). Deliberately the same rules as the terminal view:
 * prose that merely mentions an id is not a task, and a task held open WITH a stated reason
 * ("left unmarked", "NOT CLOSED", ✖, ⚠) is not the same as one silently blank. Both
 * distinctions were learned the hard way — held:0 hardcoded made the per-lane 'built'
 * segment permanently empty and builtFraction diverge from the airvia room's numbers the
 * moment a task was held.
 */
export function specProgress(repoCwd: string, dir: string | null, specId?: string): SpecProgress | null {
  if (!dir) return null;
  // Two copies of tasks.md can exist: the repo's, and a parallel lane's under
  // .spicyspec/worktrees/<id>/. Preferring the worktree unconditionally froze the founder's
  // progress bar at 35/61 for hours while the loop — back in single-spec mode, working the
  // repo itself — had ticked its way to 43/72: the worktree had not been touched since the
  // parallel era. Neither location is "the truth"; the one written most recently is.
  const candidates = specId
    ? [join(repoCwd, '.spicyspec', 'worktrees', specId, dir, 'tasks.md'), join(repoCwd, dir, 'tasks.md')]
    : [join(repoCwd, dir, 'tasks.md')];
  let path: string | null = null;
  let newest = -1;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    let mtime = 0;
    try {
      mtime = statSync(candidate).mtimeMs;
    } catch {
      continue;
    }
    if (mtime > newest) {
      newest = mtime;
      path = candidate;
    }
  }
  if (!path) return null;

  const seen = new Set<string>();
  let done = 0;
  let open = 0;
  let held = 0;
  let unmarked = 0;
  let deferred = 0;
  let currentWave: string | null = null;
  let waveAtFirstOpen: string | null = null;
  const waves: string[] = [];

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const wave = line.match(/^#{2,3}\s+(Wave\s+[^\n·]*)/i);
    if (wave) {
      currentWave = wave[1].trim();
      waves.push(currentWave);
    }
    if (!/^\s*-\s/.test(line)) continue;
    // Both id styles are real: the prototype wrote `- [x] **T001**`, airvia's lanes write
    // `- [x] T001` — the strict bold-only match rendered a working spec as "0 of 0". The
    // plain form is only accepted at the head of the bullet (after an optional checkbox),
    // so prose that merely mentions an id still does not count as a task.
    const tid =
      (line.match(/\*\*(T\d{3}[a-z]?)\*\*/) ?? [])[1] ??
      (line.match(/^\s*-\s*(?:\[[ xX]\]\s*)?(T\d{3}[a-z]?)\b/) ?? [])[1];
    if (!tid || seen.has(tid)) continue;
    seen.add(tid);

    if (/^\s*-\s*\[ \]/.test(line)) {
      // A row explicitly handed to a later spec is not this spec's open work. The runner
      // already counts it that way; the room did not, so a spec with every one of its own
      // rows closed read "74 of 100" on the founder's dashboard and looked unfinished
      // forever. Two surfaces disagreeing about the same file is the defect class this room
      // exists to kill, so the marker is honoured in exactly one place per side.
      if (/\bDEFERRED-TO-[A-Za-z0-9._-]+/.test(line)) {
        deferred += 1;
      } else {
        open += 1;
        if (!waveAtFirstOpen) waveAtFirstOpen = currentWave;
      }
    } else if (/^\s*-\s*\[[xX]\]/.test(line) || line.includes('✔')) done += 1;
    else if (/left unmarked|NOT CLOSED|✖|⚠/.test(line)) held += 1;
    else unmarked += 1;
  }

  return {
    done,
    open,
    held,
    unmarked,
    deferred,
    // The bar measures THIS spec: deferred rows are excluded, so 74 of 74 reads as finished
    // rather than 74 of 100 reading as stalled. The count itself stays visible beside it.
    total: seen.size - deferred,
    deferredTotal: seen.size,
    waves: waves.length,
    currentWave: waveAtFirstOpen ?? currentWave,
  };
}

async function buildRoomState(
  options: RoomOptions,
  brief: BriefModule,
  lanes: LaneLive[] = [],
  deck: DeckContext | null = null,
): Promise<Record<string, unknown>> {
  const { store, repoCwd } = options;
  const queue = await store.loadQueue();
  const runs = await store.listRuns();
  const pool = await store.loadPoolState();
  const now = Date.now();

  const runnersRaw = await store.listKv('runner:');
  const runners = runnersRaw
    .map((r) => {
      try {
        return JSON.parse(r.value) as { pid?: number; heartbeatAt?: string; startedAt?: string };
      } catch {
        return null;
      }
    })
    // The stop/kill flags live under the same prefix (runner:stop / runner:kill-now) and
    // are not runner records — a numeric pid is what makes a row a runner.
    .filter((r): r is { pid: number; heartbeatAt: string; startedAt?: string } => typeof r?.pid === 'number' && typeof r?.heartbeatAt === 'string');
  const liveRunner = runners.find((r) => now - Date.parse(r.heartbeatAt) < 90_000) ?? null;

  // Armed stop state is a store flag, not a guess: the original showed STOP / STOP-NOW file
  // existence, and a Kill button whose armed state never displays reads as a broken button.
  const [stopFlag, killFlag] = await Promise.all([store.getKv(STOP_KEY), store.getKv(KILL_KEY)]);
  const stop = parseArmedFlag(stopFlag);
  const kill = parseArmedFlag(killFlag);

  // What the supervisor says about each thing it watches. Read through listKv as well as the
  // one key, because the writer lives in another package and may have chosen either shape;
  // an absent report is a report of absence, never an assumption of health.
  const health = await readSupervisorReport(store, now);

  const specDirInWorktree = (id: string): string | null => {
    // A spec whose directory exists only on its lane branch is invisible in the main
    // tree — resolve against the worktree so shaping-stage lanes still show identity.
    try {
      const specsRoot = join(repoCwd, '.spicyspec', 'worktrees', id, 'specs');
      const hit = readdirSync(specsRoot).find((n) => n === id || n.startsWith(`${id}-`));
      return hit ? `specs/${hit}` : null;
    } catch {
      return null;
    }
  };
  const entries = await Promise.all(
    queue.entries.map(async (e) => {
      const dir = brief.specDirFor(repoCwd, e.id) ?? specDirInWorktree(e.id);
      const status = STATUS_TO_ROOM[String(e.status)] ?? String(e.status);
      const progress = specProgress(repoCwd, dir, e.id);
      // "The platform never marks its own work done": a spec that retired on an empty task
      // list without a recorded closing-gate APPROVE gets a loud flag, matching the
      // prototype's warn-not-block guard (driver.mjs:667-681). Absence means UNKNOWN, never
      // PASS — and the verdict is the LATEST record, not any record: a spec approved and then
      // re-reviewed REVISE is open, which an `any APPROVE` test would have called clean.
      let closingGateState: string | null = null;
      if ((status === 'awaiting-founder' || status === 'done') && progress && progress.open === 0) {
        try {
          closingGateState = closingGate(await store.listGates(e.id), e.id).state;
        } catch {
          closingGateState = null; // an unreadable gate table is its own problem, not this flag's
        }
      }
      const closingGateWarning = closingGateState != null && closingGateState !== 'approved';
      return {
        id: e.id,
        slug: dir ? dir.replace(/\\/g, '/').split('/').pop()?.replace(/^\d+-/, '') : null,
        dir,
        status,
        stage: e.stage ?? null,
        progress,
        closingGate: closingGateState,
        closingGateWarning,
      };
    }),
  );
  const actives = entries.filter((e) => e.status === 'active');
  const active = actives[0] ?? null;

  const sum = runs.reduce(
    (a, t) => ({
      cost: a.cost + (Number(t.costUsd) || 0),
      minutes: a.minutes + (Number(t.durationMinutes) || 0),
      closed: a.closed + (Number(t.tasksClosed) || 0),
    }),
    { cost: 0, minutes: 0, closed: 0 },
  );

  const [head, subject, branch, porcelain] = await Promise.all([
    git(repoCwd, ['rev-parse', '--short', 'HEAD']),
    git(repoCwd, ['log', '-1', '--format=%s']),
    git(repoCwd, ['branch', '--show-current']),
    git(repoCwd, ['status', '--porcelain']),
  ]);
  const dirtyPaths = dirtyPathsFrom(porcelain);

  // The header's one-look answer. Derived here rather than in the page so that the SSE
  // frames, the 15s poll backstop and the tests all read the same sentence.
  const activity = topLine({
    running: Boolean(liveRunner),
    lanes: lanes.length,
    stop,
    kill,
    rotation: health.rows.find((r) => r.check === 'rotation') ?? null,
    awaitingFounder: entries.filter((e) => e.status === 'awaiting-founder').length,
    reviewCap: reviewCapOf(options.configPath),
    pending: entries.filter((e) => e.status === 'pending').length,
    parked: entries.filter((e) => e.status === 'parked').length,
    heartbeatAt: runners.map((r) => r.heartbeatAt).sort().pop() ?? null,
    now,
  });

  /* ---- the deck's derivations. Every one of these is computed over the WHOLE ledger, not
   * the 40 rows the page renders: the founder is asked to act on comparisons ("2.2× the
   * median"), and a median taken from a rendering window is a different number. ---- */
  const ledger = ledgerDigest(runs as Array<Record<string, unknown>>, now);
  const eventRows = accountEventRows(runs as Array<Record<string, unknown>>, pool, now);
  const gates = deck ? deck.gates() : null;

  const accountsView = [...new Set([...(options.accountIds ?? []), ...Object.keys(pool)])].map((id) => {
    const a = pool[id] ?? {};
    const rows = runs.filter((t) => t['account'] === id);
    const last = rows[rows.length - 1] ?? null;
    const cold = (a.coldUntilMs ?? 0) > now;
    // The original read the last ledger row's rateResetsAt (epoch seconds — server.mjs:619);
    // the pool row may also carry a windowEndsAt already in ms. Either populates the
    // 'window HH:MM' chip, and `epochMs` refuses to multiply a millisecond value.
    const windowEndsAt = epochMs((a as Record<string, unknown>)['windowEndsAt']) ?? epochMs(last?.['rateResetsAt']);
    const opened = windowStartOf(runs as Array<Record<string, unknown>>, id, windowEndsAt);
    return {
      id,
      cold,
      coldMinutes: cold ? Math.ceil(((a.coldUntilMs ?? 0) - now) / 60000) : 0,
      refused: Boolean(a.refusedReason) && cold,
      refusedReason: a.refusedReason ?? null,
      ticks: a.uses ?? 0,
      runs: rows.length,
      cost: rows.reduce((s, t) => s + (Number(t.costUsd) || 0), 0),
      rateStatus: (last?.['rateStatus'] as string) ?? null,
      utilization: typeof last?.['utilization'] === 'number' ? last['utilization'] : null,
      // WHEN the utilization was reported, so the meter can hatch itself once the figure is
      // older than its budget instead of drawing a fill nobody has confirmed for six hours.
      utilizationAt: last?.['startedAt'] ? String(last['startedAt']) : null,
      lastUsedAt: last?.['startedAt'] ? String(last['startedAt']) : null,
      windowEndsAt,
      // Derived, and labelled as derived: nothing records when a rate window opened, so this
      // is the earliest run the room can prove was already inside it — a lower bound, never
      // an invented `end − 5h`.
      windowStartedAt: opened.at,
      windowStartedAtSource: opened.source,
      overageStatus: (last?.['overageStatus'] as string) ?? null,
    };
  });

  const anomalies = detectAnomalies({
    ledger,
    runs: runs as Array<Record<string, unknown>>,
    accounts: accountsView,
    healthRows: health.rows,
    supervisor: health.supervisor,
    activity,
    entries,
    gates: gates?.rows ?? [],
    activeSpec: active ? String(active.id) : null,
    now,
  });

  const owed = deck ? await deck.owed().catch(() => null) : null;
  const parked = parkedList(options, brief, entries.filter((e) => e.status === 'parked').map((e) => e.id));

  return {
    at: new Date().toISOString(),
    running: Boolean(liveRunner),
    stopArmed: Boolean(stopFlag),
    killArmed: Boolean(killFlag),
    // WHO armed it, and when. A flag with no author reads as nobody's, which is exactly how
    // an agent's stop survived a night nobody could explain.
    stopFlag: stop,
    killFlag: kill,
    activity,
    health,
    driver: liveRunner
      ? {
          pid: liveRunner.pid,
          workerPid: liveRunner.pid,
          code: 'spicyspec',
          config: options.projectName,
          // From the registration record the runner writes at boot — uptime never showed
          // while this was hardcoded null.
          startedAt: liveRunner.startedAt ?? null,
          heartbeat: liveRunner.heartbeatAt,
        }
      : null,
    git: { head, subject, branch, dirty: dirtyPaths.length, dirtyPaths: dirtyPaths.slice(0, 8) },
    catalog: {
      total: entries.length,
      signedOff: entries.filter((e) => e.status === 'done').length,
      awaitingFounder: entries.filter((e) => e.status === 'awaiting-founder').map((e) => e.id),
      parked: entries.filter((e) => e.status === 'parked').map((e) => e.id),
      pending: entries.filter((e) => e.status === 'pending').length,
      builtFraction: entries
        .filter((e) => e.status !== 'done')
        .reduce((s, e) => s + (e.progress?.total ? (e.progress.done + e.progress.held) / e.progress.total : 0), 0),
      entries,
    },
    active,
    actives,
    accounts: accountsView,
    // Per-switch narration: the prototype logged describePool on every tick start and every
    // switch; the founder named "visible account health". Derived from the run rows and the
    // pool rather than a new event table — the same facts, one writer.
    accountEvents: eventRows.slice(-6).map((e) => e.text),
    // The same events, stamped and typed, so the wire can put a switch in time order beside a
    // ruling and a ledger row. One derivation, two renderings.
    accountEventRows: eventRows,
    totals: {
      rows: runs.length,
      ticks: new Set(runs.map((t) => t.tick)).size,
      minutes: Math.round(sum.minutes),
      notional: Number(sum.cost.toFixed(2)),
      closed: sum.closed,
      billable: runs.filter((t) => t['usedOverage'] === true).length,
    },
    ticks: runs
      .slice(-40)
      .reverse()
      .map((t) => ({
        tick: t.tick,
        // The retry tag: an infra retry (rate-limited / refused / no-attempt) keeps its
        // number and carries an attempt marker — without it a founder cannot tell a real
        // tick from a retry and the run counts disagree with what airvia showed.
        attempt: (t['attempt'] as string) ?? null,
        exit: t.exit ?? null,
        account: (t['account'] as string) ?? null,
        minutes: Math.round(Number(t.durationMinutes) || 0),
        closed: t.tasksClosed ?? 0,
        cost: t.costUsd ?? null,
        head: (t['head'] as string) ?? null,
        spec: (t['spec'] as string) ?? (t['specId'] as string) ?? null,
        startedAt: (t['startedAt'] as string) ?? null,
        tracker: (t['judgeAction'] as string) ?? null,
        note: (t['note'] as string) ?? (t['judgedBy'] ? `judge ${t['judgedBy']}: ${t['judgeHonest'] === false ? 'dishonest' : 'ok'}` : ''),
        // Red-first residue, straight off the run row when the pipeline persisted it —
        // absence means unknown, never clean.
        redFirst: (t['redFirst'] as unknown) ?? (t['redFirstResidue'] as unknown) ?? null,
      })),
    // The Current-tick panel's data — one entry per live lane, from the pump's tails.
    live: lanes[0] ?? null,
    lanes,
    parked,
    /* ---- deck additions. Named so the page never has to invent a number it cannot cite. ---- */
    // The whole ledger, aggregated: BURN's four figures, the LEDGER WALL's six curves, and
    // every median an anomaly card compares against — each with its n and its exclusion line.
    ledger,
    // Board rulings, merged from the store and every exported JSONL, each row naming the file
    // it came from and the tree it judged. Notes are PREVIEWED here (the frame is pushed every
    // four seconds); /api/gates serves them whole for the pull-quote.
    gates: gates ?? { rows: [], total: 0, shown: 0, notePreview: null, byVerdict: {}, sources: [], problems: [], lastAt: null, revision: '0:' },
    // What is not normal, with the number that makes it not normal. An EMPTY list is the
    // normal case and renders nothing — an all-clear box is a chip that is always on.
    anomalies,
    // The owed count the annunciator needs every frame, memoised with its own age attached:
    // /api/owed walks git per item and a fresh count is not worth a git process every 4s.
    owed: owed ?? { count: null, complete: null, at: null, ageMs: null, stale: true },
    // How old each instrument is allowed to be before it must hatch itself. Served, not
    // hardcoded: the supervisor owns its own staleness grace and may change it.
    budgets: budgetsFor(health.supervisor.staleAfterMs),
    server: {
      startedAt: deck?.startedAt ?? null,
      uptimeMs: deck ? Math.max(0, now - Date.parse(deck.startedAt)) : null,
      pushIntervalMs: STATE_PUSH_MS,
    },
  };
}

/**
 * PARKED.md headings plus queue entries parked without a written diagnosis — the founder's
 * "what only I can clear" list. The parser already existed (founder-brief.mjs); this was
 * hardcoded [] while the same file was parsed two panels away.
 *
 * A parked entry with nothing written about it is listed anyway, and says so: the rotation
 * can park a spec by notification alone, and a park no founder can read is a park no founder
 * can clear.
 */
export function parkedList(options: RoomOptions, brief: BriefModule, parkedIds: string[] = []): string[] {
  const out: string[] = [];
  try {
    const parsed = brief.parseParked(options.repoCwd, '.spicyspec/PARKED.md');
    for (const item of parsed.items) out.push(item.date ? `${item.date} · ${item.reason}` : item.reason);
  } catch {
    /* a missing or malformed PARKED.md must not take the state down */
  }
  const written = out.join(' | ');
  for (const id of parkedIds) {
    if (!written.includes(id)) out.push(`${id} — parked with no diagnosis written to PARKED.md`);
  }
  return out;
}

/* ==================================================================== THE DECK ====
 *
 * Everything below exists because the deck asks questions a 40-row slice of the ledger
 * cannot answer: what is a run normally worth, which run was not normal, what ruled while
 * nobody watched, and where in all of it does a word appear.
 *
 * One rule governs the whole section and it is the product's core value: NEVER '0' FOR
 * UNKNOWN. Every aggregate carries its `n` and the rows it had to exclude, every derived
 * figure is `null` when its divisor or its source is absent, and every ruling names the file
 * it was read from. A zero that means "nothing recorded" is the same lie as a chip that is
 * always on.
 * ------------------------------------------------------------------------------------ */

/** The state push cadence. The page's freshness budget for `state` is three of these. */
export const STATE_PUSH_MS = 4000;
/** Points kept per ledger small-multiple. Newest last; the count is always declared. */
const SERIES_MAX = 240;
/** Rulings carried on every 4s frame (notes previewed); the rest come from /api/gates. */
const GATES_IN_STATE = 40;
const GATE_NOTE_PREVIEW = 220;
const GATES_MAX = 400;
const ACCOUNT_EVENT_ROWS = 24;
const ANOMALIES_MAX = 8;
/** /api/owed walks git per item, so the annunciator's count is memoised, and says its age. */
const OWED_CACHE_MS = 20_000;
const DIGEST_DEFAULT_MS = 8 * 3_600_000;
const SEARCH_LIMIT = 40;
const SEARCH_SNIPPET = 160;

const round2 = (v: number): number => Number(v.toFixed(2));
const isoOf = (v: unknown): string | null => {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const msOf = (v: unknown): number | null => {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : null;
};

/* --------------------------------------------------------------------- numbers ---- */

/**
 * A distribution, or the honest absence of one. `n` is never inferred and every field is
 * `null` at n === 0 — an anomaly card that compares a run against a median of zero is worse
 * than no card, because it reads as a measurement.
 */
export interface Stat {
  n: number;
  total: number;
  mean: number | null;
  median: number | null;
  p90: number | null;
  min: number | null;
  max: number | null;
}

export function statOf(values: readonly unknown[]): Stat {
  const nums = values
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  const n = nums.length;
  const total = nums.reduce((s, v) => s + v, 0);
  if (!n) return { n: 0, total: 0, mean: null, median: null, p90: null, min: null, max: null };
  const median = n % 2 ? nums[(n - 1) / 2] : (nums[n / 2 - 1] + nums[n / 2]) / 2;
  const p90 = nums[Math.min(n - 1, Math.max(0, Math.ceil(0.9 * n) - 1))];
  return { n, total: round2(total), mean: round2(total / n), median: round2(median), p90: round2(p90), min: round2(nums[0]), max: round2(nums[n - 1]) };
}

/**
 * How much of a population a figure was actually computed from, in the words the deck
 * prints under it: `16 of 40 rows carry a cost`. The exclusion line is not decoration —
 * it is the difference between "the median run costs $18.95" and a number that quietly
 * averaged twenty-four blanks as zero.
 */
export interface Coverage {
  n: number;
  of: number;
  missing: number;
  line: string;
  /** null when nothing was excluded — there is no honest sentence to print then */
  missingLine: string | null;
}

export function coverageOf(n: number, of: number, have: string, lack: string): Coverage {
  const missing = Math.max(0, of - n);
  const rows = (k: number) => `${k} of ${of} row${of === 1 ? '' : 's'}`;
  return {
    n,
    of,
    missing,
    line: `${rows(n)} carry ${have}`,
    missingLine: missing ? `${rows(missing)} carry ${lack}` : null,
  };
}

/** A derived rate with its divisor exposed. `value: null` means the divisor was zero. */
export interface Metric {
  value: number | null;
  n: number;
  basis: string;
}

const rate = (numerator: number, divisor: number, n: number, basis: string): Metric => ({
  value: divisor > 0 && n > 0 ? round2(numerator / divisor) : null,
  n,
  basis,
});

/* ---------------------------------------------------------------------- ledger ---- */

export interface LedgerSeries {
  n: number;
  of: number;
  tick: number[];
  at: Array<string | null>;
  cost: Array<number | null>;
  minutes: Array<number | null>;
  closed: Array<number | null>;
  verifyFailed: Array<number | null>;
  exit: Array<string | null>;
  account: Array<string | null>;
}

export interface LedgerDigest {
  rows: number;
  runs: number;
  retries: number;
  firstAt: string | null;
  lastAt: string | null;
  /** wall hours from the first stamped row to the last — null when nothing is stamped */
  spanHours: number | null;
  ageMs: number | null;
  priced: Coverage;
  stamped: Coverage;
  timed: Coverage;
  scored: Coverage;
  verified: Coverage;
  cost: Stat;
  minutes: Stat;
  closed: Stat;
  burn: { perHour: Metric; perRun: Metric; perTaskClosed: Metric; perRecordedHour: Metric };
  exits: Array<{ exit: string; n: number; cost: number }>;
  accounts: Array<{ account: string; n: number; cost: number; minutes: number; closed: number }>;
  series: LedgerSeries;
  /** changes whenever a row lands — the page refetches /api/ledger on a new value only */
  revision: string;
}

/** Verification failures as the pipeline recorded them; absent means unknown, never clean. */
function verifyFailedOf(t: Record<string, unknown>): number | null {
  for (const key of ['verifyFailed', 'verificationsFailed', 'verificationFailed']) {
    const v = t[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  const residue = t['redFirstResidue'] ?? t['redFirst'];
  if (Array.isArray(residue)) return residue.length;
  return null;
}

/**
 * The whole ledger, aggregated — the source for BURN, the LEDGER WALL and every anomaly
 * comparison. Deliberately computed over ALL rows rather than the 40 the page renders: a
 * median taken from the last forty runs of a 400-run marathon is a different number, and the
 * founder is asked to act on the comparison.
 */
export function ledgerDigest(runs: ReadonlyArray<Record<string, unknown>>, now: number): LedgerDigest {
  const of = runs.length;
  const costs = runs.map((t) => (typeof t['costUsd'] === 'number' ? (t['costUsd'] as number) : null));
  const mins = runs.map((t) => (typeof t['durationMinutes'] === 'number' ? (t['durationMinutes'] as number) : null));
  const closed = runs.map((t) => (typeof t['tasksClosed'] === 'number' ? (t['tasksClosed'] as number) : null));
  const verify = runs.map((t) => verifyFailedOf(t));
  const stamps = runs.map((t) => msOf(t['startedAt'])).filter((v): v is number => v != null);

  const cost = statOf(costs);
  const minutes = statOf(mins);
  const closedStat = statOf(closed);
  const distinct = new Set(runs.map((t) => t['tick'])).size;
  const retries = runs.filter((t) => typeof t['attempt'] === 'string' && t['attempt']).length;

  const firstMs = stamps.length ? Math.min(...stamps) : null;
  const lastMs = stamps.length ? Math.max(...stamps) : null;
  const spanHours = firstMs != null && lastMs != null && lastMs > firstMs ? round2((lastMs - firstMs) / 3_600_000) : null;
  const recordedHours = minutes.total / 60;

  const exits = new Map<string, { exit: string; n: number; cost: number }>();
  const accounts = new Map<string, { account: string; n: number; cost: number; minutes: number; closed: number }>();
  for (const t of runs) {
    const exit = String(t['exit'] ?? 'unrecorded');
    const e = exits.get(exit) ?? { exit, n: 0, cost: 0 };
    e.n += 1;
    e.cost = round2(e.cost + (Number(t['costUsd']) || 0));
    exits.set(exit, e);
    const id = String(t['account'] ?? 'unrecorded');
    const a = accounts.get(id) ?? { account: id, n: 0, cost: 0, minutes: 0, closed: 0 };
    a.n += 1;
    a.cost = round2(a.cost + (Number(t['costUsd']) || 0));
    a.minutes = Math.round(a.minutes + (Number(t['durationMinutes']) || 0));
    a.closed += Number(t['tasksClosed']) || 0;
    accounts.set(id, a);
  }

  const window = runs.slice(-SERIES_MAX);
  const series: LedgerSeries = {
    n: window.length,
    of,
    tick: window.map((t) => Number(t['tick']) || 0),
    at: window.map((t) => isoOf(t['startedAt'])),
    cost: window.map((t) => (typeof t['costUsd'] === 'number' ? round2(t['costUsd'] as number) : null)),
    minutes: window.map((t) => (typeof t['durationMinutes'] === 'number' ? Math.round(t['durationMinutes'] as number) : null)),
    closed: window.map((t) => (typeof t['tasksClosed'] === 'number' ? (t['tasksClosed'] as number) : null)),
    verifyFailed: window.map((t) => verifyFailedOf(t)),
    exit: window.map((t) => (t['exit'] == null ? null : String(t['exit']))),
    account: window.map((t) => (t['account'] == null ? null : String(t['account']))),
  };

  const last = runs[runs.length - 1] ?? null;
  return {
    rows: of,
    runs: distinct,
    retries,
    firstAt: firstMs != null ? new Date(firstMs).toISOString() : null,
    lastAt: lastMs != null ? new Date(lastMs).toISOString() : null,
    spanHours,
    ageMs: lastMs != null ? Math.max(0, now - lastMs) : null,
    priced: coverageOf(cost.n, of, 'a cost', 'no cost'),
    stamped: coverageOf(stamps.length, of, 'a start stamp', 'no start stamp'),
    timed: coverageOf(minutes.n, of, 'a duration', 'no duration'),
    scored: coverageOf(closedStat.n, of, 'a tasks-closed figure', 'no tasks-closed figure'),
    verified: coverageOf(statOf(verify).n, of, 'a verification result', 'no verification result'),
    cost,
    minutes,
    closed: closedStat,
    burn: {
      // Wall-clock burn across the recorded span — what the money actually cost per hour of
      // calendar time the loop was alive.
      perHour: rate(cost.total, spanHours ?? 0, cost.n, `${cost.n} priced row${cost.n === 1 ? '' : 's'} across ${spanHours ?? 0}h of stamped ledger`),
      // Burn per hour the runs themselves reported — a different, smaller denominator.
      perRecordedHour: rate(cost.total, recordedHours, Math.min(cost.n, minutes.n), `${cost.n} priced rows over ${round2(recordedHours)} recorded hours`),
      perRun: rate(cost.total, distinct, cost.n, `${cost.n} priced rows over ${distinct} distinct run number${distinct === 1 ? '' : 's'}`),
      perTaskClosed: rate(cost.total, closedStat.total, cost.n, `${cost.n} priced rows over ${closedStat.total} task${closedStat.total === 1 ? '' : 's'} closed`),
    },
    exits: [...exits.values()].sort((a, b) => b.n - a.n),
    accounts: [...accounts.values()].sort((a, b) => b.n - a.n),
    series,
    revision: `${of}:${String(last?.['tick'] ?? '')}:${String(last?.['startedAt'] ?? '')}:${String(last?.['exit'] ?? '')}`,
  };
}

/** The compact projection /api/ledger serves — every field the wire and the journal read. */
export function ledgerRows(runs: ReadonlyArray<Record<string, unknown>>, limit: number): Array<Record<string, unknown>> {
  return runs.slice(-Math.max(1, limit)).map((t) => ({
    tick: t['tick'],
    attempt: (t['attempt'] as string) ?? null,
    at: isoOf(t['startedAt']),
    exit: t['exit'] ?? null,
    account: (t['account'] as string) ?? null,
    spec: (t['spec'] as string) ?? (t['specId'] as string) ?? null,
    minutes: typeof t['durationMinutes'] === 'number' ? Math.round(t['durationMinutes'] as number) : null,
    closed: typeof t['tasksClosed'] === 'number' ? (t['tasksClosed'] as number) : null,
    cost: typeof t['costUsd'] === 'number' ? round2(t['costUsd'] as number) : null,
    verifyFailed: verifyFailedOf(t),
    head: (t['head'] as string) ?? null,
    commits: t['commits'] ?? null,
    note: (t['note'] as string) ?? '',
    source: 'ledger',
  }));
}

/* --------------------------------------------------------------------- rulings ---- */

/**
 * A board ruling as the WIRE reads it. `source` is the file it was read from and `frozen` the
 * tree it judged, so a row can print its own provenance (`GATES.jsonl · frozen ebe5e0c`)
 * rather than asking the founder to trust the room.
 */
export interface GateRow {
  at: string | null;
  spec: string;
  stage: string | null;
  gate: string;
  verdict: string;
  confidence: number | null;
  seat: string | null;
  frozen: string | null;
  note: string;
  /** length of the ORIGINAL note, so a preview can say how much it is hiding */
  noteChars: number;
  source: string;
  line: number | null;
}

export interface GateSource {
  source: string;
  path: string | null;
  records: GateRecord[];
  problems: string[];
  readAt: string | null;
}

export interface GateDigest {
  rows: GateRow[];
  total: number;
  shown: number;
  notePreview: number | null;
  byVerdict: Record<string, number>;
  sources: Array<{ source: string; path: string | null; rows: number; problems: number; readAt: string | null }>;
  problems: string[];
  lastAt: string | null;
  revision: string;
}

/**
 * Merge every place a ruling might live — the store's gate table and each exported JSONL —
 * into one river, oldest first. The same ruling is written twice on purpose (the DB is truth,
 * the JSONL is what humans diff), so it is deduplicated here; narrating a verdict twice is a
 * small lie in the one pane whose whole job is not telling them.
 *
 * The note is previewed, never dropped: `noteChars` always states the full length, so a row
 * can say how much of a 900-character ruling it is holding back.
 */
export function mergeGateRows(sources: readonly GateSource[], notePreview: number | null = null): GateRow[] {
  const seen = new Set<string>();
  const out: GateRow[] = [];
  for (const src of sources) {
    for (const r of src.records) {
      const full = typeof r.note === 'string' ? r.note : '';
      const at = isoOf(r.at) ?? (typeof r.at === 'string' ? r.at : null);
      const spec = String(r.spec);
      const gate = String(r.gate ?? 'wave');
      const verdict = String(r.verdict);
      const seat = r.seat != null ? String(r.seat) : null;
      const id = `${at ?? ''}|${spec}|${gate}|${verdict}|${seat ?? ''}|${full.slice(0, 80)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        at,
        spec,
        stage: r.stage != null ? String(r.stage) : null,
        gate,
        verdict,
        confidence: typeof r.confidence === 'number' ? r.confidence : null,
        seat,
        frozen: r.frozen != null ? String(r.frozen) : null,
        note: notePreview != null ? full.slice(0, notePreview) : full,
        noteChars: full.length,
        source: src.source,
        line: typeof r.line === 'number' ? r.line : null,
      });
    }
  }
  return out.sort((a, b) => (msOf(a.at) ?? 0) - (msOf(b.at) ?? 0));
}

export function gateDigest(sources: readonly GateSource[], limit: number, notePreview: number | null): GateDigest {
  const all = mergeGateRows(sources, notePreview);
  const rows = all.slice(-Math.max(1, limit));
  const byVerdict: Record<string, number> = {};
  for (const r of all) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  const lastAt = all.length ? all[all.length - 1].at : null;
  return {
    rows,
    total: all.length,
    shown: rows.length,
    notePreview,
    byVerdict,
    sources: sources.map((s) => ({ source: s.source, path: s.path, rows: s.records.length, problems: s.problems.length, readAt: s.readAt })),
    problems: sources.flatMap((s) => s.problems),
    lastAt,
    revision: `${all.length}:${lastAt ?? ''}`,
  };
}

/**
 * Where rulings are written in this deployment: the store's own table, the configured export,
 * and the board's journal. Every candidate is READ, and each one that answers is named — a
 * pane that silently prefers one file is a pane that goes blank the day the writer moves.
 */
export function gateSourcePaths(repoCwd: string, configPath: string): Array<{ source: string; path: string }> {
  const rel = new Set<string>(['.spicyspec/gates.jsonl', '.specify/board/GATES.jsonl']);
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const configured = raw['gateExportPath'];
    if (typeof configured === 'string' && configured.trim()) rel.add(configured.trim());
  } catch {
    /* no config here — the two conventional locations are still read */
  }
  return [...rel].map((p) => ({ source: p.replace(/\\/g, '/').split('/').pop() ?? p, path: join(repoCwd, p) }));
}

/* ------------------------------------------------------------------- accounts ---- */

/**
 * When did the account's CURRENT rate window open?
 *
 * Nothing records it, so it is derived from what is: rows that reported this same reset
 * instant were made inside this same window, and the earliest of them is the earliest moment
 * the room can PROVE the window was already running. That is a lower bound and it is labelled
 * as one — inventing `windowEndsAt − 5h` would draw a now-marker at a position no record
 * supports, which is precisely the class of thing this room exists not to do.
 */
export function windowStartOf(
  runs: ReadonlyArray<Record<string, unknown>>,
  accountId: string,
  windowEndsAt: number | null,
): { at: string | null; source: string | null } {
  if (windowEndsAt == null) return { at: null, source: null };
  let earliest: number | null = null;
  for (const t of runs) {
    if (String(t['account'] ?? '') !== accountId) continue;
    if (epochMs(t['rateResetsAt']) !== windowEndsAt) continue;
    const started = msOf(t['startedAt']);
    if (started == null) continue;
    if (earliest == null || started < earliest) earliest = started;
  }
  if (earliest == null) return { at: null, source: null };
  return { at: new Date(earliest).toISOString(), source: 'first-run-observed-in-this-window' };
}

export interface AccountEventRow {
  at: string | null;
  kind: 'switch' | 'cold' | 'refused' | 'cooling';
  account: string;
  from: string | null;
  tick: number | null;
  text: string;
  source: string;
}

/**
 * The BUREAU desk's rows: the same derivations the header's one-line narration has always
 * used, but stamped and typed so the wire can put them in time order beside a ruling and a
 * ledger row. The string list stays — one writer, two renderings.
 */
export function accountEventRows(
  runs: ReadonlyArray<Record<string, unknown>>,
  pool: Record<string, { coldUntilMs?: number; refusedReason?: string | null }>,
  now: number,
): AccountEventRow[] {
  const out: AccountEventRow[] = [];
  let prev: string | null = null;
  for (const t of runs.slice(-SERIES_MAX)) {
    const account = (t['account'] as string) ?? null;
    if (!account) continue;
    const at = isoOf(t['startedAt']);
    const tick = typeof t['tick'] === 'number' ? (t['tick'] as number) : null;
    if (prev && account !== prev) {
      out.push({ at, kind: 'switch', account, from: prev, tick, text: `run ${String(t['tick'])}: switched ${prev} → ${account}`, source: 'ledger' });
    }
    const exit = String(t['exit'] ?? '');
    if (exit === 'rate-limited' || exit === 'account-refused') {
      out.push({ at, kind: 'cooling', account, from: null, tick, text: `run ${String(t['tick'])}: ${account} went cold (${exit})`, source: 'ledger' });
    }
    prev = account;
  }
  for (const [id, a] of Object.entries(pool)) {
    if ((a.coldUntilMs ?? 0) > now) {
      const until = new Date(a.coldUntilMs ?? 0).toTimeString().slice(0, 5);
      out.push({
        at: new Date(now).toISOString(),
        kind: a.refusedReason ? 'refused' : 'cold',
        account: id,
        from: null,
        tick: null,
        text: `${id} is cold until ${until}${a.refusedReason ? ` — ${String(a.refusedReason).slice(0, 80)}` : ''}`,
        source: 'pool',
      });
    }
  }
  return out.slice(-ACCOUNT_EVENT_ROWS);
}

/* ------------------------------------------------------------------ anomalies ---- */

export type AnomalyLevel = 'alarm' | 'caution';

/**
 * One ranked card for the alarm zone. `headline` is always number → comparison → reason,
 * because the founder's question is never "is something odd" but "how odd, against what,
 * and why".
 */
export interface Anomaly {
  id: string;
  kind: string;
  level: AnomalyLevel;
  at: string | null;
  headline: string;
  evidence: string;
  source: string;
  rank: number;
}

/** Exits that mean the run did not do its job. Anything else is a run, not an incident. */
export const BAD_EXITS = new Set([
  'stalled', 'blocked', 'account-refused', 'no-progress', 'rate-limited', 'failed', 'error', 'aborted', 'timeout', 'crashed',
]);

const COST_OUTLIER_RATIO = 2;
const COST_ALARM_RATIO = 3;
const OUTLIER_MIN_N = 5;
const OUTLIER_SCAN = 12;
const STREAK_CAUTION = 2;
const STREAK_ALARM = 3;
const UTILIZATION_HOT = 0.85;
const STALE_LEDGER_RATIO = 3;
const BARREN_MIN = 3;
const BARREN_SCAN = 10;

export interface AnomalyInput {
  ledger: LedgerDigest;
  runs: ReadonlyArray<Record<string, unknown>>;
  accounts: ReadonlyArray<Record<string, unknown>>;
  healthRows: readonly HealthRow[];
  supervisor: SupervisorHealth;
  activity: TopLine;
  entries: ReadonlyArray<Record<string, unknown>>;
  gates: readonly GateRow[];
  activeSpec: string | null;
  now: number;
}

/**
 * What is NOT normal, said with the number that makes it not normal.
 *
 * Every rule here compares a recorded value against a recorded population and prints both.
 * No rule fires on a population too small to compare against (`OUTLIER_MIN_N`), because a
 * "2.2× the median" drawn from three rows is a coin toss wearing a statistic. Nothing is
 * emitted when nothing is wrong: the zone renders zero cards rather than an all-clear box,
 * since an all-clear box is a chip that is always on.
 */
export function detectAnomalies(input: AnomalyInput): Anomaly[] {
  const { ledger, runs, accounts, healthRows: rows, supervisor, activity, entries, gates, activeSpec, now } = input;
  const out: Anomaly[] = [];

  // 1 — the supervisor stopped reporting. Nothing below can be trusted while this is true,
  // so it outranks every measurement.
  if (!supervisor.reporting) {
    out.push({
      id: 'supervisor-silent',
      kind: 'supervisor',
      level: 'alarm',
      at: supervisor.lastAt,
      headline: supervisor.lastAt
        ? `The supervisor has not reported since ${sinceLabel(supervisor.lastAt, now)} — its own grace is ${Math.round(supervisor.staleAfterMs / 1000)}s.`
        : 'The supervisor has never reported — nothing is watching the loop.',
      evidence: supervisor.advice ?? INSTALL_HINT,
      source: 'health:supervisor',
      rank: 0,
    });
  }

  // 2 — a check the supervisor itself calls failed.
  const failed = rows.filter((r) => r.status === 'failed');
  if (failed.length) {
    out.push({
      id: 'health-failed',
      kind: 'health',
      level: 'alarm',
      at: failed.map((r) => r.checkedAt).filter(Boolean).sort().pop() ?? null,
      headline: `${failed.length} of ${rows.length} supervised checks report failed: ${failed.map((r) => r.label).join(', ')}.`,
      evidence: failed.map((r) => `${r.label}: ${r.reported ?? r.status}${r.detail ? ` — ${r.detail}` : ''}`).join(' · '),
      source: 'health:events',
      rank: 1,
    });
  }

  // 3 — a run that cost a multiple of what a run costs here.
  const median = ledger.cost.median;
  if (median != null && ledger.cost.n >= OUTLIER_MIN_N && median > 0) {
    const scan = runs.slice(-OUTLIER_SCAN);
    for (let i = 0; i < scan.length; i += 1) {
      const t = scan[i];
      const cost = typeof t['costUsd'] === 'number' ? (t['costUsd'] as number) : null;
      if (cost == null || cost < median * COST_OUTLIER_RATIO) continue;
      const ratio = round2(cost / median);
      const closed = typeof t['tasksClosed'] === 'number' ? (t['tasksClosed'] as number) : null;
      const tools = typeof t['toolCalls'] === 'number' ? (t['toolCalls'] as number) : null;
      const tail =
        closed === 0 && tools != null
          ? `, and made ${tools} tool calls for 0 tasks closed`
          : closed === 0
            ? ', and closed no tasks'
            : closed != null
              ? `, and closed ${closed} task${closed === 1 ? '' : 's'}`
              : ', and recorded no tasks-closed figure';
      out.push({
        // A run NUMBER is not unique: the ledger restarts numbering per spec, so two
        // different runs both call themselves "run 1". The card is addressed by the number
        // AND the instant it started, or one of them silently replaces the other in a
        // keyed list — which is how a real overspend disappears behind an older one.
        id: `cost-outlier:${String(t['tick'])}:${isoOf(t['startedAt']) ?? `row-${i}`}`,
        kind: 'cost',
        level: ratio >= COST_ALARM_RATIO ? 'alarm' : 'caution',
        at: isoOf(t['startedAt']),
        headline: `Run ${String(t['tick'])} cost $${cost.toFixed(2)} — ${ratio}× the $${median.toFixed(2)} median across ${ledger.cost.n} priced runs${tail}.`,
        evidence: ledger.priced.line,
        source: 'ledger',
        rank: 2,
      });
    }
  }

  // 4 — consecutive runs that did not do their job.
  let streak = 0;
  let streakAt: string | null = null;
  const streakExits: string[] = [];
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const exit = String(runs[i]['exit'] ?? '');
    if (!BAD_EXITS.has(exit)) break;
    streak += 1;
    streakExits.push(exit);
    streakAt = streakAt ?? isoOf(runs[i]['startedAt']);
  }
  if (streak >= STREAK_CAUTION) {
    out.push({
      id: 'bad-exit-streak',
      kind: 'exit',
      level: streak >= STREAK_ALARM ? 'alarm' : 'caution',
      at: streakAt,
      headline: `The last ${streak} runs all exited badly (${[...new Set(streakExits)].join(', ')}) — ${ledger.runs} runs are on record.`,
      evidence: ledger.exits.map((e) => `${e.exit} ${e.n}`).join(' · '),
      source: 'ledger',
      rank: 3,
    });
  }

  // 5 — money spent for no closed task, over a window big enough to mean something.
  const recent = runs.slice(-BARREN_SCAN);
  const barren = recent.filter((t) => (Number(t['costUsd']) || 0) > 0 && t['tasksClosed'] === 0);
  if (recent.length >= OUTLIER_MIN_N && barren.length >= BARREN_MIN) {
    const spent = round2(barren.reduce((s, t) => s + (Number(t['costUsd']) || 0), 0));
    out.push({
      id: 'spend-no-progress',
      kind: 'progress',
      level: 'caution',
      at: isoOf(barren[barren.length - 1]['startedAt']),
      headline: `${barren.length} of the last ${recent.length} runs closed no tasks and cost $${spent.toFixed(2)} between them.`,
      evidence: `${ledger.closed.total} tasks closed across ${ledger.runs} runs on record · ${ledger.scored.line}`,
      source: 'ledger',
      rank: 4,
    });
  }

  // 6 — nothing has SETTLED in far longer than a run takes here, while the room claims work.
  if (activity.state === 'WORKING' && ledger.minutes.median != null && ledger.ageMs != null && ledger.minutes.median > 0) {
    const budgetMs = ledger.minutes.median * 60_000 * STALE_LEDGER_RATIO;
    if (ledger.ageMs > budgetMs) {
      out.push({
        id: 'ledger-stale',
        kind: 'cadence',
        level: 'caution',
        at: ledger.lastAt,
        headline: `No run has settled in ${Math.round(ledger.ageMs / 60000)}m — ${round2(ledger.ageMs / 60000 / ledger.minutes.median)}× the ${ledger.minutes.median}m median across ${ledger.minutes.n} timed runs.`,
        evidence: `${ledger.timed.line} · last settled run ${ledger.lastAt ?? 'at an unrecorded time'}`,
        source: 'ledger',
        rank: 5,
      });
    }
  }

  // 7 — the accounts. All cold is the end of the night; one hot window is a warning.
  const cold = accounts.filter((a) => a['cold'] === true);
  if (accounts.length && cold.length === accounts.length) {
    out.push({
      id: 'accounts-all-cold',
      kind: 'accounts',
      level: 'alarm',
      at: new Date(now).toISOString(),
      headline: `All ${accounts.length} account${accounts.length === 1 ? ' is' : 's are'} cold — the rotation has nothing to run on.`,
      evidence: cold.map((a) => `${String(a['id'])}: ${String(a['coldMinutes'])}m${a['refusedReason'] ? ` — ${String(a['refusedReason']).slice(0, 60)}` : ''}`).join(' · '),
      source: 'pool',
      rank: 1,
    });
  } else if (cold.length) {
    out.push({
      id: 'accounts-cold',
      kind: 'accounts',
      level: 'caution',
      at: new Date(now).toISOString(),
      headline: `${cold.length} of ${accounts.length} accounts are cold.`,
      evidence: cold.map((a) => `${String(a['id'])}: ${String(a['coldMinutes'])}m${a['refusedReason'] ? ` — ${String(a['refusedReason']).slice(0, 60)}` : ''}`).join(' · '),
      source: 'pool',
      rank: 6,
    });
  }
  const hot = accounts.filter((a) => typeof a['utilization'] === 'number' && (a['utilization'] as number) >= UTILIZATION_HOT);
  if (hot.length) {
    out.push({
      id: 'accounts-hot',
      kind: 'accounts',
      level: 'caution',
      at: new Date(now).toISOString(),
      headline: `${hot.length} account${hot.length === 1 ? '' : 's'} report ${hot.map((a) => `${Math.round((a['utilization'] as number) * 100)}%`).join(', ')} of the rate window used.`,
      evidence: hot
        .map((a) => `${String(a['id'])} window ends ${a['windowEndsAt'] ? new Date(a['windowEndsAt'] as number).toTimeString().slice(0, 5) : 'at an unreported time'}`)
        .join(' · '),
      source: 'ledger',
      rank: 7,
    });
  }

  // 8 — a spec that retired without a recorded APPROVE.
  const warned = entries.filter((e) => e['closingGateWarning'] === true);
  if (warned.length) {
    out.push({
      id: 'closing-gate',
      kind: 'gate',
      level: 'caution',
      at: null,
      headline: `${warned.length} spec${warned.length === 1 ? '' : 's'} retired on an empty task list with no recorded closing-gate APPROVE: ${warned.map((e) => String(e['id'])).join(', ')}.`,
      evidence: warned.map((e) => `${String(e['id'])}: closing gate ${String(e['closingGate'] ?? 'unknown')}`).join(' · '),
      source: 'gates',
      rank: 8,
    });
  }

  // 9 — the active spec's latest ruling is not an approval.
  if (activeSpec) {
    const mine = gates.filter((g) => g.spec === activeSpec);
    const latest = mine[mine.length - 1] ?? null;
    if (latest && latest.verdict !== 'APPROVE') {
      out.push({
        id: `gate-open:${activeSpec}`,
        kind: 'gate',
        level: 'caution',
        at: latest.at,
        headline: `Spec ${activeSpec}'s latest ruling is ${latest.verdict} from ${latest.seat ?? 'an unnamed seat'}${latest.confidence != null ? ` at ${latest.confidence}` : ''} — ${mine.length} ruling${mine.length === 1 ? '' : 's'} on record for it.`,
        evidence: latest.note ? latest.note.slice(0, 240) : `${latest.source}${latest.frozen ? ` · frozen ${latest.frozen}` : ''}`,
        source: latest.source,
        rank: 9,
      });
    }
  }

  const level = (a: Anomaly) => (a.level === 'alarm' ? 0 : 1);
  return out
    .sort((a, b) => level(a) - level(b) || a.rank - b.rank || (msOf(b.at) ?? 0) - (msOf(a.at) ?? 0))
    .slice(0, ANOMALIES_MAX);
}

/* --------------------------------------------------------------------- digest ---- */

export interface DigestInput {
  sinceMs: number;
  untilMs: number;
  runs: ReadonlyArray<Record<string, unknown>>;
  gates: readonly GateRow[];
  healthEvents: readonly HealthEvent[];
  accountEvents: readonly AccountEventRow[];
  entries: ReadonlyArray<Record<string, unknown>>;
  parked: readonly string[];
  commits: ReadonlyArray<{ sha: string; at: string | null; subject: string }>;
  owed: number | null;
}

export interface Digest {
  window: { since: string; until: string; ms: number };
  numbers: {
    runs: number;
    rows: number;
    tasksClosed: number;
    costUsd: number;
    minutes: number;
    commits: number;
    priced: Coverage;
  };
  ruled: GateRow[];
  broke: { exits: Array<Record<string, unknown>>; health: HealthEvent[]; accounts: AccountEventRow[] };
  needsYou: { parked: string[]; awaitingFounder: string[]; closingGateWarnings: string[]; owed: number | null };
  commits: Array<{ sha: string; at: string | null; subject: string }>;
  coverage: {
    rowsInWindow: number;
    rowsWithoutStamp: number;
    excludedLine: string | null;
    firstAt: string | null;
    lastAt: string | null;
  };
}

/**
 * WHILE YOU SLEPT, from records only.
 *
 * The hardest part of this shape is the last field: a run row with no `startedAt` cannot be
 * placed in any window, so it is counted, named and EXCLUDED rather than swept into the
 * period the founder happens to be reading. "6 of 82 rows carry no start stamp and are not in
 * this window" is the sentence that keeps the rest of the digest true.
 */
export function composeDigest(input: DigestInput): Digest {
  const { sinceMs, untilMs } = input;
  const inWindow = (iso: unknown): boolean => {
    const t = msOf(iso);
    return t != null && t >= sinceMs && t <= untilMs;
  };

  const unstamped = input.runs.filter((t) => msOf(t['startedAt']) == null).length;
  const rows = input.runs.filter((t) => inWindow(t['startedAt']));
  const priced = rows.filter((t) => typeof t['costUsd'] === 'number');
  const stamps = rows.map((t) => msOf(t['startedAt'])).filter((v): v is number => v != null);

  return {
    window: { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString(), ms: Math.max(0, untilMs - sinceMs) },
    numbers: {
      runs: new Set(rows.map((t) => t['tick'])).size,
      rows: rows.length,
      tasksClosed: rows.reduce((s, t) => s + (Number(t['tasksClosed']) || 0), 0),
      costUsd: round2(rows.reduce((s, t) => s + (Number(t['costUsd']) || 0), 0)),
      minutes: Math.round(rows.reduce((s, t) => s + (Number(t['durationMinutes']) || 0), 0)),
      commits: input.commits.length,
      priced: coverageOf(priced.length, rows.length, 'a cost', 'no cost'),
    },
    ruled: input.gates.filter((g) => inWindow(g.at)),
    broke: {
      exits: ledgerRows(
        rows.filter((t) => BAD_EXITS.has(String(t['exit'] ?? ''))),
        200,
      ),
      health: input.healthEvents.filter((e) => inWindow(e.at)),
      accounts: input.accountEvents.filter((e) => inWindow(e.at)),
    },
    needsYou: {
      parked: [...input.parked],
      awaitingFounder: input.entries.filter((e) => e['status'] === 'awaiting-founder').map((e) => String(e['id'])),
      closingGateWarnings: input.entries.filter((e) => e['closingGateWarning'] === true).map((e) => String(e['id'])),
      owed: input.owed,
    },
    commits: [...input.commits],
    coverage: {
      rowsInWindow: rows.length,
      rowsWithoutStamp: unstamped,
      excludedLine: unstamped ? `${unstamped} of ${input.runs.length} ledger rows carry no start stamp and are not in this window` : null,
      firstAt: stamps.length ? new Date(Math.min(...stamps)).toISOString() : null,
      lastAt: stamps.length ? new Date(Math.max(...stamps)).toISOString() : null,
    },
  };
}

/** `git log --since` as rows the digest can print and the wire can place in time. */
export const COMMIT_SEP = '\u001f';
/**
 * A commit subject may contain any printable character a founder ever typed — '|' and tabs
 * included — so the log format joins its fields on a control code git never emits from %s,
 * and the parser below splits on that same code. A '|' in a subject used to eat the subject.
 */
export const COMMIT_FORMAT = ['%h', '%aI', '%s'].join(COMMIT_SEP);

export function parseCommitLog(out: string): Array<{ sha: string; at: string | null; subject: string }> {
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, at, ...rest] = line.split(COMMIT_SEP);
      return { sha: String(sha ?? '').trim(), at: isoOf(at), subject: rest.join(COMMIT_SEP) };
    })
    .filter((c) => c.sha.length > 0);
}

/* --------------------------------------------------------------------- search ---- */

export interface SearchDoc {
  kind: string;
  id: string;
  title: string;
  body: string;
  at: string | null;
  source: string;
}

export interface SearchHit {
  kind: string;
  id: string;
  title: string;
  snippet: string | null;
  at: string | null;
  source: string;
  score: number;
}

/**
 * The palette's corpus search. Deliberately dumb and deliberately AND: every term must appear
 * somewhere in the row, because a palette that returns near-misses makes the founder read a
 * list instead of pressing Enter. Title hits weigh triple — the thing named is usually the
 * thing wanted — and ties break on recency, since this room is a log.
 */
export function searchCorpus(docs: readonly SearchDoc[], query: string, limit = SEARCH_LIMIT): SearchHit[] {
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return [];
  const hits: SearchHit[] = [];
  for (const doc of docs) {
    const title = doc.title.toLowerCase();
    const body = doc.body.toLowerCase();
    let score = 0;
    let ok = true;
    let firstAt = -1;
    for (const term of terms) {
      const inTitle = title.includes(term);
      const at = body.indexOf(term);
      if (!inTitle && at < 0) {
        ok = false;
        break;
      }
      if (inTitle) score += title.startsWith(term) ? 5 : 3;
      if (at >= 0) {
        score += 1;
        if (firstAt < 0) firstAt = at;
      }
    }
    if (!ok) continue;
    const start = firstAt < 0 ? 0 : Math.max(0, firstAt - 40);
    const snippet = doc.body
      ? (start > 0 ? '…' : '') + doc.body.slice(start, start + SEARCH_SNIPPET) + (doc.body.length > start + SEARCH_SNIPPET ? '…' : '')
      : null;
    hits.push({ kind: doc.kind, id: doc.id, title: doc.title, snippet, at: doc.at, source: doc.source, score });
  }
  return hits.sort((a, b) => b.score - a.score || (msOf(b.at) ?? 0) - (msOf(a.at) ?? 0)).slice(0, Math.max(1, limit));
}

/** Everything the palette can find, built from what the room already holds. */
export function buildCorpus(input: {
  entries: ReadonlyArray<Record<string, unknown>>;
  runs: ReadonlyArray<Record<string, unknown>>;
  gates: readonly GateRow[];
  parked: readonly string[];
  healthEvents: readonly HealthEvent[];
  accountEvents: readonly AccountEventRow[];
}): SearchDoc[] {
  const docs: SearchDoc[] = [];
  for (const e of input.entries) {
    docs.push({
      kind: 'spec',
      id: String(e['id']),
      title: `Spec ${String(e['id'])}${e['slug'] ? ` · ${String(e['slug'])}` : ''}`,
      body: [e['status'], e['stage'], e['dir'], e['closingGate']].filter(Boolean).map(String).join(' '),
      at: null,
      source: 'queue',
    });
  }
  for (const g of input.gates) {
    docs.push({
      kind: 'gate',
      id: `${g.spec}:${g.at ?? ''}:${g.gate}`,
      title: `${g.verdict} · spec ${g.spec} · ${g.gate}${g.seat ? ` · ${g.seat}` : ''}`,
      body: `${g.note} ${g.stage ?? ''} ${g.frozen ?? ''}`.trim(),
      at: g.at,
      source: g.source,
    });
  }
  for (const t of input.runs.slice(-SERIES_MAX)) {
    docs.push({
      kind: 'run',
      id: String(t['tick']),
      title: `Run ${String(t['tick'])}${t['exit'] ? ` · ${String(t['exit'])}` : ''}${t['account'] ? ` · ${String(t['account'])}` : ''}`,
      body: [t['note'], t['spec'], t['specId'], t['head'], t['attempt'], t['judgeAction']].filter(Boolean).map(String).join(' '),
      at: isoOf(t['startedAt']),
      source: 'ledger',
    });
  }
  for (const p of input.parked) docs.push({ kind: 'parked', id: p.slice(0, 60), title: 'Parked', body: p, at: null, source: 'PARKED.md' });
  for (const e of input.healthEvents) {
    docs.push({
      kind: 'health',
      id: `${e.check}:${e.at}`,
      title: `${e.check} · ${e.status}`,
      body: String(e.detail ?? ''),
      at: isoOf(e.at),
      source: 'health:events',
    });
  }
  for (const e of input.accountEvents) docs.push({ kind: 'account', id: `${e.account}:${e.at ?? ''}`, title: e.account, body: e.text, at: e.at, source: e.source });
  return docs;
}

/* -------------------------------------------------------------------- budgets ---- */

/**
 * The freshness budget for each instrument, SERVED rather than hardcoded in the page: the
 * supervisor's staleness grace is a config the supervisor owns, and a page that had copied
 * 180000 into itself would go on calling a supervisor healthy for three minutes after that
 * supervisor decided its own limit was thirty seconds.
 */
export function budgetsFor(supervisorStaleAfterMs: number): Record<string, number> {
  return {
    push: STATE_PUSH_MS,
    state: STATE_PUSH_MS * 3,
    heartbeat: 30_000,
    health: supervisorStaleAfterMs,
    ticks: 600_000,
    gates: 3_600_000,
  };
}

/* ------------------------------------------------------------- deck context ---- */

/**
 * The per-room caches the deck needs. Both entries here exist because their sources are
 * expensive on a 4-second cadence and cheap to invalidate honestly: rulings are re-read only
 * when a file's size or mtime moves, and the owed count is memoised with its own age attached
 * so the annunciator can hatch itself rather than assert a stale number as current.
 */
export interface DeckContext {
  gates(): GateDigest;
  gatesFull(limit: number): GateDigest;
  owed(): Promise<{ count: number | null; complete: number | null; at: string | null; ageMs: number | null; stale: boolean }>;
  startedAt: string;
}

export function createDeckContext(args: {
  store: Store;
  repoCwd: string;
  configPath: string;
  owedIndex: () => Promise<Array<Record<string, unknown>>>;
  now?: () => number;
}): DeckContext {
  const now = args.now ?? (() => Date.now());
  const startedAt = new Date(now()).toISOString();
  const fileCache = new Map<string, { stamp: string; records: GateRecord[]; problems: string[]; readAt: string }>();
  /** Rulings the STORE holds. Refreshed off-cycle so no request pays for the read. */
  let storeRecords: GateRecord[] = [];

  const readFileSource = (source: string, path: string): GateSource | null => {
    let stamp: string;
    try {
      const st = statSync(path);
      stamp = `${st.size}:${st.mtimeMs}`;
    } catch {
      fileCache.delete(path);
      return null; // a source that is not there is not a source — never an empty assertion
    }
    const hit = fileCache.get(path);
    if (!hit || hit.stamp !== stamp) {
      try {
        const parsed = parseGateRecords(readFileSync(path, 'utf8'), source);
        fileCache.set(path, { stamp, records: parsed.records, problems: parsed.problems, readAt: new Date(now()).toISOString() });
      } catch (err) {
        fileCache.set(path, { stamp, records: [], problems: [`${source}: ${String((err as Error).message)}`], readAt: new Date(now()).toISOString() });
      }
    }
    const row = fileCache.get(path);
    return row ? { source, path, records: row.records, problems: row.problems, readAt: row.readAt } : null;
  };

  const sources = (): GateSource[] => {
    const out: GateSource[] = [{ source: 'store', path: null, records: storeRecords, problems: [], readAt: new Date(now()).toISOString() }];
    for (const { source, path } of gateSourcePaths(args.repoCwd, args.configPath)) {
      const read = readFileSource(source, path);
      if (read) out.push(read);
    }
    return out;
  };

  void args.store
    .listGates()
    .then((rows) => {
      storeRecords = rows;
    })
    .catch(() => undefined);
  const refresh = setInterval(() => {
    void args.store
      .listGates()
      .then((rows) => {
        storeRecords = rows;
      })
      .catch(() => undefined);
  }, 30_000);
  refresh.unref?.();

  let owedCache: { count: number; complete: number; at: number } | null = null;
  let owedInFlight: Promise<void> | null = null;

  return {
    startedAt,
    gates: () => gateDigest(sources(), GATES_IN_STATE, GATE_NOTE_PREVIEW),
    gatesFull: (limit: number) => gateDigest(sources(), Math.min(Math.max(1, limit), GATES_MAX), null),
    async owed() {
      const age = owedCache ? now() - owedCache.at : Infinity;
      if (age > OWED_CACHE_MS && !owedInFlight) {
        owedInFlight = args
          .owedIndex()
          .then((items) => {
            owedCache = {
              count: items.length,
              complete: items.filter((i) => (i['progress'] as { complete?: boolean } | null)?.complete === true).length,
              at: now(),
            };
          })
          .catch(() => undefined)
          .then(() => {
            owedInFlight = null;
          });
        // First ever read has nothing to serve but a guess, and a guess is not served: wait.
        if (!owedCache) await owedInFlight;
      }
      const ageMs = owedCache ? now() - owedCache.at : 0;
      return {
        count: owedCache ? owedCache.count : null,
        complete: owedCache ? owedCache.complete : null,
        at: owedCache ? new Date(owedCache.at).toISOString() : null,
        ageMs: owedCache ? ageMs : null,
        stale: owedCache ? ageMs > OWED_CACHE_MS * 2 : true,
      };
    },
  };
}

/* --------------------------------------------------------------------- sign-off ---- */

async function isSignedOff(repoCwd: string, id: string): Promise<boolean> {
  const tags = await git(repoCwd, ['tag', '--list', `signed-off/${id}`]);
  return tags.split('\n').some((t) => t.trim() === `signed-off/${id}`);
}

/* ----------------------------------------------------------------------- server ---- */

/* --------------------------------------------------------------- live session feed ----
 * The Current-tick panel's engine: tail the newest `.spicyspec/runs/<...>/stream.jsonl`
 * (written live by the runner), ingest through the vendored agents registry, broadcast the
 * prototype's SSE events. Polled, not watched — Windows fs.watch misses appends, and a
 * frozen feed reads as a quiet worker, the worst failure a liveness view can have.
 * Deltas follow the prototype's B38 rule: offsets count against activityCount (which only
 * grows), never the retained window (which shrinks at its cap).
 * ------------------------------------------------------------------------------------ */

interface LaneTail {
  /** the spec id this tail belongs to — carried so a retired tail stays addressable */
  lane: string;
  dir: string;
  offset: number;
  partial: string;
  reg: Record<string, unknown>;
  meta: Record<string, unknown> | null;
  seen: Map<string, number>;
  ended: boolean;
  // Current-tick panel counters — kept here so the panel costs nothing extra to serve.
  tools: number;
  shell: number;
  /** Shell calls matching the verification patterns ONLY — 'verify cmds' once counted every
   * Bash call, so a worker doing 30 greps showed 30 "verifications". The number must mean
   * what the label says (prototype harvest.mjs classifier). */
  verify: number;
  subagents: number;
  actions: Array<{ tool: string; hint: string }>;
  say: string;
}

export interface LaneLive {
  id: string;
  spec: string;
  stage: string;
  account: string;
  startedAt: number | null;
  tools: number;
  verification: number;
  subagents: number;
  actions: Array<{ tool: string; hint: string }>;
  say: string;
}

const LANE_FRESH_MS = 15 * 60_000;

/** Both shells are commands to be counted. The gate was `name === 'Bash'`, and this
 * workspace is win32 where the provider adapter treats PowerShell as a shell tool
 * (provider-claude claude-adapter SHELL_TOOLS) — so 'verify cmds' read 0 through a whole
 * run of `pnpm nx test` calls made from PowerShell. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/** How many reaped lane registries stay addressable — see `retire` below. */
const REAPED_KEPT = 8;

/**
 * Multi-lane pump: one tail per live run directory. The single-tail version followed the
 * NEWEST dir by mtime — under 3 concurrent lanes that flip-flopped every poll, resetting
 * the registry each switch, and the Current-tick panel read "starting up…" forever while
 * three sessions worked. Every lane is tailed; agents are namespaced by spec id.
 */
function createLivePump(runsRoot: string, agentsMod: AgentsModule, broadcast: (event: string, data: unknown) => void) {
  const tails = new Map<string, LaneTail>(); // keyed by lane (spec id)
  /**
   * Ended lanes, still addressable. The prototype NEVER deleted a registry — it replaced it
   * on a tick roll and pushed reset:true (ui/server.mjs:238-243), so the sheet could always
   * resolve whatever the page was still showing. Deleting a reaped tail here broke that: the
   * History list is accumulated in the page and survives the reap, so its rows opened a 404
   * once a lane went quiet. Newest last, capped at REAPED_KEPT.
   */
  const reaped: LaneTail[] = [];
  const retire = (tail: LaneTail) => {
    reaped.push(tail);
    if (reaped.length > REAPED_KEPT) reaped.splice(0, reaped.length - REAPED_KEPT);
  };

  const readMeta = (dir: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const freshDirs = (): Array<{ dir: string; meta: Record<string, unknown> }> => {
    try {
      const out: Array<{ dir: string; meta: Record<string, unknown> }> = [];
      for (const n of readdirSync(runsRoot)) {
        const dir = join(runsRoot, n);
        let m = 0;
        try {
          m = statSync(join(dir, 'stream.jsonl')).mtimeMs;
        } catch {
          continue;
        }
        if (Date.now() - m > LANE_FRESH_MS) continue;
        const meta = readMeta(dir);
        if (meta) out.push({ dir, meta });
      }
      return out;
    } catch {
      return [];
    }
  };

  const newTail = (lane: string, dir: string, meta: Record<string, unknown>): LaneTail => ({
    lane,
    dir,
    offset: 0,
    partial: '',
    reg: agentsMod.createRegistry({
      name: `run ${String(meta['number'])}`,
      description: `${String(meta['spec'])}/${String(meta['stage'])} via ${String(meta['account'])}`,
      startedAt: (meta['startedAt'] as string) ?? null,
    }),
    meta,
    seen: new Map(),
    ended: false,
    tools: 0,
    shell: 0,
    verify: 0,
    subagents: 0,
    actions: [],
    say: '',
  });

  const laneId = (a: Record<string, unknown>, lane: string): string => `${lane}·${String(a['id'])}`;

  const hintFor = (input: Record<string, unknown>): string => {
    const raw = input['command'] ?? input['file_path'] ?? input['description'] ?? input['prompt'] ?? input['pattern'] ?? '';
    return String(raw).slice(0, 90);
  };

  const track = (tail: LaneTail, line: Record<string, unknown>) => {
    if (line['type'] === 'session_end') {
      tail.ended = true;
      return;
    }
    if (line['type'] === 'assistant') {
      const content = ((line['message'] as Record<string, unknown>)?.['content'] as Array<Record<string, unknown>>) ?? [];
      for (const b of content) {
        if (b['type'] === 'tool_use') {
          tail.tools += 1;
          const name = String(b['name'] ?? '');
          if (name === 'Task' || name === 'Agent') tail.subagents += 1;
          if (SHELL_TOOLS.has(name)) {
            tail.shell += 1;
            const command = String((b['input'] as Record<string, unknown>)?.['command'] ?? '').replace(/\s+/g, ' ');
            if (DEFAULT_VERIFICATION_PATTERNS.some((re) => re.test(command))) tail.verify += 1;
          }
          tail.actions.push({ tool: name, hint: hintFor((b['input'] as Record<string, unknown>) ?? {}) });
          if (tail.actions.length > 8) tail.actions.splice(0, tail.actions.length - 8);
        }
        if (b['type'] === 'text' && line['parent_tool_use_id'] == null) {
          const s = String(b['text'] ?? '').trim();
          if (s) tail.say = s.slice(0, 220);
        }
      }
    }
  };

  const mergedCounts = (): Record<string, number> => {
    const sum: Record<string, number> = {};
    for (const tail of tails.values()) {
      const snap = agentsMod.snapshot(tail.reg, { detail: false });
      for (const [k, v] of Object.entries(snap.counts ?? {})) sum[k] = (sum[k] ?? 0) + Number(v ?? 0);
    }
    return sum;
  };

  const pumpLane = (lane: string, tail: LaneTail) => {
    const path = join(tail.dir, 'stream.jsonl');
    if (!existsSync(path)) return;
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    if (size <= tail.offset) return;
    let chunk: string;
    try {
      chunk = readFileSync(path).subarray(tail.offset, size).toString('utf8');
    } catch {
      return;
    }
    tail.offset = size;
    const text = tail.partial + chunk;
    const lines = text.split('\n');
    tail.partial = lines.pop() ?? '';

    const changed = new Set<string>();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        track(tail, parsed);
        for (const id of agentsMod.ingest(tail.reg, parsed)) changed.add(id);
      } catch {
        /* skip bad line */
      }
    }
    if (!changed.size) return;

    const full = agentsMod.snapshot(tail.reg, { detail: true });
    const byId = new Map(full.agents.map((a) => [String(a['id']), a]));
    const agents: Array<Record<string, unknown>> = [];
    const activity: Array<{ id: string; entry: unknown }> = [];
    for (const id of changed) {
      const a = byId.get(id);
      if (!a) continue;
      const { prompt, summary, activity: acts, activityCount, ...base } = a as Record<string, unknown> & {
        activity?: unknown[];
        activityCount?: number;
      };
      void prompt;
      void summary;
      agents.push({ ...base, id: laneId(base, lane), lane, name: `${lane} · ${String(base['name'] ?? '')}` });
      const count = Number(activityCount ?? 0);
      const window = (acts as unknown[]) ?? [];
      const sent = tail.seen.get(id) ?? Math.max(0, count - window.length);
      const fresh = Math.min(count - sent, window.length);
      if (fresh > 0) for (const entry of window.slice(window.length - fresh)) activity.push({ id: laneId(a, lane), entry });
      tail.seen.set(id, count);
    }
    broadcast('agents', { agents, activity: activity.slice(-150), counts: mergedCounts(), meta: tail.meta });
  };

  const pump = () => {
    for (const { dir, meta } of freshDirs()) {
      const lane = String(meta['spec'] ?? dir.split(/[\\/]/).pop());
      const existing = tails.get(lane);
      if (!existing || existing.dir !== dir) {
        // A newer run for this lane replaces the old tail — reset only THIS lane. The
        // replaced registry is retired, not dropped: a page that missed the reset frame
        // (an SSE reconnect) is still showing its rows.
        if (existing) retire(existing);
        tails.set(lane, newTail(lane, dir, meta));
        broadcast('tick', { id: dir.split(/[\\/]/).pop(), lane, meta, reset: true });
      }
    }
    for (const [lane, tail] of [...tails.entries()]) {
      pumpLane(lane, tail);
      let stale = true;
      try {
        stale = Date.now() - statSync(join(tail.dir, 'stream.jsonl')).mtimeMs > LANE_FRESH_MS;
      } catch {
        stale = true;
      }
      if (tail.ended && stale) {
        tails.delete(lane);
        retire(tail);
      }
    }
  };

  return {
    pump,
    hello(): unknown {
      const agents: unknown[] = [];
      let meta: Record<string, unknown> | null = null;
      for (const [lane, tail] of tails.entries()) {
        const snap = agentsMod.snapshot(tail.reg, { detail: false });
        for (const a of snap.agents) agents.push({ ...a, id: laneId(a, lane), lane, name: `${lane} · ${String(a['name'] ?? '')}` });
        meta = meta ?? tail.meta;
      }
      return { agents, counts: mergedCounts(), meta, where: null };
    },
    /**
     * The full record for one agent, by its lane-namespaced id ('<lane>·<rawId>'). Fetched
     * once when a sheet opens — prompt and summary are too big to push on every frame, which
     * is why the feed strips them and this endpoint exists.
     *
     * Retired registries are searched after the live one, newest first: agent ids are the
     * run's own tool_use ids, so a miss in the live registry is not ambiguous, and a
     * History row whose lane has since been reaped must still open.
     */
    detail(namespacedId: string): Record<string, unknown> | null {
      const sep = namespacedId.indexOf('·');
      if (sep < 0) return null;
      const lane = namespacedId.slice(0, sep);
      const rawId = namespacedId.slice(sep + 1);
      const liveTail = tails.get(lane);
      let d = liveTail ? agentsMod.agentDetail(liveTail.reg, rawId) : null;
      for (let i = reaped.length - 1; !d && i >= 0; i -= 1) {
        if (reaped[i].lane === lane) d = agentsMod.agentDetail(reaped[i].reg, rawId);
      }
      if (!d) return null;
      // Re-namespace every id the sheet joins against the feed's agents — the feed sent
      // namespaced ids, so a bare child id here would match nothing.
      return {
        ...d,
        id: namespacedId,
        lane,
        parentId: d['parentId'] != null ? `${lane}·${String(d['parentId'])}` : null,
        children: ((d['children'] as unknown[]) ?? []).map((c) => `${lane}·${String(c)}`),
      };
    },
    /**
     * The primary lane's registry view, for the derived narrative: agents, the root's own
     * narration, and the run meta. First non-ended lane by spec order — with the single-spec
     * flow pinned there is exactly one.
     */
    primary(): { agents: Array<Record<string, unknown>>; narration: unknown[]; meta: Record<string, unknown> | null } | null {
      const live = [...tails.entries()].filter(([, t]) => !t.ended).sort(([a], [b]) => a.localeCompare(b));
      const first = live[0] ?? [...tails.entries()].sort(([a], [b]) => a.localeCompare(b))[0];
      if (!first) return null;
      const [, tail] = first;
      return {
        agents: agentsMod.snapshot(tail.reg, { detail: false }).agents,
        narration: ((tail.reg as Record<string, unknown>)['narration'] as unknown[]) ?? [],
        meta: tail.meta,
      };
    },
    lanes(): LaneLive[] {
      return [...tails.entries()]
        .filter(([, tail]) => !tail.ended)
        .map(([lane, tail]) => ({
          id: String(tail.dir.split(/[\\/]/).pop()),
          spec: lane,
          stage: String(tail.meta?.['stage'] ?? '?'),
          account: String(tail.meta?.['account'] ?? '?'),
          startedAt: tail.meta?.['startedAt'] ? Date.parse(String(tail.meta['startedAt'])) : null,
          tools: tail.tools,
          verification: tail.verify,
          subagents: tail.subagents,
          actions: [...tail.actions],
          say: tail.say,
        }))
        .sort((a, b) => a.spec.localeCompare(b.spec));
    },
  };
}

/**
 * What each asset is, declared — and the reason this map is not two lines any more.
 *
 * Responses here carry `X-Content-Type-Options: nosniff`, so a type this map does not know is
 * served as `application/octet-stream` and the browser REFUSES it. That is exactly what
 * happened to the room's sibling ES modules: `<script type="module" src="./agents.mjs">` got
 * octet-stream and every module import failed, silently, with a working-looking page behind
 * it. Every extension the room ships must appear here or it does not load at all.
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/** Types that are bytes, not text: reading these as utf8 would corrupt them silently. */
const BINARY_EXT = new Set(['.ico', '.png', '.jpg', '.jpeg', '.webp', '.woff2', '.woff']);

export async function startControlRoom(options: RoomOptions): Promise<RunningRoom> {
  const { brief, checks, agents: agentsMod, roles, narrative } = await vendored();
  const host = options.host ?? '127.0.0.1';
  const token = randomUUID();
  const checksPath = join(options.stateDir, 'founder-checks.json');

  // The worker section of the runner config, raw: the roles spawn the same binary the
  // workers use (bin ?? claudeBin ?? 'claude'), resolved inside roles.mjs so every caller
  // gets the same chain. Read outside the zod schema on purpose — the schema strips keys
  // it does not know, and `bin` is a deployment detail, not an orchestration one.
  const workerConfig = ((): Record<string, unknown> => {
    try {
      const raw = JSON.parse(readFileSync(options.configPath, 'utf8')) as Record<string, unknown>;
      return (raw['worker'] as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  })();

  // live feed: tail the runner's session logs, broadcast to every open EventSource
  const sseClients = new Set<ServerResponse>();
  const broadcast = (event: string, data: unknown) => {
    const frame = `event: ${event}
data: ${JSON.stringify(data)}

`;
    for (const client of sseClients) {
      try {
        client.write(frame);
      } catch {
        sseClients.delete(client);
      }
    }
  };
  const live = createLivePump(join(options.repoCwd, '.spicyspec', 'runs'), agentsMod, broadcast);
  const pumpTimer = setInterval(() => {
    try {
      live.pump();
    } catch {
      /* the feed must never take the room down */
    }
  }, 1000);
  pumpTimer.unref?.();

  /**
   * "Where we are", derived from recorded facts only — the primary lane's registry, the
   * queue, and commits since the run began. The narrative module is the prototype's,
   * unchanged; only the inputs are gathered from the spicyspec store instead of flat files.
   */
  const buildWhere = async (): Promise<Record<string, unknown>> => {
    const prim = live.primary();
    const queue = await options.store.loadQueue();
    const queueEntries = queue.entries.map((e) => ({ ...e, status: STATUS_TO_ROOM[String(e.status)] ?? String(e.status) }));
    const runnersRaw = await options.store.listKv('runner:');
    const running = runnersRaw.some((r) => {
      try {
        const rec = JSON.parse(r.value) as { pid?: number; heartbeatAt?: string };
        return typeof rec.pid === 'number' && typeof rec.heartbeatAt === 'string' && Date.now() - Date.parse(rec.heartbeatAt) < 90_000;
      } catch {
        return false;
      }
    });
    const meta = prim?.meta ?? null;
    const startedAt = meta?.['startedAt'] ? String(meta['startedAt']) : null;
    let commitsThisTick: string[] = [];
    if (startedAt) {
      const spec = meta?.['spec'] ? String(meta['spec']) : null;
      const worktree = spec ? join(options.repoCwd, '.spicyspec', 'worktrees', spec) : null;
      const cwd = worktree && existsSync(worktree) ? worktree : options.repoCwd;
      const out = await git(cwd, ['log', `--since=${startedAt}`, '--format=%s']);
      commitsThisTick = out ? out.split('\n').filter(Boolean) : [];
    }
    const elapsedMin = startedAt ? (Date.now() - Date.parse(startedAt)) / 60000 : null;
    return narrative.describeWhereWeAre({
      agents: prim?.agents ?? [],
      narration: prim?.narration ?? [],
      tick: meta ? { number: meta['number'], spec: meta['spec'], stage: meta['stage'], account: meta['account'], startedAt, elapsedMin } : null,
      queue: queueEntries,
      commitsThisTick,
      running,
    });
  };

  /** Everything the chat sheet needs when a role is opened. Prototype rolePayload, verbatim. */
  const rolePayload = (id: string): Record<string, unknown> => {
    const def = roles.ROLE_DEFS[id];
    const session = roles.loadSession(options.stateDir, id);
    return {
      ...def,
      busy: roles.isBusy(id),
      session: { turns: session.turns ?? 0, costUsd: session.costUsd ?? 0, started: Boolean(session.sessionId), lastAt: session.lastAt ?? null },
      messages: roles.readMessages(options.stateDir, id, 100),
      tasks: roles.readTasks(options.stateDir, id),
      mandate: roles.readMandate(options.stateDir, id),
    };
  };

  const briefFor = async (kind: string, id: string) => {
    const built = brief.buildBrief(options.repoCwd, { kind, id, parkedKey: kind === 'parked' ? id : null });
    const itemKey = (kind === 'parked' ? '' : 'spec-') + id;
    const progress = checks.progressFor(checks.loadChecks(checksPath), itemKey, built);
    return { ...built, itemKey, progress, signedOffInGit: kind === 'spec' ? await isSignedOff(options.repoCwd, id) : false };
  };

  const owedIndex = async () => {
    const queue = await options.store.loadQueue();
    const roomEntries = queue.entries.map((e) => ({ ...e, status: STATUS_TO_ROOM[String(e.status)] ?? e.status }));
    const state = checks.loadChecks(checksPath);
    const items = brief.listOwed(options.repoCwd, roomEntries);
    return Promise.all(
      items.map(async (item) => {
        let progress = null;
        try {
          const built = brief.buildBrief(options.repoCwd, {
            kind: String(item['kind']),
            id: String(item['id']),
            parkedKey: item['kind'] === 'parked' ? String(item['id']) : null,
          });
          progress = checks.progressFor(state, String(item['key']), built);
        } catch {
          progress = null;
        }
        return {
          ...item,
          signedOff: item['kind'] === 'spec' ? await isSignedOff(options.repoCwd, String(item['id'])) : Boolean(progress?.signedOffAt),
          progress: progress && {
            done: progress.blockingDone,
            total: progress.blockingTotal,
            complete: progress.complete,
            startedAt: progress.startedAt,
            signedOffAt: progress.signedOffAt,
          },
        };
      }),
    );
  };

  /**
   * The deck's caches: rulings re-read only when a gate file's size or mtime moves, and the
   * owed count memoised with its own age. Both exist because the state frame is pushed every
   * four seconds and neither source is cheap — but neither is allowed to answer with a stale
   * number that does not say it is stale.
   */
  const deck = createDeckContext({
    store: options.store,
    repoCwd: options.repoCwd,
    configPath: options.configPath,
    owedIndex,
  });

  /** Commits in a window, for the digest's NUMBERS and the wire's TREE desk. */
  const commitsSince = async (sinceIso: string, untilIso: string | null) => {
    const args = ['log', `--since=${sinceIso}`, `--format=${COMMIT_FORMAT}`];
    if (untilIso) args.push(`--until=${untilIso}`);
    return parseCommitLog(await git(options.repoCwd, args));
  };

  const signOff = async (id: string) => {
    if (!/^\d{3}$/.test(id)) return { ok: false, message: 'sign-off needs a three-digit spec id' };
    const built = brief.buildBrief(options.repoCwd, { kind: 'spec', id, parkedKey: null });
    const progress = checks.progressFor(checks.loadChecks(checksPath), `spec-${id}`, built);
    if (!progress.complete) {
      const left = progress.blockingTotal - progress.blockingDone;
      return {
        ok: false,
        message: `${left} of ${progress.blockingTotal} checks still unticked — sign-off is refused until the journey is walked.`,
      };
    }
    if (await isSignedOff(options.repoCwd, id)) return { ok: false, message: `spec ${id} is already tagged signed-off/${id}` };
    try {
      execFileSync('git', ['tag', '-a', `signed-off/${id}`, '-m', `founder sign-off: ${progress.blockingDone} checks walked via the control room`], {
        cwd: options.repoCwd, encoding: 'utf8', windowsHide: true, timeout: 15_000,
      });
    } catch (err) {
      return { ok: false, message: 'git refused the tag: ' + String((err as Error).message).split('\n')[0] };
    }
    checks.markSignedOff(checksPath, `spec-${id}`);
    // ALSO record the review decision the parked workflow collects — one click, both systems.
    const { recordReviewDecision } = await import('./views.js');
    await recordReviewDecision(options.store, {
      specId: id, approved: true, note: `${progress.blockingDone} checks walked via the control room`, by: 'control-room', at: new Date().toISOString(),
    }).catch(() => undefined);
    return { ok: true, message: `spec ${id} is tagged signed-off/${id} and the review decision is recorded — the rotation collects it.` };
  };

  /* Two-level stop, prototype semantics (server.mjs:648-706), and every message below says
   * only what the engine does:
   *   STOP  — pause after the current run. Arms `runner:stop`, which the rotation reads at
   *           the next run boundary, and cancels the workflow through the halt CLI (Temporal
   *           cancellation is cooperative: the activity in flight finishes). Nothing
   *           interrupts the live session, so the button is labelled 'Pause after tick'.
   *   KILL  — now. Arms `runner:kill-now`, which the live run reads, cancels the workflow,
   *           and kills the runner's process tree; work not yet committed is lost.
   *   RESUME— disarms both flags. It does not restart anything; START does that.
   *   REPORT— the runner CLI writes the handoff and prints the path it wrote.
   * The armed flag is the durable half of STOP and KILL: it outlives this page and an
   * unreachable CLI, which is why an execFileSync failure there is reported as armed-with-a-
   * note rather than as a refusal. The previous version aliased kill to stop, so the scarier
   * confirm ran the gentler action. */
  const actions: Record<string, () => Promise<{ ok: boolean; message: string }> | { ok: boolean; message: string }> = {
    start: async () => {
      await options.store.release(STOP_KEY).catch(() => undefined);
      await options.store.release(KILL_KEY).catch(() => undefined);
      const child = spawn(process.execPath, [options.runnerBin, 'run', '--config', options.configPath], {
        cwd: options.repoCwd, detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.unref();
      // Dispatched, not started: the child is detached and its exit is never read here, so
      // claiming the rotation is running would be a promise this server cannot keep.
      return {
        ok: true,
        message:
          'stop flags cleared and the rotation dispatched detached — it outlives this page, and joins the rotation if one is already up. ' +
          'A worker must be hosted for it to move: spicyspec-runner start',
      };
    },
    stop: async () => {
      // Stamped with its author, always. The supervisor auto-clears flags it can attribute to
      // an agent and never touches the founder's — an unsigned flag is what let an agent's
      // stop sit armed through a night with nobody able to say who set it.
      await options.store.setKv(STOP_KEY, JSON.stringify({ armedAt: new Date().toISOString(), armedBy: FOUNDER }));
      try {
        const out = execFileSync(process.execPath, [options.runnerBin, 'halt', '--config', options.configPath], {
          cwd: options.repoCwd, encoding: 'utf8', windowsHide: true, timeout: 30_000,
        });
        const said = lastLine(out);
        return { ok: true, message: 'stop armed — the run in flight finishes and settles, then the rotation ends' + (said ? ' · ' + said : '') };
      } catch (err) {
        // The flag is the durable half: the rotation reads it at the one boundary where new
        // work is opened (runner queue-activities.ts), whether or not the CLI could be
        // reached from here. Armed with a note, not a refusal.
        return {
          ok: true,
          message:
            'stop armed — the run in flight finishes and settles, then the rotation ends at the next boundary (halt CLI unreachable: ' +
            String((err as Error).message).split('\n')[0] + ')',
        };
      }
    },
    kill: async () => {
      // Exactly what the engine does with the flag: the in-session watchdog interrupts the
      // live run (scored `aborted`, never a worker failure) and the rotation opens nothing
      // further while it is armed (runner control-flags.ts).
      const messages: string[] = ['kill-now armed — the live session is interrupted and the rotation opens nothing further'];
      await options.store.setKv(KILL_KEY, JSON.stringify({ armedAt: new Date().toISOString(), armedBy: FOUNDER }));
      try {
        execFileSync(process.execPath, [options.runnerBin, 'halt', '--config', options.configPath], {
          cwd: options.repoCwd, encoding: 'utf8', windowsHide: true, timeout: 30_000,
        });
        messages.push('rotation cancelled');
      } catch (err) {
        messages.push('halt: ' + String((err as Error).message).split('\n')[0]);
      }
      // Terminate the live runner tree, prototype-style. Liveness is a fresh heartbeat,
      // never the record's existence (B17).
      const rows = await options.store.listKv('runner:');
      const liveRec = rows
        .map((r) => {
          try {
            return JSON.parse(r.value) as { pid?: number; heartbeatAt?: string };
          } catch {
            return null;
          }
        })
        .find((r) => typeof r?.pid === 'number' && typeof r?.heartbeatAt === 'string' && Date.now() - Date.parse(r.heartbeatAt) < 90_000);
      if (liveRec?.pid) {
        try {
          if (process.platform === 'win32') {
            execFileSync('taskkill', ['/PID', String(liveRec.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          } else {
            process.kill(liveRec.pid, 'SIGKILL');
          }
          messages.push(`runner tree killed (pid ${liveRec.pid}) — in-flight session work may be lost`);
        } catch (err) {
          messages.push('kill: ' + String((err as Error).message).split('\n')[0]);
        }
      } else {
        // The flag stays armed, so this is not "nothing happened": the next run to read it
        // dies on arrival. Saying so is the difference between a disarm and a surprise.
        messages.push('no live runner to kill — the flag stays armed until Clear stop');
      }
      return { ok: true, message: messages.join(' · ') };
    },
    resume: async () => {
      await options.store.release(STOP_KEY).catch(() => undefined);
      await options.store.release(KILL_KEY).catch(() => undefined);
      return { ok: true, message: 'stop and kill-now disarmed — nothing is restarted by this; START dispatches the rotation' };
    },
    report: () => {
      try {
        const out = execFileSync(process.execPath, [options.runnerBin, 'handoff', '--config', options.configPath], {
          cwd: options.repoCwd, encoding: 'utf8', windowsHide: true, timeout: 60_000,
        });
        // The CLI prints the path it wrote; echoing our own guess is how a moved output file
        // becomes a message that points at nothing.
        return { ok: true, message: lastLine(out) || 'handoff written' };
      } catch (err) {
        return { ok: false, message: String((err as Error).message).split('\n')[0] };
      }
    },
  };

  const ALLOWED_HOSTS = (port: number) => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const port = (server.address() as { port: number }).port;
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);
      const send = (code: number, body: string | Buffer, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}) => {
        res.writeHead(code, {
          'Content-Type': type,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          ...extra,
        });
        res.end(body);
      };

      // B32 defences: host allowlist + cross-site rejection + token on mutations.
      if (!ALLOWED_HOSTS(port).has(String(req.headers.host))) return send(403, JSON.stringify({ error: 'host not allowed' }));
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return send(403, JSON.stringify({ error: 'cross-site rejected' }));

      const needsToken = req.method === 'POST';
      if (needsToken && req.headers['x-loop-token'] !== token) {
        // `code` is machine-readable on purpose: the installable console caches the SHELL,
        // so a page restored from the service worker can be carrying the PREVIOUS start's
        // token. A refusal that only says so in prose leaves the founder pressing a dead
        // button; this one lets the page recognise the case and reload itself.
        return send(403, JSON.stringify({ ok: false, code: 'stale-token', message: 'missing or stale control token — reload the page' }));
      }

      const readBody = () =>
        new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
          const parts: Buffer[] = [];
          let size = 0;
          req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > 64 * 1024) { rejectPromise(new Error('body too large')); req.destroy(); }
            else parts.push(c);
          });
          req.on('end', () => {
            try { resolvePromise(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); }
            catch { rejectPromise(new Error('body is not JSON')); }
          });
          req.on('error', rejectPromise);
        });

      try {
        if (url.pathname === '/api/state') return send(200, JSON.stringify(await buildRoomState(options, brief, live.lanes(), deck)));
        if (url.pathname === '/api/owed') return send(200, JSON.stringify({ owed: await owedIndex() }));

        /* ------------------------------------------------------------- the deck ---- */

        /**
         * The ledger, whole. The state frame carries the aggregates and a numeric series;
         * this serves the ROWS — for the wire's LEDGER desk, and for the journal to seed
         * itself with reconstructed entries the first time it opens on a cold database.
         * `revision` is echoed so the page refetches on a change rather than on a timer.
         */
        if (url.pathname === '/api/ledger') {
          const runs = (await options.store.listRuns()) as Array<Record<string, unknown>>;
          const limit = Number(url.searchParams.get('limit') ?? 400);
          const digest = ledgerDigest(runs, Date.now());
          return send(200, JSON.stringify({ revision: digest.revision, digest, rows: ledgerRows(runs, Number.isFinite(limit) ? limit : 400) }));
        }

        /**
         * Board rulings with their notes INTACT — the state frame previews them at 220 chars
         * because it is pushed every four seconds, and a 900-character ruling is the entire
         * point of the pull-quote.
         */
        if (url.pathname === '/api/gates') {
          const limit = Number(url.searchParams.get('limit') ?? 200);
          return send(200, JSON.stringify(deck.gatesFull(Number.isFinite(limit) ? limit : 200)));
        }

        /**
         * WHILE YOU SLEPT. Everything recorded inside a window, in the order the founder
         * reads it, and — the field that keeps the rest true — the rows that carry no start
         * stamp and therefore belong to no window at all.
         */
        if (url.pathname === '/api/digest') {
          const now = Date.now();
          const untilMs = Date.parse(url.searchParams.get('until') ?? '') || now;
          const sinceParam = Date.parse(url.searchParams.get('since') ?? '');
          const sinceMs = Number.isFinite(sinceParam) ? sinceParam : untilMs - DIGEST_DEFAULT_MS;
          const [runs, pool, queue, report] = await Promise.all([
            options.store.listRuns() as Promise<Array<Record<string, unknown>>>,
            options.store.loadPoolState(),
            options.store.loadQueue(),
            readSupervisorReport(options.store, now),
          ]);
          const entries = queue.entries.map((e) => ({ ...e, status: STATUS_TO_ROOM[String(e.status)] ?? String(e.status) })) as Array<Record<string, unknown>>;
          const owed = await deck.owed().catch(() => null);
          return send(
            200,
            JSON.stringify(
              composeDigest({
                sinceMs,
                untilMs,
                runs,
                gates: deck.gatesFull(GATES_MAX).rows,
                healthEvents: report.events,
                accountEvents: accountEventRows(runs, pool, now),
                entries,
                parked: parkedList(options, brief),
                commits: await commitsSince(new Date(sinceMs).toISOString(), new Date(untilMs).toISOString()),
                owed: owed?.count ?? null,
              }),
            ),
          );
        }

        /** The palette's corpus. Empty query returns nothing — never the whole log. */
        if (url.pathname === '/api/search') {
          const now = Date.now();
          const [runs, pool, queue, report] = await Promise.all([
            options.store.listRuns() as Promise<Array<Record<string, unknown>>>,
            options.store.loadPoolState(),
            options.store.loadQueue(),
            readSupervisorReport(options.store, now),
          ]);
          const entries = queue.entries.map((e) => ({ ...e, status: STATUS_TO_ROOM[String(e.status)] ?? String(e.status) })) as Array<Record<string, unknown>>;
          const docs = buildCorpus({
            entries,
            runs,
            gates: deck.gatesFull(GATES_MAX).rows,
            parked: parkedList(options, brief),
            healthEvents: report.events,
            accountEvents: accountEventRows(runs, pool, now),
          });
          const limit = Number(url.searchParams.get('limit') ?? SEARCH_LIMIT);
          const q = url.searchParams.get('q') ?? '';
          return send(200, JSON.stringify({ q, corpus: docs.length, hits: searchCorpus(docs, q, Number.isFinite(limit) ? limit : SEARCH_LIMIT) }));
        }
        if (url.pathname === '/api/brief') {
          return send(200, JSON.stringify(await briefFor(url.searchParams.get('kind') === 'parked' ? 'parked' : 'spec', url.searchParams.get('id') ?? '')));
        }
        if (url.pathname === '/api/check' && req.method === 'POST') {
          const b = await readBody();
          return send(200, JSON.stringify({ ok: true, state: checks.setCheck(checksPath, String(b['itemKey']), String(b['checkKey']), Boolean(b['value'])) }));
        }
        if (url.pathname === '/api/note' && req.method === 'POST') {
          const b = await readBody();
          return send(200, JSON.stringify({ ok: true, state: checks.setNote(checksPath, String(b['itemKey']), String(b['checkKey']), String(b['text'] ?? '')) }));
        }
        if (url.pathname === '/api/signoff' && req.method === 'POST') {
          const b = await readBody();
          return send(200, JSON.stringify(await signOff(String(b['id'] ?? ''))));
        }
        if (url.pathname.startsWith('/api/action/') && req.method === 'POST') {
          const name = url.pathname.split('/').pop() ?? '';
          const fn = Object.prototype.hasOwnProperty.call(actions, name) ? actions[name] : null;
          return send(fn ? 200 : 404, JSON.stringify(fn ? await fn() : { ok: false, message: 'no such action' }));
        }
        // Talking to a role changes state (it spends quota and writes a transcript), so the
        // POSTs ride the same token guard as every other mutation above.
        if (url.pathname === '/api/roles') {
          return send(200, JSON.stringify({ roles: roles.rolesSnapshot(options.stateDir) }));
        }
        if (url.pathname === '/api/role') {
          const id = url.searchParams.get('id') ?? '';
          if (!roles.ROLE_IDS.includes(id)) return send(404, JSON.stringify({ error: 'unknown role: ' + id }));
          return send(200, JSON.stringify(rolePayload(id)));
        }
        if (url.pathname.startsWith('/api/role/') && req.method === 'POST') {
          const action = url.pathname.split('/').pop() ?? '';
          const body = await readBody();
          const id = String(body['id'] ?? '');
          if (!roles.ROLE_IDS.includes(id)) return send(400, JSON.stringify({ ok: false, message: 'unknown role: ' + id }));

          if (action === 'say') {
            const text = String(body['text'] ?? '').trim();
            if (!text) return send(400, JSON.stringify({ ok: false, message: 'nothing to say' }));
            if (roles.isBusy(id)) {
              return send(409, JSON.stringify({
                ok: false,
                message: roles.ROLE_DEFS[id].name + ' is still answering. A session cannot be resumed twice at once, ' +
                  'so this message is refused rather than silently lost — send it again when the reply lands.',
              }));
            }
            // Answered immediately; the reply arrives over the SSE feed. A chat turn can take
            // minutes, and holding an HTTP request open that long is how a proxy or a sleeping
            // laptop turns a working answer into a failed one.
            send(202, JSON.stringify({ ok: true, message: 'sent — watch the panel', streaming: true }));
            broadcast('role', { kind: 'started', role: id, at: new Date().toISOString(), text });
            try {
              await roles.say({
                stateDir: options.stateDir, root: options.repoCwd, id, text, config: workerConfig,
                onEvent: (e) => broadcast('role', e),
              });
            } catch (err) {
              broadcast('role', { kind: 'failed', role: id, error: String((err as Error).message) });
            }
            return;
          }

          if (action === 'task') {
            const task = roles.addTask(options.stateDir, id, { text: body['text'], scheduledFor: body['scheduledFor'] ?? null });
            broadcast('role', { kind: 'task', role: id, task });
            return send(200, JSON.stringify({ ok: true, task }));
          }

          if (action === 'task-status') {
            const task = roles.updateTask(options.stateDir, id, String(body['taskId'] ?? ''), { status: String(body['status'] ?? 'done') });
            if (!task) return send(404, JSON.stringify({ ok: false, message: 'no such task' }));
            broadcast('role', { kind: 'task', role: id, task });
            return send(200, JSON.stringify({ ok: true, task }));
          }

          if (action === 'mandate') {
            try {
              roles.writeMandate(options.stateDir, id, body['text']); // throws for any role but special
            } catch (err) {
              return send(400, JSON.stringify({ ok: false, message: String((err as Error).message) }));
            }
            return send(200, JSON.stringify({ ok: true, mandate: roles.readMandate(options.stateDir, id) }));
          }

          return send(404, JSON.stringify({ ok: false, message: 'no such role action: ' + action }));
        }
        if (url.pathname === '/api/live') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          res.write('retry: 3000\n\n');
          const where = await buildWhere().catch(() => null);
          res.write(`event: hello\ndata: ${JSON.stringify({ ...(live.hello() as Record<string, unknown>), where })}\n\n`);
          sseClients.add(res);
          const beat = setInterval(() => {
            try {
              res.write(': keepalive\n\n');
            } catch {
              /* closed */
            }
          }, 15_000);
          req.on('close', () => {
            clearInterval(beat);
            sseClients.delete(res);
          });
          return;
        }
        if (url.pathname === '/api/agents') {
          // hello() carries where:null because the SSE frame fills it in; a plain fetch has no
          // later frame to wait for, so it gets the real narrative rather than a false null.
          const where = await buildWhere().catch(() => null);
          return send(200, JSON.stringify({ ...(live.hello() as Record<string, unknown>), where }));
        }
        if (url.pathname === '/api/agent') {
          const detail = live.detail(url.searchParams.get('id') ?? '');
          if (!detail) return send(404, JSON.stringify({ error: 'no such agent in the current tick' }));
          return send(200, JSON.stringify(detail));
        }
        if (url.pathname === '/api/where') return send(200, JSON.stringify(await buildWhere()));
        // Ship is not ported yet; a valid empty shape, never a crash.
        if (url.pathname === '/api/ship') return send(200, JSON.stringify({ readiness: { ready: false, reasons: ['ship is not ported yet'] }, request: null, specIds: [], plan: null }));

        // static assets
        const file = url.pathname === '/' ? 'app.html' : url.pathname.replace(/^\/+/, '');
        const path = join(ROOM, file);
        if (!path.startsWith(ROOM) || !existsSync(path)) return send(404, JSON.stringify({ error: 'not found' }));
        const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
        if (BINARY_EXT.has(ext)) return send(200, readFileSync(path), MIME[ext] ?? 'application/octet-stream');
        let body = readFileSync(path, 'utf8');
        if (file === 'app.html') body = body.replace('__LOOP_TOKEN__', token);
        // A service worker may only claim a scope at or below its own path unless the server
        // says otherwise, and the console's worker is served from the room root already —
        // the header is stated anyway so a move into a subfolder does not silently unregister
        // the offline shell.
        const extra: Record<string, string> = file.endsWith('sw.js') ? { 'Service-Worker-Allowed': '/' } : {};
        return send(200, body, MIME[ext] ?? 'application/octet-stream', extra);
      } catch (err) {
        return send(500, JSON.stringify({ error: String((err as Error).message) }));
      }
    })();
  });

  // The stream pushes state every 4s so Overview numbers move within seconds of reality —
  // the 15s fetch poll in the page is only a backstop for a stream that dies unnoticed.
  // Skipped with no clients: buildRoomState shells out to git for nobody otherwise.
  const stateTimer = setInterval(() => {
    if (!sseClients.size) return;
    void buildRoomState(options, brief, live.lanes(), deck)
      .then((state) => broadcast('state', state))
      .catch(() => undefined);
  }, STATE_PUSH_MS);
  stateTimer.unref?.();

  // The narrative is derived from git and the queue as well as the stream, so it refreshes
  // on its own slower cadence rather than on every appended line.
  const whereTimer = setInterval(() => {
    if (!sseClients.size) return;
    void buildWhere()
      .then((where) => broadcast('where', where))
      .catch(() => undefined);
  }, 5000);
  whereTimer.unref?.();

  return new Promise((resolvePromise) => {
    server.listen(options.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : (options.port ?? 0);
      resolvePromise({
        server,
        port,
        close: () =>
          new Promise<void>((r) => {
            clearInterval(pumpTimer);
            clearInterval(stateTimer);
            clearInterval(whereTimer);
            for (const c of sseClients) {
              try {
                c.end();
              } catch {
                /* closing */
              }
            }
            server.close(() => r());
          }),
      });
    });
  });
}
