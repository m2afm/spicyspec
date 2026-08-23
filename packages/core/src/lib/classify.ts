/**
 * Deterministic classification of a finished worker run.
 *
 * Runs BEFORE any second-vendor tracker/judge, on facts only. The judge receives this
 * verdict as input and may overrule it, but never has to re-derive it — and when the judge
 * is unavailable the orchestrator still runs on these classes alone.
 *
 * Ported from the Airvia prototype; every branch below exists because a defect proved it
 * necessary (defect ids reference the prototype's BUGS-ON-THE-GO.md register).
 */

export const EXIT = {
  CLEAN: 'clean',
  SPEC_COMPLETE: 'spec-complete',
  AWAITING_REVIEW: 'awaiting-review',
  RATE_LIMITED: 'rate-limited',
  STALLED: 'stalled',
  HUNG: 'hung',
  TIMED_OUT: 'timed-out',
  ERRORED: 'errored',
  NO_PROGRESS: 'no-progress',
  /** An operator kill. Never a worker failure, and must never mutate the queue. */
  ABORTED: 'aborted',
  /**
   * The worker produced text and ended its turn without calling a single tool — it never
   * attempted the work. Distinct from NO_PROGRESS (it tried and achieved nothing), and it
   * must never count as a stall, because consecutive stalls park the active spec.
   */
  NO_ATTEMPT: 'no-attempt',
  /**
   * The account was refused at the door — no subscription, revoked token, org policy.
   * Distinct from RATE_LIMITED (temporary, same account will serve later) and from
   * ERRORED (the worker itself failed). Infrastructure, not work: must never count
   * toward the stall limit that parks a spec.
   */
  ACCOUNT_REFUSED: 'account-refused',
} as const;

export type ExitClass = (typeof EXIT)[keyof typeof EXIT];

export interface ResultEnvelope {
  total_cost_usd?: number;
  num_turns?: number;
  session_id?: string | null;
  api_error_status?: number | string | null;
  is_error?: boolean | null;
  result?: string | null;
}

export interface RateLimitInfo {
  /** allowed | allowed_warning | rejected | blocked | exhausted | limited */
  status?: string | null;
  resetsAt?: number | null;
  utilization?: number | null;
  /** five_hour | seven_day — the pool keeps weekly quotas in reserve */
  rateLimitType?: string | null;
  overageStatus?: string | null;
  isUsingOverage?: boolean | null;
}

export type KillReason = 'stop-now' | 'hang' | 'stall' | 'timeout' | null;

export interface RunResult {
  killedFor: KillReason;
  resultEnvelope: ResultEnvelope | null;
  rateLimit?: RateLimitInfo | null;
  text?: string;
  toolCalls?: number;
}

export interface EvidenceSnapshot {
  git: { head: string; dirty: boolean };
  tasks: { exists: boolean; done: number; open: number };
  handoff: { mtimeMs: number };
}

/**
 * Was the account itself refused, rather than the work failing?
 *
 * Found in the prototype by removing a subscription mid-run: the call returns 403 in ~2.5s
 * with a "disabled … access" message and NO rate-limit event. Unhandled, that classified as
 * `errored`, the account stayed "warm" in the pool, kept being picked, and two consecutive
 * dead ticks would have parked a perfectly healthy spec (defect B29).
 */
const REFUSAL_STATUSES = new Set([401, 403]);
const REFUSAL_TEXT =
  /subscription access|no active subscription|not entitled|invalid api key|authentication_error|unauthorized|disabled .*access|usage limit for this billing cycle/i;

export function isAccountRefused(envelope: ResultEnvelope | null, text = ''): boolean {
  if (!envelope) return false;
  if (REFUSAL_STATUSES.has(Number(envelope.api_error_status))) return true;
  return Boolean(envelope.is_error) && REFUSAL_TEXT.test(`${envelope.result ?? ''}\n${text}`);
}

/**
 * Only these states mean the account actually refused work.
 *
 * `allowed_warning` does NOT: it is reported from ~90% utilization onward while the account
 * keeps serving. Treating it as a limit cost the prototype a real tick — an account at 0.95
 * utilization was marked cold for 62 minutes, its work discarded, and the switch was then
 * celebrated as proof that failover worked (defect B10).
 */
const BLOCKED_STATES = new Set(['rejected', 'blocked', 'exhausted', 'limited']);

export function isBlocked(rateLimit: RateLimitInfo | null | undefined): boolean {
  if (!rateLimit?.status) return false;
  return BLOCKED_STATES.has(String(rateLimit.status).toLowerCase());
}

const REVIEW_MARKERS = [
  /AWAITING[ _-]?(?:FOUNDER|REVIEW)/i,
  /(?:founder|human) (?:journey|review) (?:is )?(?:owed|required|pending)/i,
  /cannot be performed by a script/i,
];

function movedForward(before: EvidenceSnapshot, after: EvidenceSnapshot): boolean {
  return (
    before.git.head !== after.git.head ||
    after.tasks.done > before.tasks.done ||
    after.handoff.mtimeMs > before.handoff.mtimeMs
  );
}

export interface Classification {
  exit: ExitClass;
  progressed: boolean;
  commits: boolean;
  tasksClosed: number;
  tasksOpen: number;
  dirty: boolean;
  costUsd: number;
  turns: number;
  sessionId: string | null;
  apiError: number | string | null;
  isError: boolean | null;
  overageStatus: string | null;
  usedOverage: boolean | null;
  rateStatus: string | null;
  rateResetsAt: number | null;
  utilization: number | null;
  rateLimitType: string | null;
  /**
   * A watchdog kill arrives with no result envelope, so cost and turns are UNKNOWN — not
   * zero. Recording zero made the prototype's report understate its most expensive
   * failures by exactly their cost (defect B19).
   */
  costKnown: boolean;
  refusal?: string;
  resetsAt?: number | null;
}

export function classify(run: RunResult, before: EvidenceSnapshot, after: EvidenceSnapshot): Classification {
  const progressed = movedForward(before, after);
  const envelope = run.resultEnvelope ?? null;
  const text = [run.text ?? '', envelope?.result ?? ''].join('\n');

  const base: Omit<Classification, 'exit'> = {
    progressed,
    commits: after.git.head !== before.git.head,
    tasksClosed: Math.max(0, after.tasks.done - before.tasks.done),
    tasksOpen: after.tasks.open,
    dirty: after.git.dirty,
    costUsd: envelope?.total_cost_usd ?? 0,
    turns: envelope?.num_turns ?? 0,
    sessionId: envelope?.session_id ?? null,
    apiError: envelope?.api_error_status ?? null,
    isError: envelope?.is_error ?? null,
    overageStatus: run.rateLimit?.overageStatus ?? null,
    usedOverage: run.rateLimit?.isUsingOverage ?? null,
    rateStatus: run.rateLimit?.status ?? null,
    rateResetsAt: run.rateLimit?.resetsAt ?? null,
    utilization: run.rateLimit?.utilization ?? null,
    rateLimitType: run.rateLimit?.rateLimitType ?? null,
    costKnown: Boolean(envelope),
  };

  // An operator kill is not a worker outcome and must never be scored as one (defect B15).
  if (run.killedFor === 'stop-now') return { ...base, exit: EXIT.ABORTED };

  // Checked before RATE_LIMITED and before the error envelope: a refusal carries no
  // rate-limit event, so it would otherwise fall through to a plain `errored`.
  if (isAccountRefused(envelope, text)) {
    return { ...base, exit: EXIT.ACCOUNT_REFUSED, refusal: String(envelope?.result ?? '').slice(0, 200) };
  }
  if (isBlocked(run.rateLimit)) {
    return { ...base, exit: EXIT.RATE_LIMITED, resetsAt: run.rateLimit?.resetsAt ?? null };
  }
  if (run.killedFor === 'hang') return { ...base, exit: EXIT.HUNG };
  if (run.killedFor === 'stall') return { ...base, exit: EXIT.STALLED };
  if (run.killedFor === 'timeout') return { ...base, exit: EXIT.TIMED_OUT };
  if (envelope?.is_error) return { ...base, exit: EXIT.ERRORED };

  // Zero tool calls with a clean end-of-turn is not a failed attempt, it is NO attempt: the
  // worker answered a prompt instead of doing a job (prototype tick 27 replied to a chat
  // hook, ended its turn, and cost $0.40 for nothing). Retryable, and never a stall.
  if (run.toolCalls === 0 && envelope && !envelope.is_error) {
    return { ...base, exit: EXIT.NO_ATTEMPT };
  }

  if (REVIEW_MARKERS.some((re) => re.test(text))) {
    return { ...base, exit: EXIT.AWAITING_REVIEW };
  }
  if (after.tasks.exists && after.tasks.open === 0 && !after.git.dirty) {
    return { ...base, exit: EXIT.SPEC_COMPLETE };
  }
  if (!progressed) return { ...base, exit: EXIT.NO_PROGRESS };
  return { ...base, exit: EXIT.CLEAN };
}

export interface CommitRef {
  sha: string;
  subject: string;
}

/**
 * Loop-of-doom detector: consecutive fix-shaped commits with no forward work.
 * The prototype's forensics measured batched fixes injecting ~1 live defect per 6–9 fixes;
 * a run of nothing-but-fix commits is what that failure looks like from outside.
 */
export function detectLoopOfDoom(
  recentCommits: readonly CommitRef[],
  windowSize: number,
): { pattern: 'consecutive-fix-commits'; commits: string[] } | null {
  const window = recentCommits.slice(0, windowSize);
  if (window.length < windowSize) return null;
  if (!window.every((c) => /^(fix|test)\(/i.test(c.subject))) return null;
  return { pattern: 'consecutive-fix-commits', commits: window.map((c) => c.sha) };
}
