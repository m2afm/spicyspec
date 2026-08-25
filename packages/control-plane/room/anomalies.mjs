/**
 * anomalies.mjs — Z2, the only card stack on the deck that is allowed to be empty.
 *
 * There is no "all clear" box here and there never will be. A green box that is green every
 * time you look is a chip that is always on, and this founder has already been burned by one.
 * When nothing is wrong this returns `[]` and Z2 collapses to zero height.
 *
 * WHAT THIS MODULE IS FOR. The server detects everything derivable from RECORDS — it holds
 * all 83 ledger rows, every gate ruling and the supervisor's log, and ships the result as
 * `state.anomalies`. Those are used verbatim; recomputing them here off the newest forty rows
 * would produce a second, worse answer to the same question, and two alarm stacks that
 * disagree is exactly the confusion this deck exists to remove.
 *
 * What the server cannot ever know is what THIS PAGE witnessed: whether tool calls are landing
 * between pushes, whether the event stream is still delivering, whether the journal watched a
 * transition or read it back afterwards. Those detectors live here, and this is the one place
 * the two evidence sources are merged into a single ranked list.
 *
 * Card grammar, without exception: NUMBER, COMPARISON, REASON. A card that cannot fill all
 * three is not raised — "something looks off" is noise, and noise is how a founder learns to
 * stop reading the panel.
 */

import { count, isNum, isText, money, oneLine, pct, plural } from './format.mjs';
import { median } from './charts.mjs';
import { EXIT_BAD, exitClass, ledgerRows } from './metrics.mjs';

/** The server's vocabulary, adopted rather than translated. Lower rank sorts first. */
export const ALARM = 'alarm';
export const CAUTION = 'caution';

/** Client detectors interleave with the server's ranks (supervisor is 0, the pool is ~30). */
const RANK = { stall: 1, feed: 2, blind: 40, drift: 45 };

const card = (o) => ({ level: CAUTION, desk: 'HEALTH', witnessed: true, ...o });

/**
 * The merged stack. `state.anomalies` first-class, this page's own findings woven in by rank.
 * `opts.max` trims for display; the full list is always on `.all` so the "+2 more" line counts
 * honestly rather than counting only what fitted.
 */
export function anomalies(state, opts = {}) {
  const now = isNum(opts.now) ? opts.now : Date.now();
  const s = state || {};
  const served = Array.isArray(s.anomalies) ? s.anomalies : null;

  const out = [];

  /* ---------------------------------------------------------- the server's own ---- */
  for (const a of served || []) {
    if (!a || !isText(a.headline)) continue;
    out.push(card({
      key: a.id || `${a.kind}:${a.at}`,
      sig: `${a.id}:${a.at ?? ''}`,
      level: a.level === ALARM ? ALARM : CAUTION,
      rank: isNum(a.rank) ? a.rank : 100,
      kind: a.kind || 'server',
      desk: deskFor(a.kind),
      headline: a.headline,
      detail: isText(a.evidence) ? a.evidence : null,
      source: isText(a.source) ? a.source : 'the server',
      at: a.at ?? null,
      // Read off records the server holds. True, and not the same as watched.
      witnessed: false,
    }));
  }

  /* ------------------------------------------ what only this page could have seen ---- */

  // The tool counter has not moved while the room says WORKING. No record anywhere shows
  // this: the ledger only learns a run was barren once it has ended, which can be an hour.
  const cad = opts.cadence || null;
  if (cad && cad.verdict === 'stalled' && s.activity && s.activity.state === 'WORKING') {
    const tools = s.live && isNum(s.live.tools) ? s.live.tools : null;
    const frames = cad.bars.filter((b) => b.known).length;
    out.push(card({
      key: 'stall',
      sig: `stall:${tools}:${Math.round((cad.lastMovementMs || 0) / 60_000)}`,
      level: ALARM,
      rank: RANK.stall,
      kind: 'cadence',
      headline: cad.stallText || `the tool counter has not moved in ${Math.round((cad.lastMovementMs || 0) / 60_000)}m`,
      detail: `The room reports WORKING${tools == null ? '' : ` and the lane still shows ${count(tools)} tool calls`} — unchanged across ${count(frames)} state ${plural(frames, 'push', 'pushes')} this page watched itself. Nothing else on this deck can tell you that.`,
      source: 'state.live.tools differenced across SSE frames',
    }));
  }

  // The feed. If this is silent, EVERY other card on the page — including the server's — is
  // as old as the silence, which is why it outranks all of them but the stall.
  const feedAge = isNum(opts.feedAgeMs) ? opts.feedAgeMs : null;
  if (feedAge != null && feedAge > 90_000) {
    const push = s.server && isNum(s.server.pushIntervalMs) ? s.server.pushIntervalMs : 4000;
    out.push(card({
      key: 'feed',
      sig: `feed:${Math.round(feedAge / 30_000)}`,
      level: ALARM,
      rank: RANK.feed,
      kind: 'feed',
      headline: `no state has reached this page for ${Math.round(feedAge / 1000)}s`,
      detail: `The push interval is ${Math.round(push / 1000)}s, so ${Math.floor(feedAge / push)} pushes have been missed. Everything on this deck is at least ${Math.round(feedAge / 1000)}s old, whatever it looks like.`,
      source: 'the SSE connection on this page',
    }));
  }

  // A night nobody watched, being read as if it were watched. Raised only when the founder is
  // looking at a window whose coverage is poor AND something happened inside it.
  const cov = opts.coverage || null;
  if (cov && isNum(cov.fraction) && cov.fraction < 0.5 && cov.gaps && cov.gaps.length) {
    out.push(card({
      key: 'blind',
      sig: `blind:${cov.percent}:${cov.gaps.length}`,
      level: CAUTION,
      rank: RANK.blind,
      kind: 'coverage',
      headline: `this page watched ${cov.percent}% of the last ${Math.round((cov.to - cov.from) / 3_600_000)}h`,
      detail: `${cov.gaps.length} ${plural(cov.gaps.length, 'span', 'spans')} went unobserved${cov.gapText ? ` (${cov.gapText})` : ''}. Everything about them is read back from the ledger, not witnessed — and rows with no start stamp are in neither.`,
      source: 'the journal’s own watch marks',
    }));
  }

  /* -------------------------------- the fallback, for a server too old to detect ---- */
  if (served == null) out.push(...clientFallback(s, now));

  const all = out.sort((a, b) => (a.rank - b.rank) || (a.level === b.level ? 0 : a.level === ALARM ? -1 : 1));
  const max = isNum(opts.max) ? opts.max : 3;
  return Object.assign(all.slice(0, max), {
    all,
    hidden: Math.max(0, all.length - max),
    alarms: all.filter((a) => a.level === ALARM).length,
    // The 4th line, phrased so it points somewhere rather than only counting.
    moreText: all.length > max ? `+${all.length - max} more → open the wire` : null,
  });
}

const DESK_FOR = {
  supervisor: 'HEALTH', health: 'HEALTH', activity: 'HEALTH',
  cost: 'LEDGER', run: 'LEDGER', exit: 'LEDGER', ledger: 'LEDGER', progress: 'LEDGER',
  account: 'BUREAU', pool: 'BUREAU', rate: 'BUREAU',
  gate: 'RULINGS', ruling: 'RULINGS',
  parked: 'DESK', owed: 'DESK',
};
const deskFor = (kind) => DESK_FOR[String(kind)] || 'HEALTH';

/**
 * Record-derived detection, for the case where `state.anomalies` is absent. Deliberately a
 * subset of what the server does, computed over the forty rows this page holds — and every
 * card says so, because a median over forty rows presented as the median is a smaller lie of
 * the same family.
 */
export function clientFallback(state, now = Date.now()) {
  const s = state || {};
  const out = [];
  const rows = ledgerRows(s);
  const priced = rows.filter((r) => r.cost != null);
  const costMedian = median(priced.map((r) => r.cost));
  const scope = `the newest ${count(rows.length)} ${plural(rows.length, 'row', 'rows')} on this page`;

  const sup = s.health && s.health.supervisor;
  if (sup && sup.reporting === false) {
    const lastAt = sup.lastAt ? Date.parse(sup.lastAt) : NaN;
    const silence = Number.isFinite(lastAt) ? now - lastAt : null;
    out.push(card({
      key: 'supervisor', sig: `supervisor:${sup.lastAt || 'never'}`, level: ALARM, rank: 0, kind: 'supervisor', witnessed: false,
      headline: silence == null ? 'the supervisor has never reported' : `the supervisor has been silent for ${Math.round(silence / 60_000)}m`,
      detail: `Its own grace is ${Math.round((isNum(sup.staleAfterMs) ? sup.staleAfterMs : 180_000) / 60_000)}m${isText(sup.advice) ? `. ${sup.advice}` : '.'} Every health row below is as old as that silence.`,
      source: 'health.supervisor.reporting',
    }));
  }

  for (const row of Array.isArray(s.health && s.health.rows) ? s.health.rows : []) {
    if (!row || (row.status !== 'failed' && row.status !== 'blocked')) continue;
    out.push(card({
      key: `check:${row.check}`, sig: `check:${row.check}:${row.status}:${row.checkedAt || ''}`,
      level: row.status === 'failed' ? ALARM : CAUTION, rank: 10, kind: 'health', witnessed: false,
      headline: `${row.label || row.check} is ${row.status}`,
      detail: `${isText(row.detail) ? row.detail : 'the supervisor reported no detail'}${isText(row.lastRepairDetail) ? ` — last repair: ${row.lastRepairDetail}` : ''}.`,
      source: `health.rows[${row.check}]`,
    }));
  }

  const accounts = Array.isArray(s.accounts) ? s.accounts : [];
  const cold = accounts.filter((a) => a && a.cold);
  const refused = accounts.filter((a) => a && a.refused);
  if (accounts.length && cold.length === accounts.length) {
    out.push(card({
      key: 'all-cold', sig: `all-cold:${accounts.length}`, level: ALARM, rank: 20, kind: 'pool', desk: 'BUREAU', witnessed: false,
      headline: `all ${count(accounts.length)} accounts are cold`,
      detail: `Nothing can be dispatched until one warms${cold.some((a) => isNum(a.coldMinutes) && a.coldMinutes > 0) ? ` — the shortest wait reported is ${Math.min(...cold.filter((a) => isNum(a.coldMinutes)).map((a) => a.coldMinutes))}m` : ' and no account reports a wait'}.`,
      source: 'accounts[].cold',
    }));
  } else if (refused.length) {
    out.push(card({
      key: 'refused', sig: `refused:${refused.map((a) => a.id).join('|')}`, level: CAUTION, rank: 30, kind: 'account', desk: 'BUREAU', witnessed: false,
      headline: `${count(refused.length)} of ${count(accounts.length)} accounts refused work`,
      detail: refused.map((a) => `${a.id}: ${isText(a.refusedReason) ? a.refusedReason : 'no reason reported'}`).join(' · '),
      source: 'accounts[].refused',
    }));
  }

  for (const a of accounts) {
    if (!a || !isNum(a.utilization) || a.utilization < 0.85 || a.cold) continue;
    const endsAt = isNum(a.windowEndsAt) ? (a.windowEndsAt > 1e12 ? a.windowEndsAt : a.windowEndsAt * 1000) : null;
    const left = endsAt == null ? null : Math.max(0, endsAt - now);
    out.push(card({
      key: `util:${a.id}`, sig: `util:${a.id}:${Math.round(a.utilization * 20)}`, level: CAUTION, rank: 35, kind: 'rate', desk: 'BUREAU', witnessed: false,
      headline: `${a.id} is ${pct(a.utilization)} through its rate window`,
      detail: left == null
        ? 'The window has no reported end, so how long that has to last is unknown.'
        : `${Math.round(left / 60_000)}m of the window remain. At this pace the account runs out before it resets.`,
      source: `accounts.${a.id}.utilization`,
    }));
  }

  if (costMedian != null && costMedian > 0) {
    for (const r of priced.slice(0, 12)) {
      const ratio = r.cost / costMedian;
      if (ratio < 2) continue;
      const bought = r.closed != null ? `${count(r.closed)} ${plural(r.closed, 'task', 'tasks')} closed` : 'no task count reported';
      out.push(card({
        key: `cost:${r.key}`, sig: `cost:${r.key}`, level: CAUTION, rank: ratio >= 3 ? 50 : 60, kind: 'cost', desk: 'LEDGER', witnessed: false, at: r.startedAt,
        headline: `${r.spec ? `Spec ${r.spec} ` : ''}run ${r.tick != null ? r.tick : `#${r.index + 1}`} cost ${money(r.cost)}`,
        detail: `${ratio.toFixed(1)}× the ${money(costMedian)} median across ${count(priced.length)} priced ${plural(priced.length, 'run', 'runs')} in ${scope}${r.note.tools != null ? `, and made ${count(r.note.tools)} tool calls for ${bought}` : `, and bought ${bought}`}.`,
        source: 'ticks[].cost',
      }));
    }
  }

  const streak = [];
  for (const r of rows) {
    if (exitClass(r.exit) === 'bad') streak.push(r);
    else break;
  }
  if (streak.length >= 2) {
    out.push(card({
      key: 'bad-streak', sig: `bad-streak:${streak.length}:${streak[0].key}`, level: ALARM, rank: 15, kind: 'exit', desk: 'LEDGER', witnessed: false,
      headline: `the last ${count(streak.length)} runs all ended badly`,
      detail: `${streak.map((r) => r.exit).join(', ')} — ${count(streak.filter((r) => isNum(r.closed)).reduce((a, r) => a + r.closed, 0))} tasks closed between them, for ${money(streak.reduce((a, r) => a + (r.cost || 0), 0))}.`,
      source: 'ticks[].exit',
    }));
  }

  const redCounts = new Map();
  for (const r of rows) for (const p of r.redFirst) redCounts.set(p, (redCounts.get(p) || 0) + 1);
  for (const [path, n] of redCounts) {
    if (n < 2) continue;
    out.push(card({
      key: `red:${path}`, sig: `red:${path}:${n}`, level: CAUTION, rank: 55, kind: 'run', desk: 'LEDGER', witnessed: false,
      headline: `${oneLine(path, 52)} went red first in ${count(n)} runs`,
      detail: `The same file has been the first failure ${count(n)} times across ${scope}. A loop that keeps rediscovering one break is not converging on it.`,
      source: 'ticks[].redFirst',
    }));
  }

  for (const r of rows.slice(0, 8)) {
    if (r.closed !== 0 || r.note.tools == null || r.note.tools < 100) continue;
    out.push(card({
      key: `barren:${r.key}`, sig: `barren:${r.key}`, level: CAUTION, rank: 70, kind: 'run', desk: 'LEDGER', witnessed: false, at: r.startedAt,
      headline: `${count(r.note.tools)} tool calls closed no tasks`,
      detail: `${r.spec ? `Spec ${r.spec}, ` : ''}exit ${r.exit || 'unreported'}${r.cost != null ? `, ${money(r.cost)}` : ''}${r.note.verifyFailed ? `, ${count(r.note.verifyFailed)} verifications failed` : ''}. Movement is not progress.`,
      source: 'ticks[].note',
    }));
  }

  for (const e of Array.isArray(s.catalog && s.catalog.entries) ? s.catalog.entries : []) {
    if (!e || e.closingGateWarning !== true) continue;
    out.push(card({
      key: `gate:${e.id}`, sig: `gate:${e.id}`, level: CAUTION, rank: 25, kind: 'gate', desk: 'RULINGS', witnessed: false,
      headline: `Spec ${e.id} carries a closing-gate warning`,
      // `closingGate` is the gate's STATE word ('approved' / 'unknown' / …), not a note, and
      // the warning is raised for anything that is not 'approved' — including 'unknown',
      // which means the gate table could not be read at all. Those are different problems and
      // the card says which one this is.
      detail: `The closing gate reads ${isText(e.closingGate) ? `“${e.closingGate}”` : 'nothing at all'}, not “approved”${e.closingGate === 'unknown' ? ' — the gate table could not be read, so this is an absence of evidence rather than a refusal' : ''}. Its progress reads ${e.progress && isNum(e.progress.done) && isNum(e.progress.total) ? `${count(e.progress.done)}/${count(e.progress.total)}` : 'unknown'}.`,
      source: 'catalog.entries[].closingGateWarning',
    }));
  }

  return out;
}

export { EXIT_BAD };
