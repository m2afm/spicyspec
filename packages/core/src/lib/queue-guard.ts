/**
 * The run queue's invariants, and the attribution rule that protects them.
 *
 * Ported from the Airvia loop prototype (`.specify/loop/lib/queue-guard.mjs`), where ten of
 * forty-seven recorded defects were the same shape: an entry sitting in a state its evidence
 * did not support, or an outcome applied to the wrong entry. Each was first fixed with a
 * scattered `if`; the next one arrived elsewhere. What needed protecting was the STATE, so
 * the rules are declared once, here, and checked on every orchestrator iteration.
 *
 * Severity discipline (RFC-001 §7.2 — nothing above `warn` may depend on parsing prose):
 *
 *   'repair'  the correct state is unambiguous from evidence, so fix it and log it.
 *   'halt'    the state is one the loop cannot reason about at all. Stop; never guess.
 *   'warn'    something looks wrong but the evidence is weaker than the action would be.
 */

export const STATUSES = ['pending', 'active', 'awaiting-review', 'parked', 'done'] as const;
export type EntryStatus = (typeof STATUSES)[number];
const STATUS_SET = new Set<string>(STATUSES);

export interface QueueEntry {
  id: string;
  status: EntryStatus | string;
  stage?: string | null;
  closedAt?: string | null;
  repairedAt?: string;
}

export interface Queue {
  entries: QueueEntry[];
}

/** Injected predicates, so every rule is testable without a repo. */
export interface QueueEvidence {
  /** does a spec directory exist for this id */
  specDirExists(id: string): boolean;
  /** how many commits name this spec */
  commitsFor(id: string): number;
  /** a sign-off tag or leading commit marker exists */
  signedOff(id: string): boolean;
  /** is the human-review backlog full (a legitimate reason to idle) */
  reviewCapBlocks(): boolean;
}

export type Severity = 'repair' | 'halt' | 'warn';

export interface Violation {
  code: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | 'Q6' | 'Q7' | 'Q8';
  severity: Severity;
  id: string | null;
  message: string;
  repairTo?: EntryStatus | null;
  setStage?: string;
}

export interface QueueCheck {
  violations: Violation[];
  halting: Violation[];
}

export interface CheckOptions {
  /**
   * How many entries may be active at once. 1 is the single-writer default; parallel mode
   * (worktree-isolated sessions, one per account) raises it. Q3 fires past the cap — the
   * cap IS the invariant now, not "exactly one".
   */
  maxActive?: number;
}

export function checkQueue(
  queue: Queue | null | undefined,
  evidence: QueueEvidence,
  options: CheckOptions = {},
): QueueCheck {
  const maxActive = Math.max(1, options.maxActive ?? 1);
  const violations: Violation[] = [];
  const entries = queue?.entries ?? [];
  const add = (v: Violation) => violations.push(v);

  // Q1 — a status nobody wrote a rule for. Everything below reasons about status, so an
  // unknown one makes every other conclusion unsound. Halt rather than treat it as pending.
  for (const e of entries) {
    if (!STATUS_SET.has(e.status)) {
      add({
        code: 'Q1',
        severity: 'halt',
        id: e.id,
        message: `unknown status "${e.status}" — the loop has no rule for it`,
      });
    }
  }

  // Q2 — duplicate ids. Two entries claiming one id means every lookup is a coin toss.
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) add({ code: 'Q2', severity: 'halt', id: e.id, message: 'duplicate catalog id' });
    seen.add(e.id);
  }

  // Q3 — more active entries than the writer capacity. Outcomes are settled per spec id
  // (not per "the active entry"), so N active is sound exactly when N isolated writers
  // exist; past the cap the loop halts rather than guesses.
  const active = entries.filter((e) => e.status === 'active');
  if (active.length > maxActive) {
    add({
      code: 'Q3',
      severity: 'halt',
      id: active.map((e) => e.id).join(','),
      message: `${active.length} entries are active at once (cap ${maxActive})`,
    });
  }

  for (const e of entries) {
    if (e.status !== 'awaiting-review') continue;

    // Q4 — awaiting a human review of a spec that was never written (prototype defect B45).
    // The correct state is unambiguous: nothing was built, so it is pending.
    if (!evidence.specDirExists(e.id)) {
      add({
        code: 'Q4',
        severity: 'repair',
        id: e.id,
        repairTo: 'pending',
        message: 'awaiting-review with no spec directory — nothing was built, so there is nothing to review',
      });
      continue;
    }

    // Q5 — a spec directory exists but no commit ever named this spec. A directory can be
    // created by a run that then did nothing; a commit is the cheapest proof of real work.
    if (evidence.commitsFor(e.id) === 0) {
      add({
        code: 'Q5',
        severity: 'repair',
        id: e.id,
        repairTo: 'pending',
        message: 'awaiting-review with a spec directory but zero commits naming it — no work to review',
      });
    }
  }

  // Q6 — done without sign-off evidence. WARN, not repair: demoting a `done` entry is
  // destructive, and legitimate task-scoped markers exist.
  for (const e of entries) {
    if (e.status === 'done' && !evidence.signedOff(e.id)) {
      add({ code: 'Q6', severity: 'warn', id: e.id, message: 'marked done with no signed-off tag or commit marker' });
    }
  }

  // Q7 — an active entry with no stage. Cheap to repair and the work packet reads it.
  for (const e of entries) {
    if (e.status === 'active' && !e.stage) {
      add({ code: 'Q7', severity: 'repair', id: e.id, repairTo: null, setStage: 'shape', message: 'active with no stage' });
    }
  }

  // Q8 — idle while work is available. Not a fault on its own (the review cap legitimately
  // idles the loop), so it is only reported when the cap is NOT the reason.
  if (active.length === 0 && entries.some((e) => e.status === 'pending') && !evidence.reviewCapBlocks()) {
    add({ code: 'Q8', severity: 'warn', id: null, message: 'nothing active, pending work available, and the review cap is not blocking' });
  }

  return { violations, halting: violations.filter((v) => v.severity === 'halt') };
}

export interface AppliedRepair extends Violation {
  from: string;
  to: string;
}

/**
 * Apply every unambiguous repair. Returns what changed so the caller can log each one
 * individually — a repair nobody can see in the log is a state change nobody can audit.
 */
export function applyRepairs(
  queue: Queue,
  violations: Violation[],
  at: string = new Date().toISOString(),
): { changed: boolean; applied: AppliedRepair[] } {
  const applied: AppliedRepair[] = [];
  for (const v of violations) {
    if (v.severity !== 'repair') continue;
    const entry = (queue.entries ?? []).find((e) => e.id === v.id);
    if (!entry) continue;
    const before = entry.status;
    if (v.repairTo) {
      entry.status = v.repairTo;
      entry.closedAt = v.repairTo === 'pending' ? null : entry.closedAt;
    }
    if (v.setStage && !entry.stage) entry.stage = v.setStage;
    entry.repairedAt = at;
    applied.push({ ...v, from: String(before), to: String(entry.status) });
  }
  return { changed: applied.length > 0, applied };
}

/* ==================================================================== attribution ==== */

/** Spec ids a set of commit subjects claims, from the `type(NNN):` convention. */
export function specIdsIn(subjects: readonly string[] | null | undefined): string[] {
  const ids = new Set<string>();
  for (const s of subjects ?? []) {
    for (const m of String(s).matchAll(/\((\d{3})\)/g)) ids.add(m[1]);
  }
  return [...ids];
}

export type AttributionVerdict = 'silent' | 'no-active' | 'unattributed' | 'match' | 'mismatch';

export interface Attribution {
  ids: string[];
  verdict: AttributionVerdict;
  matchesActive: boolean | null;
}

/**
 * Did this run actually work on the spec the loop thinks it did?
 *
 * The guard for the prototype's tick-34 incident: a run dispatched for one spec spent 102
 * minutes committing fourteen times against another, and the orchestrator applied the
 * outcome to the wrong entry — locking a spec out of the rotation in a state no later run
 * would revisit. Measured across that run: 1 mismatch in 37 ticks. Rare, and it cost a spec.
 *
 * `silent` is deliberately NOT a mismatch. Plenty of legitimate runs commit nothing — a
 * research pass, a gate that returned REVISE with the fixes still to come — and treating
 * those as suspect would fire the guard constantly and teach everyone to ignore it.
 */
export function attribution(subjects: readonly string[] | null | undefined, activeId: string | null): Attribution {
  const ids = specIdsIn(subjects);
  if (!subjects?.length) return { ids, verdict: 'silent', matchesActive: null };
  if (!activeId) return { ids, verdict: 'no-active', matchesActive: null };
  if (ids.length === 0) return { ids, verdict: 'unattributed', matchesActive: null };
  if (ids.includes(activeId)) return { ids, verdict: 'match', matchesActive: true };
  return { ids, verdict: 'mismatch', matchesActive: false };
}

/**
 * May this run's outcome change the active entry's status?
 *
 * Only a clear mismatch withholds the advance — the run demonstrably worked on a different
 * spec, so its conclusion says nothing about this one. Everything else advances as before,
 * because a guard that blocks the normal path is worse than the bug it prevents.
 */
export function mayAdvance(attr: Attribution): { ok: boolean; reason: string | null } {
  if (attr.verdict === 'mismatch') {
    return {
      ok: false,
      reason:
        `this run committed only against ${attr.ids.join(', ')}, not the active spec — ` +
        'its outcome says nothing about the active entry, so the entry is left as it was',
    };
  }
  return { ok: true, reason: null };
}
