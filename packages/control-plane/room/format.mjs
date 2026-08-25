/**
 * format.mjs — the room's number-to-string layer, and the only place the em dash is minted.
 *
 * Rule R1 of the deck spec: NEVER '0' FOR UNKNOWN. Every formatter here returns the em dash
 * for a value it cannot prove, because '0' and '00:00' and '$0.00' are the exact class of lie
 * that has burned this founder — a chip that was always on, a progress bar reading a stale
 * file. `laneElapsed(null) === '—'` in app.html is the pattern; these are the rest of it.
 *
 * Pure. No DOM, no globals beyond Date/Intl. Imported by the browser as an ES module and by
 * vitest under node — nothing here may touch `window`.
 */

/** The one glyph that means "the source field was absent". Never '0', never '-', never ''. */
export const DASH = '—';
/** Sits inside a hatch band where a whole instrument has no source at all. */
export const UNKNOWN_GLYPH = '?';
/** Between a figure and its qualifier: `$18.95 · 16 runs`. */
export const SEP = '·';

/** A number the page may do arithmetic on. NaN and Infinity are unknowns, not numbers. */
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** A string with something in it. '' is an absent note, not an empty one. */
export const isText = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Epoch milliseconds out of whatever the server had to hand: an ISO string, a millisecond
 * number, a second-resolution number from a provider. Anything else is unknown.
 * Mirrors room-server.ts `epochMs`: past 1e12 it is already milliseconds.
 */
export function ms(value) {
  if (isNum(value)) {
    if (value <= 0) return null;
    return value > 1e12 ? value : value * 1000;
  }
  if (isText(value)) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/* ------------------------------------------------------------------- durations ---- */

/**
 * A duration a founder reads at a glance: '9s', '4m 12s', '1h 02m', '2d 6h'.
 * Negative spans clamp to zero — a clock that has drifted must not count backwards
 * (the same rule `laneElapsed` learned).
 */
export function dur(msSpan, opts = {}) {
  if (!isNum(msSpan)) return DASH;
  const total = Math.max(0, Math.round(msSpan / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return opts.terse ? `${m}m` : `${m}m ${String(s).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return `${h}h ${String(mm).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** '9.0h' — the telemetry-bus form, one decimal, for an uptime that is always hours. */
export function hours(msSpan) {
  if (!isNum(msSpan) || msSpan < 0) return DASH;
  return `${(msSpan / 3_600_000).toFixed(1)}h`;
}

/** 'HH:MM' on the viewer's own clock. A window that ends at 04:41 ends at THEIR 04:41. */
export function clockHM(at) {
  const t = ms(at);
  if (t == null) return DASH;
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 'HH:MM:SS' — the wire's time column, tabular-nums in the CSS. */
export function clockHMS(at) {
  const t = ms(at);
  if (t == null) return DASH;
  const d = new Date(t);
  return `${clockHM(t)}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/**
 * '6s ago' / '4m ago' / '3h ago' / 'in 42m'. Unknown stays unknown; this never says 'just now'
 * for a timestamp it does not have.
 */
export function ago(at, now = Date.now()) {
  const t = ms(at);
  if (t == null) return DASH;
  const delta = now - t;
  if (delta < 0) return `in ${dur(-delta, { terse: true })}`;
  if (delta < 10_000) return `${Math.max(1, Math.round(delta / 1000))}s ago`;
  return `${dur(delta, { terse: true })} ago`;
}

/* ---------------------------------------------------------------------- money ---- */

const GROUP = /\B(?=(\d{3})+(?!\d))/g;

/**
 * '$1,795.67'. `digits` defaults to 2 because this room's unit of account is a real invoice
 * that has already passed $1700 — rounding a founder's money to the dollar is a choice, not a
 * default.
 */
export function money(v, opts = {}) {
  if (!isNum(v)) return DASH;
  const digits = isNum(opts.digits) ? opts.digits : 2;
  const sign = v < 0 ? '-' : '';
  const fixed = Math.abs(v).toFixed(digits);
  const [whole, frac] = fixed.split('.');
  const grouped = whole.replace(GROUP, ',');
  return `${sign}$${grouped}${frac ? `.${frac}` : ''}`;
}

/** '$1.8k' for a rail label with 40px to work in. Never used where the exact figure fits. */
export function moneyShort(v) {
  if (!isNum(v)) return DASH;
  const abs = Math.abs(v);
  if (abs >= 1000) return `${v < 0 ? '-' : ''}$${(abs / 1000).toFixed(1)}k`;
  return money(v, { digits: abs >= 100 ? 0 : 2 });
}

/* ---------------------------------------------------------------------- counts ---- */

/** '1,795' — grouped integers. A count of nothing is a real 0; a count we lack is DASH. */
export function count(v) {
  if (!isNum(v)) return DASH;
  return String(Math.round(v)).replace(GROUP, ',');
}

/** '67%' from 0.67, or from 67 when `already` is set. Rounds half up, clamps nothing. */
export function pct(v, opts = {}) {
  if (!isNum(v)) return DASH;
  const n = opts.already ? v : v * 100;
  const digits = isNum(opts.digits) ? opts.digits : 0;
  return `${n.toFixed(digits)}%`;
}

/** A fixed-decimal rate: '17.2'. Used for tools/min and $/h where 0 is a real answer. */
export function rate(v, digits = 1) {
  if (!isNum(v)) return DASH;
  return v.toFixed(digits);
}

/** 'run' / 'runs' — so a card never reads '1 runs' and looks generated. */
export function plural(n, one, many) {
  if (!isNum(n)) return many;
  return Math.abs(n) === 1 ? one : many;
}

/**
 * '16 of 40 rows carry a cost' — the exclusion line. Every derived figure on the deck owes
 * one of these; a bare average over an unstated denominator is the quiet half of a lie.
 */
export function exclusion(have, total, what) {
  if (!isNum(have) || !isNum(total)) return `coverage of ${what} not reported`;
  return `${count(have)} of ${count(total)} ${plural(total, 'row', 'rows')} ${what}`;
}

/* ------------------------------------------------------------------ identifiers ---- */

/** A git head shortened the way the repo shortens it, and never padded when it is absent. */
export function shortHead(head) {
  if (!isText(head)) return DASH;
  return head.trim().slice(0, 7);
}

/** One line, ellipsised at the grapheme count the pane can hold. Full text goes in `title`. */
export function oneLine(text, max = 88) {
  if (!isText(text)) return DASH;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(1, max - 1))}…`;
}

/** 'Spec 008' from '008' — the room says "Spec 008", never "008" alone in prose. */
export function specLabel(id) {
  return isText(id) ? `Spec ${id.trim()}` : DASH;
}

/** Sentence case for a headline built out of a machine word: 'no-progress' → 'No progress'. */
export function sentence(text) {
  if (!isText(text)) return DASH;
  const flat = text.replace(/[-_]+/g, ' ').trim();
  return flat.charAt(0).toUpperCase() + flat.slice(1);
}
