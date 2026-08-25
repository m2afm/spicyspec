/**
 * metrics.mjs — every derivation the deck draws, and nothing that draws.
 *
 * The rule the whole file obeys: a figure that cannot be traced to a field of /api/state comes
 * back `null`, and the Fact layer turns null into an em dash under a hatch. There is no
 * default, no assumed window length, no zero standing in for a number nobody measured.
 *
 * Pure and framework-free: every function takes state (plus a clock, so tests are not racing
 * the wall) and returns plain data. Imported by the browser as an ES module and by vitest.
 */

import { DASH, count, isNum, isText, money, ms, oneLine, pct, plural, rate, sentence, shortHead } from './format.mjs';
import { median, sum, windowTrack } from './charts.mjs';
import { OBSERVED, RECONSTRUCTED, REPORTED, UNKNOWN, fact, missing, reported, weakest } from './fact.mjs';

/* ================================================================= exit classes ==== */

/** A run that ended the way it was supposed to. */
export const EXIT_GOOD = new Set(['clean', 'spec-complete']);
/** A run that ended needing the founder — not a break, but not progress either. */
export const EXIT_OWED = new Set(['awaiting-founder']);
/** The BAD set the night bell fires on and the digest reports under "what broke". */
export const EXIT_BAD = new Set(['blocked', 'no-progress', 'account-refused', 'stalled', 'failed', 'error']);
/** Bureau: the account pool, not the work. Real, but a money story rather than a break. */
export const EXIT_BUREAU = new Set(['rate-limited', 'account-switched']);

export function exitClass(exit) {
  const e = isText(exit) ? exit.trim().toLowerCase() : null;
  if (e == null) return 'unknown';
  if (EXIT_GOOD.has(e)) return 'good';
  if (EXIT_OWED.has(e)) return 'owed';
  if (EXIT_BAD.has(e)) return 'bad';
  if (EXIT_BUREAU.has(e)) return 'bureau';
  return 'other';
}

/* ============================================================== the tick's note ==== */

/**
 * The ledger's `note` is the richest unread field in the whole payload. Real examples:
 *   "0 closed · 223 tool calls · 40 verify cmds · 8 FAILED · 2 subagents"
 *   "judge kimi: ok"
 * Parsing it is how the deck can say "407 tool calls for 0 tasks closed" — the sentence that
 * turns a cost outlier from a number into an accusation. Every field is optional; a note the
 * parser does not recognise yields nulls and the caller says so rather than guessing.
 */
export function parseNote(note) {
  const text = isText(note) ? note : '';
  const grab = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : null;
  };
  const judge = text.match(/judge\s+([a-z0-9_-]+)\s*:\s*([a-z-]+)/i);
  return {
    raw: isText(note) ? note : null,
    closed: grab(/(\d+)\s+closed\b/i),
    tools: grab(/(\d+)\s+tool\s+calls?\b/i),
    verify: grab(/(\d+)\s+verify\s+cmds?\b/i),
    verifyFailed: grab(/(\d+)\s+FAILED\b/),
    subagents: grab(/(\d+)\s+subagents?\b/i),
    judge: judge ? { by: judge[1], verdict: judge[2] } : null,
  };
}

/** `redFirst` arrives as a string, an array, or an object depending on who wrote the row. */
export function redFirstPaths(redFirst) {
  if (isText(redFirst)) return [redFirst.trim()];
  if (Array.isArray(redFirst)) return redFirst.filter(isText).map((s) => s.trim());
  if (redFirst && typeof redFirst === 'object') {
    return Object.values(redFirst).filter(isText).map((s) => s.trim());
  }
  return [];
}

/**
 * One ledger row, normalised, with its note parsed and its identity settled. `tick` is NOT an
 * identity — the live payload carries ticks numbered 1,2,1,2,1,… because the counter restarts
 * per attempt. Identity is the start stamp where there is one, and the row's position where
 * there is not, which is exactly why the deck says out loud how many rows have no stamp.
 */
export function normaliseTick(row, index) {
  const startedAt = ms(row && row.startedAt);
  const note = parseNote(row && row.note);
  const minutes = isNum(row && row.minutes) ? row.minutes : null;
  return {
    index,
    key: startedAt != null ? `t:${startedAt}` : `i:${index}`,
    tick: isNum(row && row.tick) ? row.tick : null,
    attempt: isText(row && row.attempt) ? row.attempt : null,
    exit: isText(row && row.exit) ? row.exit : null,
    exitClass: exitClass(row && row.exit),
    account: isText(row && row.account) ? row.account : null,
    minutes,
    closed: isNum(row && row.closed) ? row.closed : null,
    cost: isNum(row && row.cost) ? row.cost : null,
    head: isText(row && row.head) ? row.head : null,
    spec: isText(row && row.spec) ? row.spec : null,
    startedAt,
    endedAt: startedAt != null && minutes != null ? startedAt + minutes * 60_000 : null,
    tracker: isText(row && row.tracker) ? row.tracker : null,
    note,
    redFirst: redFirstPaths(row && row.redFirst),
  };
}

/** The whole ledger slice, normalised once so nine instruments do not each re-parse it. */
export const ledgerRows = (state) => (Array.isArray(state && state.ticks) ? state.ticks : []).map(normaliseTick);

/* ==================================================================== C1 CADENCE ==== */

/**
 * THE PROOF-OF-LIFE INSTRUMENT. Everything else on this page ASSERTS that the loop is
 * working — a chip, a word, a green row. The cadence meter DEMONSTRATES it, by differencing
 * state.live.tools across state pushes: if the number of tool calls has not moved in four
 * minutes, no chip anywhere may claim the loop is working, and this is the only instrument
 * that can know that.
 *
 * `samples` is the caller's ring of `{ at, laneId, tools, verification, subagents }`, oldest
 * first. A lane change resets `tools` to a small number; that is NOT negative movement, it is
 * a new lane starting, and it counts as movement.
 */
export function cadence(samples, opts = {}) {
  const now = isNum(opts.now) ? opts.now : Date.now();
  const list = (Array.isArray(samples) ? samples : []).filter((s) => s && isNum(s.at));
  const slots = isNum(opts.slots) ? opts.slots : 60;

  const bars = [];
  let moved = 0;
  let lastMovementAt = null;
  let firstAt = null;

  for (let i = 0; i < list.length; i += 1) {
    const cur = list[i];
    const prev = i > 0 ? list[i - 1] : null;
    if (firstAt == null) firstAt = cur.at;
    if (!prev) { bars.push({ at: cur.at, delta: null, known: false, reason: 'first frame — nothing to difference' }); continue; }

    const laneChanged = prev.laneId !== cur.laneId;
    const a = isNum(prev.tools) ? prev.tools : null;
    const b = isNum(cur.tools) ? cur.tools : null;

    if (b == null || (!laneChanged && a == null)) { bars.push({ at: cur.at, delta: null, known: false, reason: 'tools not reported' }); continue; }

    const delta = laneChanged ? Math.max(0, b) : Math.max(0, b - a);
    bars.push({ at: cur.at, delta, known: true, laneChanged });
    moved += delta;
    if (delta > 0) lastMovementAt = cur.at;
  }

  const tail = bars.slice(-slots);
  const watchedMs = firstAt == null ? 0 : Math.max(0, now - firstAt);
  const measured = tail.filter((b) => b.known);
  const measuredSpanMs = measured.length > 1 ? measured[measured.length - 1].at - measured[0].at : 0;
  const measuredTools = measured.reduce((a, b) => a + b.delta, 0);
  const perMin = measuredSpanMs > 0 ? (measuredTools / measuredSpanMs) * 60_000 : null;

  // The honest part: with no movement in the ring we can only say the loop has not moved
  // SINCE WE STARTED WATCHING, and the flag says which of the two statements this is.
  const movementProven = lastMovementAt != null;
  const lastMovementMs = movementProven ? Math.max(0, now - lastMovementAt) : (firstAt == null ? null : watchedMs);

  const live = opts.live || null;
  const working = opts.loopState === 'WORKING';
  let verdict;
  if (list.length < 2 || lastMovementMs == null) verdict = 'unknown';
  else if (!working && !live) verdict = 'idle';
  else if (lastMovementMs <= 45_000) verdict = 'moving';
  else if (lastMovementMs <= 120_000) verdict = 'slow';
  else verdict = 'stalled';

  const tools = live && isNum(live.tools) ? live.tools : null;
  return {
    bars: tail,
    slots,
    perMin,
    perMinText: perMin == null ? DASH : `${rate(perMin, perMin < 10 ? 1 : 0)} tools/min`,
    moved: measuredTools,
    lastMovementMs,
    lastMovementAt,
    movementProven,
    watchedMs,
    frames: list.length,
    verdict,
    // The literal sentence the strip prints when it turns hot. It names the FIGURE that has
    // not moved, because "stalled" is an opinion and "502 tools, unchanged for 4m 12s" is not.
    stallText: verdict === 'stalled' && tools != null ? `${count(tools)} tools, unchanged for ${durMs(lastMovementMs)}` : null,
    // What the meter is allowed to claim, in one line, whatever its verdict.
    text: list.length < 2
      ? 'not enough frames yet to prove movement'
      : movementProven
        ? `${perMin == null ? DASH : `${rate(perMin, 1)} tools/min`} · last movement ${durMs(lastMovementMs)} ago`
        : `no movement in the ${durMs(watchedMs)} this page has been watching`,
  };
}

/** Local duration formatter — cadence needs '4m 12s' shaped exactly like the spec's copy. */
function durMs(v) {
  if (!isNum(v)) return DASH;
  const s = Math.max(0, Math.round(v / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/* =============================================================== Z0 ANNUNCIATORS ==== */

const NOMINAL = 'nominal';
const CAUTION = 'caution';
const ALARM = 'alarm';

/** The eight slots, in the order they are wired. Position is meaning; nothing reorders them. */
export const ANNUNCIATOR_SLOTS = ['LOOP', 'FEED', 'SUPV', 'STOP', 'RATE', 'OWED', 'PARK', 'GATE'];

/**
 * The annunciator bar. Eight fixed slots — a founder learns where a light lives and reads it
 * by POSITION from across the room, which is the whole point of a fixed deck.
 *
 * Every slot returns a `sig`: a signature of the CONDITION, not of the level. Ack is keyed by
 * sig, so acknowledging "worker heartbeat failed" does not pre-acknowledge the next, different
 * failure of the same slot. That bug — an ack that silences a light forever — is the same
 * family as the chip that was always on.
 */
export function annunciators(state, opts = {}) {
  const now = isNum(opts.now) ? opts.now : Date.now();
  const s = state || {};
  const out = [];
  const push = (key, label, level, detail, sig, extra = {}) => out.push({ key, label, level, detail, sig: `${key}:${sig}`, ...extra });

  /* LOOP — the word the room is showing, escalated by the cadence meter's evidence. */
  const activity = s.activity || {};
  const loopState = isText(activity.state) ? activity.state : null;
  const cad = opts.cadence || null;
  if (loopState == null) {
    push('LOOP', 'LOOP', ALARM, 'the server did not report an activity state', 'no-state');
  } else if (cad && cad.verdict === 'stalled' && loopState === 'WORKING') {
    // The override that makes the bar honest: the room says WORKING, the tool counter says
    // nothing has happened for minutes. The counter wins.
    push('LOOP', 'LOOP', CAUTION, cad.stallText || 'reported WORKING but no tool call has landed', `stalled:${loopState}`);
  } else if (activity.tone === 'off') {
    push('LOOP', loopState, ALARM, isText(activity.reason) ? activity.reason : 'stopped', `off:${loopState}:${activity.reason || ''}`);
  } else if (activity.tone === 'warn') {
    push('LOOP', loopState, CAUTION, isText(activity.reason) ? activity.reason : 'not working', `warn:${loopState}:${activity.reason || ''}`);
  } else {
    push('LOOP', loopState, NOMINAL, isText(activity.reason) ? activity.reason : 'working', `on:${loopState}`);
  }

  /* FEED — is the page still being told anything? Not "did the server say it is up". */
  const feed = opts.feed || {};
  const lastFrameAt = ms(feed.lastFrameAt);
  const feedAge = lastFrameAt == null ? null : Math.max(0, now - lastFrameAt);
  const budget = isNum(opts.feedBudgetMs) ? opts.feedBudgetMs : 12_000;
  if (feed.readyState === 2 || feed.closed === true) {
    push('FEED', 'FEED', ALARM, 'the event stream closed — this page is not being told anything', 'closed');
  } else if (lastFrameAt == null) {
    push('FEED', 'FEED', CAUTION, 'no frame has arrived yet on this connection', 'no-frame');
  } else if (feedAge > budget * 4) {
    push('FEED', 'FEED', ALARM, `silent for ${durMs(feedAge)} — everything below is that old`, 'silent-long', { ageMs: feedAge });
  } else if (feedAge > budget) {
    push('FEED', 'FEED', CAUTION, `${durMs(feedAge)} since the last push`, 'silent', { ageMs: feedAge });
  } else {
    push('FEED', 'FEED', NOMINAL, `pushed ${durMs(feedAge)} ago`, 'live');
  }

  /* SUPV — the supervisor that once exited silently and reported healthy. */
  const sup = (s.health && s.health.supervisor) || null;
  const supAt = sup ? ms(sup.lastAt) : null;
  const supBudget = sup && isNum(sup.staleAfterMs) ? sup.staleAfterMs : 180_000;
  if (!sup) {
    push('SUPV', 'SUPV', ALARM, 'no supervisor report in the payload at all', 'absent');
  } else if (sup.reporting === false) {
    push('SUPV', 'SUPV', ALARM, supAt == null ? 'never reported' : `last reported ${durMs(now - supAt)} ago${isText(sup.advice) ? ` — ${sup.advice}` : ''}`, `down:${sup.lastAt || 'never'}`);
  } else if (supAt != null && now - supAt > supBudget) {
    push('SUPV', 'SUPV', CAUTION, `reporting, but the last check is ${durMs(now - supAt)} old`, `stale:${sup.lastAt}`);
  } else {
    const failed = (Array.isArray(s.health && s.health.rows) ? s.health.rows : []).filter((r) => r && (r.status === 'failed' || r.status === 'blocked'));
    if (failed.length) {
      push('SUPV', 'SUPV', ALARM, `${failed.length} ${plural(failed.length, 'check', 'checks')} failing: ${failed.map((r) => r.label || r.check).join(', ')}`, `rows:${failed.map((r) => `${r.check}=${r.status}`).join('|')}`);
    } else {
      push('SUPV', 'SUPV', NOMINAL, 'all checks reporting ok', 'ok');
    }
  }

  /* STOP — and it names who armed it, because "I did this" reads differently to "this was done to me". */
  const stopFlag = s.stopFlag || null;
  const killFlag = s.killFlag || null;
  if (s.killArmed) {
    push('STOP', 'KILL', ALARM, `kill armed${killFlag && isText(killFlag.armedBy) ? ` by ${killFlag.armedBy}` : ' — by nobody the flag names'}`, `kill:${(killFlag && killFlag.armedAt) || 'unknown'}`);
  } else if (s.stopArmed) {
    push('STOP', 'STOP', CAUTION, `stop armed${stopFlag && isText(stopFlag.armedBy) ? ` by ${stopFlag.armedBy}` : ' — by nobody the flag names'}`, `stop:${(stopFlag && stopFlag.armedAt) || 'unknown'}`);
  } else {
    push('STOP', 'STOP', NOMINAL, 'no stop flag armed', 'clear');
  }

  /* RATE — the account pool's headroom. */
  const accounts = Array.isArray(s.accounts) ? s.accounts : [];
  const utils = accounts.map((a) => (a && isNum(a.utilization) ? a.utilization : null)).filter(isNum);
  const cold = accounts.filter((a) => a && a.cold === true);
  const refused = accounts.filter((a) => a && a.refused === true);
  const topUtil = utils.length ? Math.max(...utils) : null;
  if (accounts.length && cold.length === accounts.length) {
    push('RATE', 'RATE', ALARM, 'every account is cold — nothing can be dispatched', `all-cold:${accounts.length}`);
  } else if (refused.length) {
    push('RATE', 'RATE', ALARM, `${refused.length} refused: ${refused.map((a) => `${a.id}${isText(a.refusedReason) ? ` (${a.refusedReason})` : ''}`).join(', ')}`, `refused:${refused.map((a) => a.id).join('|')}`);
  } else if (cold.length) {
    push('RATE', 'RATE', CAUTION, `${cold.length} cold: ${cold.map((a) => a.id).join(', ')}`, `cold:${cold.map((a) => a.id).join('|')}`);
  } else if (topUtil != null && topUtil >= 0.85) {
    push('RATE', 'RATE', CAUTION, `${pct(topUtil)} used on the busiest window`, `util:${Math.round(topUtil * 20)}`);
  } else if (topUtil == null) {
    push('RATE', 'RATE', CAUTION, 'no account reports a utilization figure', 'no-util');
  } else {
    push('RATE', 'RATE', NOMINAL, `${pct(topUtil)} on the busiest window`, 'ok');
  }

  /* OWED — the count of things only the founder can clear.
     The list from /api/owed wins where the page has fetched it; otherwise the memoised count
     the frame carries. That count ships its own age because /api/owed walks git per item and
     is not recomputed every four seconds — so a stale count says it is stale rather than
     posing as this second's truth. */
  const owedList = Array.isArray(opts.owed) ? opts.owed.filter((o) => o && o.signedOff !== true) : null;
  const owedFrame = s.owed || null;
  const owedCount = owedList != null ? owedList.length : (owedFrame && isNum(owedFrame.count) ? owedFrame.count : null);
  const owedStale = owedList == null && owedFrame && owedFrame.stale === true;
  if (owedCount == null) {
    push('OWED', 'OWED', CAUTION, 'nothing has answered with an owed count on this page yet', 'unknown');
  } else if (owedCount > 0) {
    push('OWED', String(owedCount), CAUTION, `${owedCount} ${plural(owedCount, 'thing', 'things')} only you can clear${owedStale ? ` — counted ${durMs(owedFrame.ageMs)} ago` : ''}`, `n:${owedCount}`);
  } else if (owedStale) {
    push('OWED', 'OWED', CAUTION, `nothing owed as of ${durMs(owedFrame.ageMs)} ago — the count has not been refreshed since`, 'clear-stale');
  } else {
    push('OWED', 'OWED', NOMINAL, 'nothing owed', 'clear');
  }

  /* PARK — work the loop stopped on. */
  const parked = Array.isArray(s.parked) ? s.parked : [];
  if (parked.length) {
    push('PARK', String(parked.length), CAUTION, `${parked.length} parked: ${oneLine(parked[0], 60)}`, `n:${parked.length}:${parked.join('|').length}`);
  } else {
    push('PARK', 'PARK', NOMINAL, 'nothing parked', 'clear');
  }

  /* GATE — a spec whose closing gate the server flagged. */
  const entries = Array.isArray(s.catalog && s.catalog.entries) ? s.catalog.entries : [];
  const gateWarn = entries.filter((e) => e && e.closingGateWarning === true);
  if (gateWarn.length) {
    push('GATE', String(gateWarn.length), ALARM, `closing gate flagged on ${gateWarn.map((e) => e.id).join(', ')}`, `warn:${gateWarn.map((e) => e.id).join('|')}`);
  } else {
    push('GATE', 'GATE', NOMINAL, 'no closing gate flagged', 'clear');
  }

  return out;
}

/** The bar's own summary: how many lights are lit and at what level. Drives the tab title. */
export function annunciatorSummary(slots) {
  const list = Array.isArray(slots) ? slots : [];
  const alarm = list.filter((x) => x.level === ALARM);
  const caution = list.filter((x) => x.level === CAUTION);
  return {
    alarm: alarm.length,
    caution: caution.length,
    level: alarm.length ? ALARM : caution.length ? CAUTION : NOMINAL,
    worst: alarm[0] || caution[0] || null,
    text: alarm.length ? `${alarm.length} alarm` : caution.length ? `${caution.length} caution` : 'nominal',
  };
}

/**
 * Ack bookkeeping, kept pure so the acked set can live in a ref and be tested. A slot whose
 * SIGNATURE changed is un-acked automatically: a new failure of the same slot must re-alarm.
 */
export function applyAcks(slots, acked, now = Date.now()) {
  const map = acked instanceof Map ? acked : new Map(Object.entries(acked || {}));
  return (Array.isArray(slots) ? slots : []).map((slot) => {
    const at = map.get(slot.sig);
    const isAcked = isNum(at) && slot.level !== NOMINAL;
    return {
      ...slot,
      acked: isAcked,
      ackedAt: isAcked ? at : null,
      // R4-adjacent: blink is a property of the model, not a class app.html toggles on a push.
      blink: slot.level !== NOMINAL && !isAcked,
      // 5 minutes unacked and the light grows a ring. An alarm nobody has touched is worse
      // news than a fresh one.
      escalated: slot.level === ALARM && !isAcked && isNum(slot.since) ? now - slot.since > 300_000 : false,
    };
  });
}

/* ===================================================================== Z1-C BURN ==== */

/**
 * The money cell. Four figures, each with its n and its exclusion line.
 *
 * WHO COMPUTES WHAT, and why it matters: `state.ticks` is capped at the newest 40 rows while
 * the ledger holds 83, so ANY rate this page derives from the array is a rate over a window it
 * cannot name. `state.ledger` is the server's aggregate over every row, and where it is
 * present its figures win outright — including their `basis` strings, which say what each
 * denominator actually was. The client arithmetic below is the fallback for a server too old
 * to publish the block, and it labels itself as a window figure rather than a headline.
 *
 * This is the deck's general rule for a divided number: the numerator and the denominator must
 * come from the same population, or the number is not printed.
 */
export function burn(state, opts = {}) {
  const s = state || {};
  const totals = s.totals || {};
  const led = s.ledger || null;
  const rows = ledgerRows(s);
  const prov = opts.prov || REPORTED;

  const notional = isNum(totals.notional) ? totals.notional : null;
  const priced = rows.filter((r) => r.cost != null);
  const stamped = rows.filter((r) => r.startedAt != null);

  /** A served Metric ({ value, n, basis }) becomes a Fact; anything else falls through. */
  const fromServer = (metric, label, render) => {
    if (!metric || !isNum(metric.value)) return null;
    return fact(metric.value, {
      text: render(metric.value),
      source: isText(metric.basis) ? `ledger · ${metric.basis}` : 'state.ledger',
      prov,
      label,
      n: metric.n,
    });
  };

  const servedBurn = (led && led.burn) || {};
  const perHourFact = fromServer(servedBurn.perHour, 'burn rate', (v) => `${money(v, { digits: 2 })}/h`);
  const perTickFact = fromServer(servedBurn.perRun, 'per run', (v) => `${money(v, { digits: 2 })}/run`);
  const perClosedFact = fromServer(servedBurn.perTaskClosed, 'per task closed', (v) => `${money(v, { digits: 2 })}/task`);

  // Fallback arithmetic, used only when the server published no ledger digest. Both terms of
  // every ratio are whole-ledger totals so the population matches.
  const minutes = isNum(totals.minutes) ? totals.minutes : null;
  const ticks = isNum(totals.ticks) ? totals.ticks : null;
  const closed = isNum(totals.closed) ? totals.closed : null;
  const fbHour = notional != null && minutes != null && minutes > 0 ? notional / (minutes / 60) : null;
  const fbTick = notional != null && ticks != null && ticks > 0 ? notional / ticks : null;
  const fbClosed = notional != null && closed != null && closed > 0 ? notional / closed : null;

  // The window figure is always the page's own, and always says how many rows it covers.
  const windowCost = sum(priced.map((r) => r.cost));
  const windowMinutes = sum(priced.map((r) => r.minutes));
  const windowPerHour = windowCost != null && isNum(windowMinutes) && windowMinutes > 0 ? windowCost / (windowMinutes / 60) : null;

  // Exclusion lines: the server's Coverage rows already carry the exact sentence, and it is
  // computed over 83 rows rather than 40 — so it is used verbatim when it exists.
  const exclusions = [];
  if (led && led.priced && isText(led.priced.line)) exclusions.push(led.priced.line);
  else exclusions.push(`${count(priced.length)} of ${count(rows.length)} ${plural(rows.length, 'row', 'rows')} carry a cost`);
  if (led && led.stamped && isText(led.stamped.missingLine)) exclusions.push(led.stamped.missingLine);
  else if (rows.length - stamped.length > 0) exclusions.push(`${count(rows.length - stamped.length)} of ${count(rows.length)} carry no start stamp`);
  const ledgerRowCount = led && isNum(led.rows) ? led.rows : (isNum(totals.rows) ? totals.rows : null);
  if (ledgerRowCount != null && ledgerRowCount > rows.length) {
    exclusions.push(`the page holds the newest ${count(rows.length)} of ${count(ledgerRowCount)} ledger rows`);
  }

  return {
    served: Boolean(led),
    notional: fact(notional, { text: money(notional), source: 'totals.notional', prov, label: 'spent' }),
    perHour: perHourFact || fact(fbHour, {
      text: fbHour == null ? DASH : `${money(fbHour, { digits: 2 })}/h`,
      source: 'totals.notional ÷ totals.minutes',
      prov: weakest(prov, notional != null && minutes != null ? prov : UNKNOWN),
      label: 'burn rate',
    }),
    perTick: perTickFact || fact(fbTick, { text: fbTick == null ? DASH : `${money(fbTick, { digits: 2 })}/run`, source: 'totals.notional ÷ totals.ticks', prov, label: 'per run' }),
    perClosed: perClosedFact || fact(fbClosed, {
      text: fbClosed == null ? DASH : `${money(fbClosed, { digits: 2 })}/task`,
      source: 'totals.notional ÷ totals.closed',
      prov,
      label: 'per task closed',
    }),
    window: {
      perHour: windowPerHour,
      cost: windowCost,
      minutes: windowMinutes,
      n: priced.length,
      text: windowPerHour == null ? DASH : `${money(windowPerHour, { digits: 2 })}/h across the last ${count(priced.length)} priced ${plural(priced.length, 'run', 'runs')}`,
    },
    n: { rows: rows.length, priced: priced.length, stamped: stamped.length, ticks, closed, ledgerRows: ledgerRowCount },
    exclusions,
    median: {
      // The server's median is over every row; the page's is over the forty it holds.
      cost: led && led.cost && isNum(led.cost.median) ? led.cost.median : median(priced.map((r) => r.cost)),
      minutes: led && led.minutes && isNum(led.minutes.median) ? led.minutes.median : median(rows.map((r) => r.minutes)),
      n: led && led.cost && isNum(led.cost.n) ? led.cost.n : priced.length,
      served: Boolean(led && led.cost),
    },
  };
}

/* ================================================================== Z1-D RUNWAY ==== */

/**
 * The three account meters as TIMELINES. A bar says "62% used"; a timeline says "62% used and
 * the window resets in 41 minutes", which is the difference between a number and a decision.
 *
 * Nothing records when a rate window OPENED. The server derives `windowStartedAt` as the
 * earliest run it can prove was already inside the window — a lower bound — and ships
 * `windowStartedAtSource` saying so. The meter carries that label rather than swallowing it:
 * a derived start drawn as a measured one is a picture that claims a resolution it lacks. An
 * account with no start at all hatches its whole track; no window length is ever assumed.
 */
export function runway(state, opts = {}) {
  const now = isNum(opts.now) ? opts.now : Date.now();
  const accounts = Array.isArray(state && state.accounts) ? state.accounts : [];
  const utilBudget = isNum(opts.utilizationBudgetMs) ? opts.utilizationBudgetMs : 600_000;

  const metres = accounts.map((a) => {
    const util = a && isNum(a.utilization) ? a.utilization : null;
    const endsAt = a ? ms(a.windowEndsAt) : null;
    const startedAt = a ? ms(a.windowStartedAt) : null;
    const startSource = isText(a && a.windowStartedAtSource) ? a.windowStartedAtSource : null;
    // WHEN the utilization figure was read. A six-hour-old 62% drawn as a live fill is the
    // stale-file bug in a new costume, so the meter hatches once the figure is past budget.
    const utilAt = a ? ms(a.utilizationAt) : null;
    const utilStale = utilAt != null && now - utilAt > utilBudget;
    const track = windowTrack({ startedAt, endsAt, now, utilization: util });
    const cold = Boolean(a && a.cold);
    const refused = Boolean(a && a.refused);

    // Headroom is what ranks the meters, and an account we cannot measure must not be ranked
    // as roomy. Unknown headroom sorts as "worst known" so it is never quietly reassuring.
    const headroom = cold || refused ? -1 : util == null ? null : 1 - util;

    return {
      id: isText(a && a.id) ? a.id : null,
      cold,
      coldMinutes: a && isNum(a.coldMinutes) ? a.coldMinutes : null,
      refused,
      refusedReason: isText(a && a.refusedReason) ? a.refusedReason : null,
      rateStatus: isText(a && a.rateStatus) ? a.rateStatus : null,
      overageStatus: isText(a && a.overageStatus) ? a.overageStatus : null,
      ticks: a && isNum(a.ticks) ? a.ticks : null,
      cost: a && isNum(a.cost) ? a.cost : null,
      utilization: util,
      utilizationAt: utilAt,
      utilizationStale: utilStale,
      utilizationFact: util == null
        ? missing(`accounts[${a && a.id}].utilization`, { unknownText: 'utilization not reported' })
        : reported(util, { text: pct(util), source: `accounts.${a.id}.utilization`, label: 'window used', at: utilAt, budgetMs: utilBudget, now }),
      endsAt,
      startedAt,
      startSource,
      // Printed under the track, verbatim, whenever the start is a derivation rather than a
      // record — so the timeline never implies a precision the data does not have.
      startNote: startedAt == null
        ? 'window start not reported'
        : isText(startSource) ? `window start ${startSource}` : null,
      track,
      headroom,
      // The label the meter prints, exactly: `primary · 62% · window ends 04:41`.
      label: [
        isText(a && a.id) ? a.id : DASH,
        util == null ? 'utilization not reported' : pct(util),
        endsAt == null ? 'window end not reported' : `window ends ${new Date(endsAt).getHours().toString().padStart(2, '0')}:${new Date(endsAt).getMinutes().toString().padStart(2, '0')}`,
      ].join(' · '),
      alertText: refused
        ? `refused${isText(a && a.refusedReason) ? ` — ${a.refusedReason}` : ' — no reason reported'}`
        : cold
          ? `cold${a && isNum(a.coldMinutes) && a.coldMinutes > 0 ? ` ${a.coldMinutes}m` : ''}${isText(a && a.refusedReason) ? ` — ${a.refusedReason}` : ''}`
          : null,
    };
  });

  // Least headroom renders at 1.4× height. Cold/refused (-1) beats everything; unknown beats
  // every known figure, because an unmeasured account is not a safe account.
  const rank = (m) => (m.headroom == null ? -0.5 : m.headroom);
  const tightest = metres.length ? metres.slice().sort((x, y) => rank(x) - rank(y))[0] : null;

  return {
    metres,
    tightest,
    anyCold: metres.some((m) => m.cold),
    allCold: metres.length > 0 && metres.every((m) => m.cold),
    anyRefused: metres.some((m) => m.refused),
    unmeasured: metres.filter((m) => m.utilization == null).map((m) => m.id),
    // The pool's own coverage line — two of three accounts reporting is not "the pool is fine".
    coverageText: metres.length === 0
      ? 'no accounts reported'
      : `${metres.filter((m) => m.utilization != null).length} of ${metres.length} accounts report a window`,
  };
}

/* ================================================================= Z3 SPEC LADDER ==== */

/** Catalog cells, id-ordered, with the fill fraction the ladder draws and the tone it wears. */
export function ladder(state) {
  const entries = Array.isArray(state && state.catalog && state.catalog.entries) ? state.catalog.entries : [];
  const activeIds = new Set((Array.isArray(state && state.actives) ? state.actives : []).map((a) => a && a.id).filter(isText));

  return entries
    .slice()
    .sort((a, b) => String(a && a.id).localeCompare(String(b && b.id)))
    .map((e) => {
      const p = (e && e.progress) || {};
      const total = isNum(p.total) ? p.total : null;
      const done = isNum(p.done) ? p.done : null;
      const held = isNum(p.held) ? p.held : 0;
      // `held` counts: a task held open WITH a stated reason is work that happened, and
      // dropping it made the built bar diverge from the terminal's numbers once already.
      const fraction = total != null && total > 0 && done != null ? Math.min(1, (done + held) / total) : null;
      return {
        id: isText(e && e.id) ? e.id : null,
        slug: isText(e && e.slug) ? e.slug : null,
        status: isText(e && e.status) ? e.status : 'unknown',
        stage: isText(e && e.stage) ? e.stage : null,
        active: activeIds.has(e && e.id),
        gateWarning: Boolean(e && e.closingGateWarning),
        closingGate: isText(e && e.closingGate) ? e.closingGate : null,
        fraction,
        progress: { done, open: isNum(p.open) ? p.open : null, held, unmarked: isNum(p.unmarked) ? p.unmarked : null, total },
        progressText: total == null
          ? 'no tasks.md the room can read'
          : `${count(done)}/${count(total)} done${isNum(p.open) && p.open ? ` · ${count(p.open)} open` : ''}${isNum(p.unmarked) && p.unmarked ? ` · ${count(p.unmarked)} unmarked` : ''}${held ? ` · ${count(held)} held` : ''}`,
        title: `${isText(e && e.id) ? `Spec ${e.id}` : 'spec'}${isText(e && e.slug) ? ` ${e.slug}` : ''}`,
      };
    });
}

/* ================================================================== Z3 OWED RANK ==== */

/**
 * Which one FIRST. `sortOwed` in app.html answers "which is closest to done", which is the
 * right tiebreak and the wrong headline — six equal tiles never told the founder where to
 * start. Unblock weight ranks by HOW MUCH MOVES if this one clears: a parked decision naming
 * five downstream specs outranks a sign-off that finishes one.
 *
 * `sortOwed` is not reimplemented here; pass it as `opts.tiebreak` and it stays the tiebreak,
 * which is also why the test suite that slices it out of app.html keeps working.
 */
export function unblockWeight(item) {
  if (!item) return { weight: 0, unblocks: 0, why: 'nothing to weigh' };
  const affects = isText(item.affectsSpec) ? item.affectsSpec : '';
  // '004 — and every later spec touching payments (006, 012, 013, 017)' → five ids.
  const ids = new Set((affects.match(/\b\d{3}\b/g) || []));
  const unblocks = ids.size;
  const p = item.progress || {};
  const done = isNum(p.done) ? p.done : 0;
  const total = isNum(p.total) ? p.total : null;
  const nearness = total && total > 0 ? done / total : 0;

  let weight = 0;
  // Specs downstream dominate: this is the "how much moves" term.
  weight += unblocks * 10;
  // A blocker the loop cannot route around at all — the founder-only class — outranks a
  // sign-off of equal reach, because the loop is stopped on it right now.
  if (item.kind === 'parked') weight += 6;
  if (/founder-only|blocks DONE|OWNER DECISION/i.test(`${item.title || ''} ${affects}`)) weight += 8;
  if (/money|payment|payout|credential/i.test(`${item.title || ''} ${affects}`)) weight += 3;
  // One click from finished is worth something, but never more than reach.
  if (p.complete === true) weight += 5;
  weight += nearness * 2;

  return {
    weight,
    unblocks,
    ids: [...ids],
    why: unblocks > 0
      ? `unblocks ${unblocks} ${plural(unblocks, 'spec', 'specs')}${ids.size ? ` (${[...ids].join(', ')})` : ''}`
      : p.complete === true
        ? 'one click from signed off'
        : 'no downstream spec named',
  };
}

export function rankOwed(items, opts = {}) {
  const list = (Array.isArray(items) ? items : []).filter((i) => i && i.signedOff !== true);
  const weighed = list.map((item) => ({ ...item, rank: unblockWeight(item) }));
  const tiebreak = typeof opts.tiebreak === 'function' ? opts.tiebreak : null;
  // The tiebreak runs FIRST so the stable sort below preserves its order inside a weight tie.
  const base = tiebreak ? tiebreak(weighed) : weighed;
  const ordered = base.slice().sort((a, b) => (b.rank ? b.rank.weight : 0) - (a.rank ? a.rank.weight : 0));
  return ordered.map((item, i) => ({ ...item, lead: i === 0 }));
}

/* ===================================================================== Z6 BUS ======== */

/** The telemetry bus line — every item a fact with a budget, the stale ones hatching. */
export function telemetry(state, opts = {}) {
  const now = isNum(opts.now) ? opts.now : Date.now();
  const s = state || {};
  const git = s.git || {};
  const driver = s.driver || {};
  const beat = ms(driver.heartbeat);
  const started = ms(driver.startedAt);
  const pushed = ms(opts.lastFrameAt);

  const items = [
    reported(git.head, { text: `head ${shortHead(git.head)}`, source: 'git.head', label: 'head' }),
    reported(git.branch, { text: isText(git.branch) ? git.branch : DASH, source: 'git.branch', label: 'branch' }),
    fact(isNum(git.dirty) ? git.dirty : null, { text: isNum(git.dirty) ? `${count(git.dirty)} dirty` : DASH, source: 'git.dirty', prov: REPORTED, label: 'dirty files' }),
    fact(isNum(driver.pid) ? driver.pid : null, { text: isNum(driver.pid) ? `pid ${driver.pid}` : DASH, source: 'driver.pid', prov: REPORTED, label: 'driver pid' }),
    fact(started, { text: started == null ? DASH : `up ${((now - started) / 3_600_000).toFixed(1)}h`, source: 'driver.startedAt', prov: REPORTED, label: 'uptime' }),
    fact(beat, { text: beat == null ? DASH : `beat ${durMs(now - beat)} ago`, source: 'driver.heartbeat', prov: REPORTED, at: beat, budgetMs: 30_000, now, label: 'driver heartbeat' }),
    fact(pushed, { text: pushed == null ? DASH : `pushed ${durMs(now - pushed)} ago`, source: 'the SSE state frame', prov: OBSERVED, at: pushed, budgetMs: 12_000, now, label: 'last push' }),
  ];
  if (opts.notify) items.push(reported(opts.notify, { text: `notify ${opts.notify}`, source: 'Notification.permission', label: 'night bell' }));
  return items;
}

/* ================================================================== ledger series ==== */

/**
 * The six small multiples of the LEDGER WALL, each with its own n and exclusion line, because
 * a bare curve over an unstated denominator is the quiet half of a lie.
 *
 * `state.ledger.series` is the whole ledger, oldest first, already aligned across fields — it
 * is used where present. The `state.ticks` fallback draws the same six curves over the newest
 * forty rows and says `40 runs` rather than `83`, which is the difference between a smaller
 * picture and a wrong one.
 */
export function ledgerSeries(state) {
  const s = state || {};
  const led = s.ledger || null;
  const served = led && led.series && Array.isArray(led.series.cost) ? led.series : null;
  const rows = ledgerRows(s).slice().reverse();          // page fallback: oldest first
  const n = served ? served.cost.length : rows.length;
  const scope = served ? 'ledger' : 'the newest rows on this page';

  const seriesOf = (values, label, what) => {
    const list = Array.isArray(values) ? values : [];
    const have = list.filter(isNum).length;
    return {
      label,
      values: list,
      n: list.length,
      have,
      served: Boolean(served),
      complete: have === list.length && list.length > 0,
      exclusion: list.length === 0
        ? `no ${plural(2, 'run', 'runs')} to draw`
        : have === list.length
          ? `all ${count(list.length)} ${plural(list.length, 'run', 'runs')} in ${scope} ${what}`
          : `${count(have)} of ${count(list.length)} ${plural(list.length, 'run', 'runs')} ${what}`,
      median: median(list),
    };
  };

  const tally = (values) => {
    const map = new Map();
    for (const v of values) {
      const key = isText(v) ? v : 'unreported';
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  };

  const exits = served
    ? (Array.isArray(led.exits) && led.exits.length
      ? new Map(led.exits.map((e) => [e.exit, e.n]))
      : tally(served.exit))
    : tally(rows.map((r) => r.exit));
  const accountsMix = served
    ? (Array.isArray(led.accounts) && led.accounts.length
      ? new Map(led.accounts.map((a) => [a.account, a.n]))
      : tally(served.account))
    : tally(rows.map((r) => r.account));
  const namedAccounts = served
    ? (served.account || []).filter(isText).length
    : rows.filter((r) => r.account != null).length;

  return {
    served: Boolean(served),
    rows,
    at: served ? served.at : rows.map((r) => (r.startedAt == null ? null : new Date(r.startedAt).toISOString())),
    cost: seriesOf(served ? served.cost : rows.map((r) => r.cost), 'cost per run', 'carry a cost'),
    minutes: seriesOf(served ? served.minutes : rows.map((r) => r.minutes), 'minutes per run', 'carry a duration'),
    closed: seriesOf(served ? served.closed : rows.map((r) => r.closed), 'tasks closed per run', 'report tasks closed'),
    verifyFailed: seriesOf(served ? served.verifyFailed : rows.map((r) => r.note.verifyFailed), 'verifications failed per run', 'report a verification count'),
    // No server field for tool calls: it lives only inside the note string this page parses.
    tools: seriesOf(rows.map((r) => r.note.tools), 'tool calls per run', 'report a tool count in their note'),
    exitMix: {
      label: 'exit class mix',
      buckets: [...exits.entries()].map(([key, value]) => ({ key, label: sentence(key), value, tone: exitClass(key) })),
      n,
      exclusion: `${count(n)} ${plural(n, 'run', 'runs')} classified by exit`,
    },
    accountMix: {
      label: 'account mix',
      buckets: [...accountsMix.entries()].map(([key, value]) => ({ key, label: key, value })),
      n,
      exclusion: `${count(namedAccounts)} of ${count(n)} ${plural(n, 'run', 'runs')} name an account`,
    },
  };
}
