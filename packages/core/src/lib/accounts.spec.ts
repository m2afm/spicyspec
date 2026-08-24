/**
 * Regression suite for the account pool. Defect ids reference the prototype register.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPool,
  describePool,
  DEFAULT_COOLDOWN_MS,
  earliestWarmMs,
  markCold,
  markLimitType,
  markRefused,
  pickAccount,
  pickOrder,
  poolState,
  recordUse,
} from './accounts.js';

const NOW = 1_000_000_000_000;
const AT = '2026-08-24T00:00:00Z';

const threeAccounts = () =>
  buildPool([
    { id: 'primary' },
    { id: 'secondary' },
    { id: 'tertiary' },
  ]);

describe('buildPool', () => {
  it('merges config, secrets, and persisted state', () => {
    const pool = buildPool(
      [{ id: 'a', env: { X: '1' } }, { id: 'b', enabled: false }],
      { a: { env: { TOKEN: 's3cret' } } },
      { a: { coldUntilMs: 5, uses: 3, limitType: 'seven_day' } },
    );
    expect(pool.accounts).toHaveLength(1); // disabled excluded
    expect(pool.accounts[0].env).toEqual({ X: '1', TOKEN: 's3cret' });
    expect(pool.accounts[0].coldUntilMs).toBe(5);
    expect(pool.accounts[0].uses).toBe(3);
    expect(pool.accounts[0].limitType).toBe('seven_day');
  });

  it('poolState round-trips through buildPool (C4: state must survive restarts)', () => {
    const pool = threeAccounts();
    markCold(pool, 'primary', NOW / 1000 + 3600, NOW);
    markLimitType(pool, 'secondary', 'seven_day', AT);
    recordUse(pool, 'tertiary');
    const revived = buildPool(
      [{ id: 'primary' }, { id: 'secondary' }, { id: 'tertiary' }],
      {},
      poolState(pool),
    );
    expect(revived.accounts.find((a) => a.id === 'primary')!.coldUntilMs).toBeGreaterThan(NOW);
    expect(revived.accounts.find((a) => a.id === 'secondary')!.limitType).toBe('seven_day');
    expect(revived.accounts.find((a) => a.id === 'tertiary')!.uses).toBe(1);
  });
});

describe('pickAccount', () => {
  it('picks the warm account with fewest uses', () => {
    const pool = threeAccounts();
    recordUse(pool, 'primary');
    recordUse(pool, 'primary');
    recordUse(pool, 'secondary');
    expect(pickAccount(pool, NOW)!.id).toBe('tertiary');
  });

  it('skips cold accounts', () => {
    const pool = threeAccounts();
    markCold(pool, 'primary', null, NOW);
    markCold(pool, 'secondary', null, NOW);
    expect(pickAccount(pool, NOW)!.id).toBe('tertiary');
  });

  it('returns null when every account is cold', () => {
    const pool = threeAccounts();
    for (const id of ['primary', 'secondary', 'tertiary']) markCold(pool, id, null, NOW);
    expect(pickAccount(pool, NOW)).toBeNull();
  });

  it('C4: a seven_day account is the reserve — runs only when nothing shorter is warm', () => {
    const pool = threeAccounts();
    markLimitType(pool, 'secondary', 'seven_day', AT);
    // secondary has fewest uses but is the weekly reserve
    recordUse(pool, 'primary');
    recordUse(pool, 'tertiary');
    expect(pickAccount(pool, NOW)!.id).not.toBe('secondary');
    // when the short-window accounts are cold, the reserve is exactly what to spend
    markCold(pool, 'primary', null, NOW);
    markCold(pool, 'tertiary', null, NOW);
    expect(pickAccount(pool, NOW)!.id).toBe('secondary');
  });

  it('an unobserved window is treated as short — never guessed weekly', () => {
    const pool = buildPool([{ id: 'only' }]);
    expect(pickAccount(pool, NOW)!.id).toBe('only');
  });
});

describe('pickOrder — the order a lease loop must walk', () => {
  it('C4 at pick time: every reserve sorts AFTER every short-window account, even at zero uses', () => {
    // The runner's lease loop once sorted by uses alone — a warm seven_day reserve with
    // zero uses out-ranked a used five-hour account and the weekly quota was burned on
    // ordinary work. The order is the rule; the lease only serializes it.
    const pool = threeAccounts();
    markLimitType(pool, 'secondary', 'seven_day', AT);
    recordUse(pool, 'primary');
    recordUse(pool, 'primary');
    recordUse(pool, 'tertiary');
    expect(pickOrder(pool, NOW).map((a) => a.id)).toEqual(['tertiary', 'primary', 'secondary']);
  });

  it('excludes cold accounts entirely and agrees with pickAccount on the head', () => {
    const pool = threeAccounts();
    markCold(pool, 'primary', null, NOW);
    const order = pickOrder(pool, NOW);
    expect(order.map((a) => a.id)).toEqual(['secondary', 'tertiary']);
    expect(pickAccount(pool, NOW)!.id).toBe(order[0].id);
  });
});

describe('cooldowns', () => {
  it('markCold uses the reported reset plus buffer', () => {
    const pool = threeAccounts();
    markCold(pool, 'primary', 2_000_000, NOW, 60_000);
    expect(pool.accounts[0].coldUntilMs).toBe(2_000_000 * 1000 + 60_000);
  });

  it('markCold falls back to a fixed cooldown when no reset is reported', () => {
    const pool = threeAccounts();
    markCold(pool, 'primary', null, NOW);
    expect(pool.accounts[0].coldUntilMs).toBe(NOW + DEFAULT_COOLDOWN_MS);
  });

  it('B29-adjacent: a refusal is a LONG cooldown that self-heals, never a permanent kill', () => {
    const pool = threeAccounts();
    markRefused(pool, 'secondary', 'org disabled subscription access', NOW, AT);
    const acc = pool.accounts.find((a) => a.id === 'secondary')!;
    expect(acc.coldUntilMs).toBe(NOW + 6 * 3600_000);
    expect(acc.refusedReason).toContain('disabled');
    // still eligible again after the window
    expect(pickAccount(pool, NOW + 7 * 3600_000)!.id).toBeDefined();
  });

  it('earliestWarmMs reports the soonest reset; null on an empty pool', () => {
    const pool = threeAccounts();
    markCold(pool, 'primary', 3_000, NOW);
    markCold(pool, 'secondary', 2_000, NOW);
    markCold(pool, 'tertiary', 4_000, NOW);
    expect(earliestWarmMs(pool)).toBe(2_000 * 1000 + 60_000);
    expect(earliestWarmMs(buildPool([]))).toBeNull();
  });
});

describe('markLimitType', () => {
  it('records only real observations and reports change', () => {
    const pool = threeAccounts();
    expect(markLimitType(pool, 'primary', null, AT)).toBe(false);
    expect(markLimitType(pool, 'primary', 'five_hour', AT)).toBe(true);
    expect(markLimitType(pool, 'primary', 'five_hour', AT)).toBe(false); // unchanged
    expect(pool.accounts[0].limitTypeSeenAt).toBe(AT);
  });
});

describe('describePool', () => {
  it('renders warm/cold with minutes and refusal flag', () => {
    const pool = threeAccounts();
    markRefused(pool, 'secondary', 'nope', NOW, AT);
    const s = describePool(pool, NOW);
    expect(s).toContain('primary warm');
    expect(s).toContain('secondary COLD 360m REFUSED');
  });
});

describe('windowEndsAt — the account panel had no writer for its window chip (GAP 11)', () => {
  it('a reported reset is recorded UN-buffered and survives the round trip', () => {
    // The chip renders the provider's window end. coldUntilMs is that instant PLUS the
    // runner's own safety margin, so rendering it would show a time nobody reported.
    const pool = threeAccounts();
    markCold(pool, 'primary', 2_000, NOW);
    const primary = pool.accounts.find((a) => a.id === 'primary');
    expect(primary?.windowEndsAt).toBe(2_000 * 1000);
    expect(primary?.coldUntilMs).toBe(2_000 * 1000 + 60_000);

    const reloaded = buildPool([{ id: 'primary' }], {}, poolState(pool));
    expect(reloaded.accounts[0].windowEndsAt).toBe(2_000 * 1000);
  });

  it('an unobserved window is null, never a guess', () => {
    const pool = threeAccounts();
    expect(pool.accounts[0].windowEndsAt).toBeNull();
    // No reset reported: the fixed cooldown is a decision about when to RETRY, not an
    // observation of when the window ends.
    markCold(pool, 'primary', null, NOW);
    expect(pool.accounts[0].coldUntilMs).toBe(NOW + DEFAULT_COOLDOWN_MS);
    expect(pool.accounts[0].windowEndsAt).toBeNull();
  });

  it('a later limit with no reported reset does not erase an observed window', () => {
    const pool = threeAccounts();
    markCold(pool, 'primary', 2_000, NOW);
    markCold(pool, 'primary', null, NOW);
    expect(pool.accounts[0].windowEndsAt).toBe(2_000 * 1000);
  });

  it('a refusal is not a rate-limit window and leaves it alone', () => {
    const pool = threeAccounts();
    markRefused(pool, 'primary', 'org disabled access', NOW, AT);
    expect(pool.accounts[0].windowEndsAt).toBeNull();
  });
});
