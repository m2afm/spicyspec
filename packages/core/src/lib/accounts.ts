/**
 * The provider-account pool — pure logic.
 *
 * A run executes as exactly one account. When the stream reports a rate limit, that account
 * goes cold until its reset and the next run picks whichever account is warm — so a
 * five-hour window costs a switch instead of a five-hour nap. When every account is cold
 * the orchestrator sleeps to the earliest reset, which is the only honest thing to do and
 * is also the number capacity planning needs.
 *
 * Credentials never live in pool state. Config carries the SHAPE of an account (id + which
 * mechanism it uses); secrets are merged in by the runner from its local secret store.
 *
 * This module is pure: every mutation returns the changed account list and takes `nowMs`
 * explicitly. Persistence (the prototype's ACCOUNTS.json) lives behind the repository
 * layer — the prototype learned that cooldowns MUST survive an orchestrator restart, or a
 * restart burns a run re-discovering a limit it already knew about.
 */

export interface AccountConfig {
  id: string;
  label?: string;
  enabled?: boolean;
  env?: Record<string, string>;
  configDir?: string | null;
}

export interface AccountState {
  coldUntilMs?: number;
  uses?: number;
  refusedReason?: string | null;
  refusedAt?: string | null;
  /**
   * five_hour | seven_day. Read back, not just written: a limit window is observed at most
   * once every few hours, and the orchestrator restarts far more often than that — a field
   * that only round-tripped one way would forget which account is the reserve on every
   * restart, which is the same as not having the rule at all (prototype defect C4).
   */
  limitType?: string | null;
  limitTypeSeenAt?: string | null;
}

export interface PoolAccount {
  id: string;
  label: string;
  configDir: string | null;
  env: Record<string, string>;
  coldUntilMs: number;
  uses: number;
  refusedReason: string | null;
  refusedAt: string | null;
  limitType: string | null;
  limitTypeSeenAt: string | null;
}

export interface Pool {
  accounts: PoolAccount[];
}

export const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

/** Build a pool from config + secrets + persisted state (all injected, no I/O here). */
export function buildPool(
  configured: readonly AccountConfig[],
  secrets: Record<string, { env?: Record<string, string> }> = {},
  state: Record<string, AccountState> = {},
): Pool {
  const accounts = (configured ?? [])
    .filter((a) => a.enabled !== false)
    .map((a): PoolAccount => ({
      id: a.id,
      label: a.label ?? a.id,
      configDir: a.configDir ?? null,
      env: { ...(a.env ?? {}), ...(secrets[a.id]?.env ?? {}) },
      coldUntilMs: state[a.id]?.coldUntilMs ?? 0,
      uses: state[a.id]?.uses ?? 0,
      refusedReason: state[a.id]?.refusedReason ?? null,
      refusedAt: state[a.id]?.refusedAt ?? null,
      limitType: state[a.id]?.limitType ?? null,
      limitTypeSeenAt: state[a.id]?.limitTypeSeenAt ?? null,
    }));
  return { accounts };
}

/** The persistable slice of pool state, keyed by account id. */
export function poolState(pool: Pool): Record<string, Required<AccountState>> {
  return Object.fromEntries(
    pool.accounts.map((a) => [
      a.id,
      {
        coldUntilMs: a.coldUntilMs,
        uses: a.uses,
        refusedReason: a.refusedReason,
        refusedAt: a.refusedAt,
        limitType: a.limitType,
        limitTypeSeenAt: a.limitTypeSeenAt,
      },
    ]),
  );
}

/**
 * Which account should run next?
 *
 * Usable means not cold. Among those, an account whose observed limit window is WEEKLY is
 * held back as the reserve, and the rest are ordered by fewest uses so load spreads instead
 * of hammering one entry until it limits.
 *
 * The reserve rule is the point (prototype C4): a `seven_day` quota takes a week to come
 * back; weighted equally with five-hour accounts it gets spent on ordinary work and the
 * pool loses its last fallback for days. It runs only when nothing shorter is warm — which
 * is exactly when it is worth spending.
 *
 * An account whose window has never been observed is treated as short. Guessing "weekly"
 * for anything unknown would sideline the whole pool on first run.
 */
const isReserve = (a: PoolAccount) => a.limitType === 'seven_day';

/**
 * Every warm account, in the order pickAccount would spend them: reserve-last, then fewest
 * uses. A lease loop that walks candidates MUST walk this order — the runner once sorted by
 * uses alone, so a warm seven_day reserve with zero uses out-ranked every five-hour account
 * and the weekly quota was burned on ordinary runs (the C4 reserve rule, bypassed at pick
 * time because only pickAccount carried it).
 */
export function pickOrder(pool: Pool, nowMs: number): PoolAccount[] {
  return pool.accounts
    .filter((a) => a.coldUntilMs <= nowMs)
    .sort((a, b) => {
      const reserve = Number(isReserve(a)) - Number(isReserve(b));
      return reserve !== 0 ? reserve : a.uses - b.uses;
    });
}

export function pickAccount(pool: Pool, nowMs: number): PoolAccount | null {
  return pickOrder(pool, nowMs)[0] ?? null;
}

/**
 * Record the limit window an account actually reported. Only ever set from a real
 * rate-limit event; never inferred. Returns whether anything changed (the caller persists).
 */
export function markLimitType(pool: Pool, accountId: string, limitType: string | null | undefined, at: string): boolean {
  if (!limitType) return false;
  const account = pool.accounts.find((a) => a.id === accountId);
  if (!account || account.limitType === limitType) return false;
  account.limitType = limitType;
  account.limitTypeSeenAt = at;
  return true;
}

/** Earliest moment any account becomes usable again, or null if the pool is empty. */
export function earliestWarmMs(pool: Pool): number | null {
  if (!pool.accounts.length) return null;
  return Math.min(...pool.accounts.map((a) => a.coldUntilMs));
}

/**
 * Mark an account cold. `resetsAtSeconds` comes straight from the provider's rate-limit
 * event; when missing, fall back to a fixed cooldown rather than guessing a window length.
 */
export function markCold(pool: Pool, accountId: string, resetsAtSeconds: number | null | undefined, nowMs: number, bufferMs = 60_000): boolean {
  const account = pool.accounts.find((a) => a.id === accountId);
  if (!account) return false;
  account.coldUntilMs = resetsAtSeconds ? resetsAtSeconds * 1000 + bufferMs : nowMs + DEFAULT_COOLDOWN_MS;
  return true;
}

/**
 * Sideline an account refused at the door — no subscription, revoked token, org policy.
 * Deliberately a LONG cooldown rather than a permanent kill, because entitlement comes
 * back: the prototype watched a subscription removed for a test return twenty minutes
 * later, and a permanent disable would have kept a healthy account out of the pool until
 * someone noticed. Costs one short run per window, and self-heals.
 */
export function markRefused(pool: Pool, accountId: string, reason: string | null | undefined, nowMs: number, at: string, hours = 6): boolean {
  const account = pool.accounts.find((a) => a.id === accountId);
  if (!account) return false;
  account.coldUntilMs = nowMs + hours * 3600_000;
  account.refusedReason = String(reason ?? '').slice(0, 200);
  account.refusedAt = at;
  return true;
}

export function recordUse(pool: Pool, accountId: string): boolean {
  const account = pool.accounts.find((a) => a.id === accountId);
  if (!account) return false;
  account.uses += 1;
  return true;
}

export function describePool(pool: Pool, nowMs: number): string {
  return pool.accounts
    .map((a) => {
      const cold = a.coldUntilMs > nowMs;
      const mins = cold ? Math.ceil((a.coldUntilMs - nowMs) / 60000) : 0;
      const why = cold && a.refusedReason ? ' REFUSED' : '';
      return `${a.id}${cold ? ` COLD ${mins}m${why}` : ' warm'} (${a.uses} uses)`;
    })
    .join(' · ');
}
