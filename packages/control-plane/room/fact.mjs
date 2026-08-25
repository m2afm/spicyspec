/**
 * fact.mjs — the honesty spine. Rules R1, R2 and R3 of the deck spec, as code.
 *
 * The founder has been burned repeatedly by a UI that reported success while nothing was
 * happening. The structural answer is that no number reaches the page as a bare number: it
 * reaches it as a Fact, which carries WHERE IT CAME FROM and HOW OLD IT IS, and which renders
 * itself as an em dash under a hatch band when it cannot answer either question.
 *
 * Four provenance classes, one vocabulary, enforced here rather than declared per instrument:
 *   observed      — this page watched the transition land (the journal holds it)
 *   reported      — the server asserts it on this fetch, unwitnessed
 *   reconstructed — backfilled from state.ticks after the fact
 *   unknown       — the source field is absent
 *
 * Pure. The class names are contracts with app.html's stylesheet; the styling of each lives
 * there (2px solid underline / 1px soft / 1px dotted / hatch band), the CLASSIFICATION lives
 * here so one vocabulary governs the whole deck.
 */

import { DASH, UNKNOWN_GLYPH, ago, isNum, isText, ms } from './format.mjs';

export const OBSERVED = 'observed';
export const REPORTED = 'reported';
export const RECONSTRUCTED = 'reconstructed';
export const UNKNOWN = 'unknown';

/** Ordered weakest-last: a merged fact takes the WEAKEST evidence of its parts, never the best. */
export const PROVENANCE_ORDER = [OBSERVED, REPORTED, RECONSTRUCTED, UNKNOWN];

const RANK = new Map(PROVENANCE_ORDER.map((p, i) => [p, i]));

/** The CSS class app.html attaches the underline rules to. One class per provenance, no more. */
export const provenanceClass = (p) => `prov-${RANK.has(p) ? p : UNKNOWN}`;

/** Human words for a title attribute — the founder can hover any figure and be told. */
export const PROVENANCE_TEXT = {
  [OBSERVED]: 'observed — this page watched it happen',
  [REPORTED]: 'reported — the server asserts it, this page did not witness it',
  [RECONSTRUCTED]: 'reconstructed — backfilled from the ledger after the fact',
  [UNKNOWN]: 'unknown — the source field was absent',
};

/**
 * Freshness budgets, in milliseconds. Over budget, a fact hatches itself and appends
 * 'as of Xm ago'. `health` is a DEFAULT ONLY — the real number is
 * state.health.supervisor.staleAfterMs and `budgetFor` prefers it, because a hardcoded
 * staleness threshold is a second source of truth that will drift from the supervisor's.
 */
export const BUDGET = {
  state: 12_000,
  heartbeat: 30_000,
  health: 180_000,
  ticks: 600_000,
  gates: 3_600_000,
  live: 12_000,
  accounts: 600_000,
};

/**
 * The budget for a named metric, preferring what the SERVER declares over what we default to.
 *
 * `state.budgets` is served rather than hardcoded precisely because the supervisor owns its
 * own staleness grace and may change it; a second copy of that number in the page would drift
 * from the first and one of the two would start lying. The constants above are the fallback
 * for a server too old to publish the block, and nothing else.
 */
export function budgetFor(name, state) {
  const served = state && state.budgets && state.budgets[name];
  if (isNum(served) && served > 0) return served;
  if (name === 'health') {
    const declared = state && state.health && state.health.supervisor && state.health.supervisor.staleAfterMs;
    if (isNum(declared) && declared > 0) return declared;
  }
  return isNum(BUDGET[name]) ? BUDGET[name] : BUDGET.state;
}

/**
 * Is this timestamp inside its budget? Returns the age too, so a caller can say how stale
 * rather than only that it is stale. An absent timestamp is NOT "fresh" and NOT "stale" —
 * it is unknown, and the caller must render it as such.
 */
export function freshness(at, budgetMs, now = Date.now()) {
  const t = ms(at);
  if (t == null) return { known: false, stale: false, ageMs: null, text: DASH };
  const ageMs = Math.max(0, now - t);
  const stale = isNum(budgetMs) ? ageMs > budgetMs : false;
  return { known: true, stale, ageMs, text: ago(t, now) };
}

/**
 * The Fact primitive. Everything the deck prints goes through this.
 *
 *   fact(state.totals.notional, { text: money(v), source: 'totals.notional', prov: REPORTED })
 *
 * Returns a plain object app.html spreads onto a span. `known:false` is the honest zero: the
 * text is the em dash, the class carries the hatch, and the title names the field that was
 * missing so a founder debugging their own console can find it.
 */
export function fact(value, opts = {}) {
  const source = isText(opts.source) ? opts.source : null;
  const label = isText(opts.label) ? opts.label : null;
  const known = opts.known != null ? Boolean(opts.known) : value != null && value !== '' && !(typeof value === 'number' && !Number.isFinite(value));

  if (!known) {
    return {
      known: false,
      value: null,
      text: opts.unknownText || DASH,
      glyph: UNKNOWN_GLYPH,
      provenance: UNKNOWN,
      className: `fact ${provenanceClass(UNKNOWN)} fact-unknown --hatch`,
      title: source ? `not reported — ${source} is absent` : 'not reported',
      stale: false,
      ageMs: null,
      source,
      label,
      suffix: null,
    };
  }

  const prov = RANK.has(opts.prov) ? opts.prov : REPORTED;
  const budget = isNum(opts.budgetMs) ? opts.budgetMs : null;
  const fresh = opts.at != null ? freshness(opts.at, budget, opts.now) : { known: false, stale: false, ageMs: null, text: DASH };
  const stale = fresh.known && fresh.stale;
  const base = opts.text != null ? String(opts.text) : String(value);

  return {
    known: true,
    value,
    text: base,
    glyph: null,
    provenance: prov,
    className: `fact ${provenanceClass(prov)}${stale ? ' fact-stale --hatch' : ''}`,
    title: [
      label ? `${label}: ${base}` : base,
      PROVENANCE_TEXT[prov],
      source ? `source: ${source}` : null,
      fresh.known ? `read ${fresh.text}` : null,
    ].filter(Boolean).join(' · '),
    stale,
    ageMs: fresh.ageMs,
    source,
    label,
    // R3: over budget, the figure says out loud how old it is rather than looking current.
    suffix: stale ? `as of ${fresh.text}` : null,
  };
}

/** Shorthand for the commonest case: a field the server reported on this fetch. */
export const reported = (value, opts = {}) => fact(value, { ...opts, prov: REPORTED });

/** A figure the journal watched change — the strongest thing the deck can say. */
export const observed = (value, opts = {}) => fact(value, { ...opts, prov: OBSERVED });

/** Backfilled from the ledger. True of everything the room draws about a span it missed. */
export const reconstructed = (value, opts = {}) => fact(value, { ...opts, prov: RECONSTRUCTED });

/** An explicit hole. `missing('accounts[0].windowStartedAt')` renders the hatch and says why. */
export const missing = (source, opts = {}) => fact(null, { ...opts, source, known: false });

/**
 * Merge the evidence of several facts into one class for a derived figure. A ratio computed
 * from one observed and one unknown input is UNKNOWN, not observed — an average is never
 * better evidenced than its worst term. This is the rule that stops a derived number
 * laundering a missing field into a confident underline.
 */
export function weakest(...provs) {
  let worst = OBSERVED;
  for (const p of provs.flat()) {
    const r = RANK.get(p);
    if (r == null) return UNKNOWN;
    if (r > RANK.get(worst)) worst = p;
  }
  return worst;
}

/**
 * A whole instrument's evidence coverage: 'observed 31 of 40'. The deck's rule is that every
 * instrument declares its own coverage, and this is the single computation of it so the
 * phrasing cannot drift pane to pane.
 */
export function coverage(facts) {
  const list = Array.isArray(facts) ? facts : [];
  const total = list.length;
  const known = list.filter((f) => f && f.known).length;
  const byClass = { observed: 0, reported: 0, reconstructed: 0, unknown: 0 };
  for (const f of list) {
    const p = f && RANK.has(f.provenance) ? f.provenance : UNKNOWN;
    byClass[p] += 1;
  }
  return {
    total,
    known,
    byClass,
    // Never a percentage on its own: the denominator travels with it, always.
    text: total === 0 ? 'nothing to report' : `${known} of ${total} reported`,
    complete: total > 0 && known === total,
  };
}
