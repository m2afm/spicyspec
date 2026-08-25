/**
 * digest.mjs — C3. WHILE YOU SLEPT.
 *
 * The founder leaves this running overnight and wants, on waking, to know what happened. No
 * snapshot can answer that: a snapshot shows the loop at 07:00 and is silent about the eight
 * hours before it. So the digest reads the journal (what this page watched), the ledger (what
 * the server recorded), and the gap between them — and then, crucially, SAYS WHICH IS WHICH.
 *
 * The footer is the most important part of the whole card. '03:04–04:52 unobserved · 4 ticks
 * reconstructed from the ledger · 23 of 82 ledger rows carry no start stamp' is the sentence
 * that stops the founder trusting a summary of a night nobody was in the room for.
 *
 * Pure. Composes strings and structures; app.html renders them and wires each line to its
 * wire row.
 */

import { DASH, clockHM, count, isNum, isText, money, ms, oneLine, plural, sentence } from './format.mjs';
import { EXIT_BAD, exitClass, ledgerRows } from './metrics.mjs';
import { coverage as coverageOf, range as journalRange, seedExclusions } from './journal.mjs';

/** Below this, waking up is not an event and no handover card is raised. */
export const HANDOVER_MIN_AWAY_MS = 20 * 60_000;

/** Should the deck raise a handover at all? Pure, so the trigger is testable. */
export function shouldHandover(lastSeenAt, now = Date.now(), minMs = HANDOVER_MIN_AWAY_MS) {
  const seen = ms(lastSeenAt);
  if (seen == null) return false;
  return now - seen >= minMs;
}

/**
 * THE HANDOVER, as the deck actually raises it.
 *
 * `/api/digest` composes the RECORDED half over the full store — every run in the window, the
 * rulings whole, the commits, and the exclusion line for rows that carry no start stamp. This
 * function takes that payload and adds the one thing no server can ever supply: whether this
 * page was in the room while it happened.
 *
 * That is the whole division of labour. The server can say what was recorded. Only the journal
 * can say '03:04–04:52 unobserved', and without that line a summary of an unwatched night
 * reads exactly like a summary of a watched one — which is the failure this founder has been
 * burned by more than any other.
 */
export function handover(serverDigest, opts = {}) {
  const d = serverDigest || null;
  const now = isNum(opts.now) ? opts.now : Date.now();
  const journal = Array.isArray(opts.journal) ? opts.journal : [];
  const from = ms(d && d.window && d.window.since) ?? (isNum(opts.from) ? opts.from : now - 8 * 3_600_000);
  const to = ms(d && d.window && d.window.until) ?? (isNum(opts.to) ? opts.to : now);

  const cov = opts.coverage || coverageOf(journal, { from, to, now });
  const inWindow = journalRange(journal, from, to);
  const reconstructedCount = inWindow.filter((e) => e.reconstructed).length;

  if (!d) {
    // No server digest to merge — fall back to composing from the state frame and say so.
    return { ...digestDiff(opts.before ?? null, opts.after ?? null, { ...opts, from, to, coverage: cov, journal }), served: false };
  }

  const num = d.numbers || {};
  const numbers = [
    metric('runs', num.runs, `${count(num.runs)} ${plural(num.runs, 'run', 'runs')}`, 'ledger rows stamped inside the window'),
    metric('closed', num.tasksClosed, `${count(num.tasksClosed)} ${plural(num.tasksClosed, 'task', 'tasks')} closed`, 'ledger tasksClosed'),
    metric('spend', num.costUsd, money(num.costUsd), num.priced && isText(num.priced.line) ? num.priced.line : 'ledger costUsd'),
    metric('commits', num.commits, `${count(num.commits)} ${plural(num.commits, 'commit', 'commits')}`, 'git log over the window'),
  ];

  const ruled = (Array.isArray(d.ruled) ? d.ruled : []).map((g, i) => ({
    key: `gate:${g.source || 'gates'}:${g.line != null ? g.line : i}`,
    at: ms(g.at),
    time: clockHM(ms(g.at)),
    verdict: isText(g.verdict) ? g.verdict.toUpperCase() : null,
    seat: isText(g.seat) ? g.seat : null,
    confidence: isNum(g.confidence) ? g.confidence : null,
    target: [isText(g.spec) ? `Spec ${g.spec}` : null, isText(g.gate) ? g.gate : null].filter(Boolean).join(' · ') || null,
    // The pull-quote whole, not a paraphrase: a ruling summarised is a ruling not read.
    quote: isText(g.note) ? g.note : null,
    quoteChars: isNum(g.noteChars) ? g.noteChars : (isText(g.note) ? g.note.length : 0),
    provenance: [isText(g.source) ? g.source : 'gates', isText(g.frozen) ? `frozen ${g.frozen.slice(0, 7)}` : null].filter(Boolean).join(' · '),
    wireKey: `gate:${g.source || 'gates'}:${g.line != null ? g.line : i}:${ms(g.at) ?? 'undated'}`,
  })).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  const brokeRows = [
    ...(Array.isArray(d.broke && d.broke.exits) ? d.broke.exits : []).map((r, i) => ({
      key: `exit:${r.startedAt || i}`,
      at: ms(r.startedAt),
      time: clockHM(ms(r.startedAt)),
      headline: `${r.spec ? `Spec ${r.spec} ` : ''}run ${r.tick ?? `#${i + 1}`} ended ${r.exit || 'without a reported class'}`,
      detail: [isNum(r.costUsd) ? money(r.costUsd) : null, isNum(r.tasksClosed) ? `${count(r.tasksClosed)} closed` : null].filter(Boolean).join(' · ') || null,
      wireKey: null,
    })),
    ...(Array.isArray(d.broke && d.broke.health) ? d.broke.health : []).map((e) => ({
      key: `health:${e.at}:${e.check}`,
      at: ms(e.at),
      time: clockHM(ms(e.at)),
      headline: `${sentence(e.check || 'check')} ${e.status}`,
      detail: isText(e.detail) ? e.detail : null,
      wireKey: `health:${e.at}:${e.check}:${e.status}`,
    })),
    ...(Array.isArray(d.broke && d.broke.accounts) ? d.broke.accounts : []).map((e, i) => ({
      key: `acct:${e.at || i}`,
      at: ms(e.at),
      time: clockHM(ms(e.at)),
      headline: isText(e.text) ? sentence(e.text) : `${e.account || 'an account'} ${e.kind || 'changed'}`,
      detail: null,
      wireKey: null,
    })),
  ].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  const nu = d.needsYou || {};
  const needsYou = [
    ...(Array.isArray(nu.parked) ? nu.parked : []).map((p) => ({ key: `parked:${p}`, kind: 'parked', headline: oneLine(p, 110), detail: null, wireKey: null })),
    ...(Array.isArray(nu.awaitingFounder) ? nu.awaitingFounder : []).map((id) => ({ key: `await:${id}`, kind: 'awaiting', headline: `Spec ${id} is waiting on your sign-off`, detail: null, wireKey: null })),
    ...(Array.isArray(nu.closingGateWarnings) ? nu.closingGateWarnings : []).map((id) => ({ key: `gate:${id}`, kind: 'gate', headline: `Spec ${id} raised a closing-gate warning`, detail: null, wireKey: null })),
    ...(isNum(nu.owed) && nu.owed > 0 ? [{ key: 'owed', kind: 'owed', headline: `${count(nu.owed)} ${plural(nu.owed, 'thing', 'things')} waiting on you`, detail: null, wireKey: null }] : []),
  ];

  const coverageLines = [
    cov.gaps.length === 0 ? 'the whole window was watched' : `${cov.gaps.map((g) => `${clockHM(g.from)}–${clockHM(g.to)}`).join(' · ')} unobserved`,
    reconstructedCount > 0 ? `${count(reconstructedCount)} ${plural(reconstructedCount, 'entry', 'entries')} reconstructed from the ledger` : null,
    d.coverage && isText(d.coverage.excludedLine) ? d.coverage.excludedLine : null,
  ].filter(Boolean);

  const awayMs = Math.max(0, to - from);
  const headline = brokeRows.length
    ? `${count(brokeRows.length)} ${plural(brokeRows.length, 'thing', 'things')} broke`
    : needsYou.length
      ? `${count(needsYou.length)} ${plural(needsYou.length, 'thing', 'things')} need you`
      : isNum(num.runs) && num.runs > 0
        ? `${count(num.runs)} ${plural(num.runs, 'run', 'runs')}, nothing broke`
        : 'nothing ran';

  return {
    served: true,
    from,
    to,
    awayMs,
    lede: [
      `${sentence(spanWords(awayMs))} away.`,
      cov.watchedMs > 0
        ? `The room watched ${spanWords(cov.watchedMs)} of it.`
        : 'The room watched none of it — everything below is read back from the ledger.',
    ].join(' '),
    headline,
    numbers,
    ruled,
    broke: brokeRows,
    needsYou,
    commits: Array.isArray(d.commits) ? d.commits : [],
    coverage: cov,
    coverageLines,
    coverageText: coverageLines.join(' · '),
    empty: (num.runs || 0) === 0 && ruled.length === 0 && brokeRows.length === 0 && needsYou.length === 0,
    sections: [
      { key: 'numbers', label: 'THE NUMBERS', items: numbers },
      { key: 'ruled', label: 'WHAT RULED', items: ruled },
      { key: 'broke', label: 'WHAT BROKE', items: brokeRows },
      { key: 'needs', label: 'WHAT NEEDS YOU', items: needsYou },
    ].filter((sec) => sec.items.length > 0),
  };
}

/**
 * The whole card. `before` may be null — the page was closed, there is no earlier snapshot,
 * and everything is then derived from the ledger and the journal, marked reconstructed.
 */
export function digestDiff(before, after, opts = {}) {
  const now = isNum(opts.now) ? opts.now : Date.now();
  const from = isNum(opts.from) ? opts.from : (ms(opts.lastSeenAt) ?? now - 8 * 3_600_000);
  const to = isNum(opts.to) ? opts.to : now;
  const journal = Array.isArray(opts.journal) ? opts.journal : [];
  const s = after || {};

  const cov = opts.coverage || coverageOf(journal, { from, to, now });
  const inWindow = journalRange(journal, from, to);

  /* -------------------------------------------------------------------- numbers -- */
  const rows = ledgerRows(s).filter((r) => r.startedAt != null && r.startedAt >= from && r.startedAt <= to);
  const priced = rows.filter((r) => r.cost != null);
  const closed = rows.filter((r) => r.closed != null).reduce((a, r) => a + r.closed, 0);
  const spend = priced.reduce((a, r) => a + r.cost, 0);
  const commits = inWindow.filter((e) => e.kind === 'git.head');

  const numbers = [
    metric('runs', rows.length, `${count(rows.length)} ${plural(rows.length, 'run', 'runs')}`, 'ticks[] with a start stamp inside the window'),
    metric('closed', rows.some((r) => r.closed != null) ? closed : null, `${count(closed)} ${plural(closed, 'task', 'tasks')} closed`, 'ticks[].closed'),
    metric('spend', priced.length ? spend : null, money(spend), 'ticks[].cost'),
    metric('commits', commits.length, `${count(commits.length)} ${plural(commits.length, 'commit', 'commits')}`, 'journal git.head transitions'),
  ];

  /* --------------------------------------------------------------- what ruled ---- */
  const gates = (Array.isArray(s.gates) ? s.gates : (s.gates && Array.isArray(s.gates.rows) ? s.gates.rows : []))
    .map((g) => ({ ...g, atMs: ms(g && (g.at || g.decidedAt || g.ts)) }))
    .filter((g) => g.atMs != null && g.atMs >= from && g.atMs <= to)
    .sort((a, b) => b.atMs - a.atMs)
    .map((g) => ({
      key: `gate:${g.id || g.atMs}`,
      at: g.atMs,
      time: clockHM(g.atMs),
      verdict: isText(g.verdict) ? g.verdict.toUpperCase() : null,
      seat: isText(g.seat) ? g.seat : isText(g.role) ? g.role : null,
      confidence: isNum(g.confidence) ? g.confidence : null,
      target: [isText(g.spec) ? `Spec ${g.spec}` : null, isText(g.gate) ? g.gate : null].filter(Boolean).join(' · ') || null,
      // The pull-quote, not a summary of it: a ruling paraphrased is a ruling not read.
      quote: isText(g.note) ? g.note : isText(g.rationale) ? g.rationale : null,
      wireKey: `gate:${g.id || g.atMs}`,
    }));

  /* --------------------------------------------------------------- what broke ---- */
  const badRuns = rows.filter((r) => EXIT_BAD.has(String(r.exit))).map((r) => ({
    key: `tick:${r.key}`,
    at: r.startedAt,
    time: clockHM(r.startedAt),
    headline: `${r.spec ? `Spec ${r.spec} ` : ''}run ${r.tick ?? `#${r.index + 1}`} ended ${r.exit}`,
    detail: [
      r.cost == null ? null : money(r.cost),
      r.note.tools == null ? null : `${count(r.note.tools)} tool calls`,
      r.closed == null ? null : `${count(r.closed)} closed`,
      r.redFirst.length ? `first red ${oneLine(r.redFirst[0], 40)}` : null,
    ].filter(Boolean).join(' · ') || null,
    wireKey: `tick:${r.key}`,
  }));

  const healthBreaks = (Array.isArray(s.health && s.health.events) ? s.health.events : [])
    .map((e) => ({ ...e, atMs: ms(e && e.at) }))
    .filter((e) => e.atMs != null && e.atMs >= from && e.atMs <= to && (e.status === 'failed' || e.status === 'blocked'))
    .map((e) => ({
      key: `health:${e.atMs}:${e.check}`,
      at: e.atMs,
      time: clockHM(e.atMs),
      headline: `${sentence(e.check || 'check')} ${e.status}`,
      detail: isText(e.detail) ? e.detail : null,
      wireKey: `health:${e.at}:${e.check}:${e.status}`,
    }));

  const supervisorLost = inWindow.filter((e) => e.kind === 'supervisor.reporting' && e.to === false).map((e) => ({
    key: `sup:${e.at}`,
    at: e.at,
    time: clockHM(e.at),
    headline: 'The supervisor stopped reporting',
    detail: isText(e.advice) ? e.advice : null,
    wireKey: `j:${e.id}`,
  }));

  const broke = [...badRuns, ...healthBreaks, ...supervisorLost].sort((a, b) => b.at - a.at);

  /* ------------------------------------------------------------ what needs you ---- */
  const parkedBefore = new Set(Array.isArray(before && before.parked) ? before.parked : []);
  const parkedNow = Array.isArray(s.parked) ? s.parked : [];
  const newParked = before
    ? parkedNow.filter((p) => !parkedBefore.has(p))
    // Without an earlier snapshot the journal is the only witness of what is NEW; anything it
    // did not see is reported as standing, not as new. Inventing "new" is how a digest starts
    // waking someone for a thing that has been sitting there for three days.
    : inWindow.filter((e) => e.kind === 'parked.add').map((e) => e.value).filter(isText);

  const awaitingBefore = new Set(Array.isArray(before && before.catalog && before.catalog.awaitingFounder) ? before.catalog.awaitingFounder : []);
  const awaitingNow = Array.isArray(s.catalog && s.catalog.awaitingFounder) ? s.catalog.awaitingFounder : [];
  const newAwaiting = before ? awaitingNow.filter((id) => !awaitingBefore.has(id)) : [];

  const gateWarnings = inWindow.filter((e) => e.kind === 'gate.warning');

  const needsYou = [
    ...newParked.map((p) => ({ key: `parked:${p}`, kind: 'parked', headline: oneLine(p, 110), detail: null, wireKey: null })),
    ...newAwaiting.map((id) => ({ key: `await:${id}`, kind: 'awaiting', headline: `Spec ${id} is waiting on your sign-off`, detail: null, wireKey: null })),
    ...gateWarnings.map((e) => ({ key: `gate:${e.id}`, kind: 'gate', headline: `Spec ${e.id} raised a closing-gate warning`, detail: isText(e.value) ? e.value : null, wireKey: `j:${e.id}` })),
    ...(isNum(opts.owedDelta) && opts.owedDelta > 0 ? [{ key: 'owed', kind: 'owed', headline: `${count(opts.owedDelta)} new ${plural(opts.owedDelta, 'item', 'items')} on your desk`, detail: null, wireKey: null }] : []),
  ];

  /* -------------------------------------------------------------------- coverage -- */
  const exclusions = seedExclusions(s);
  const reconstructedCount = inWindow.filter((e) => e.reconstructed).length;
  const coverageLines = [
    cov.gaps.length === 0
      ? `the whole window was watched`
      : `${cov.gaps.map((g) => `${clockHM(g.from)}–${clockHM(g.to)}`).join(' · ')} unobserved`,
    reconstructedCount > 0 ? `${count(reconstructedCount)} ${plural(reconstructedCount, 'entry', 'entries')} reconstructed from the ledger` : null,
    exclusions.text,
  ].filter(Boolean);

  /* ------------------------------------------------------------------------ lede -- */
  const awayMs = Math.max(0, to - from);
  const lede = [
    `${sentence(spanWords(awayMs))} away.`,
    cov.watchedMs > 0
      ? `The room watched ${spanWords(cov.watchedMs)} of it.`
      : 'The room watched none of it — everything below is read back from the ledger.',
  ].join(' ');

  /* --------------------------------------------------------------------- verdict -- */
  const headline = broke.length
    ? `${count(broke.length)} ${plural(broke.length, 'thing', 'things')} broke`
    : needsYou.length
      ? `${count(needsYou.length)} ${plural(needsYou.length, 'thing', 'things')} need you`
      : rows.length
        ? `${count(rows.length)} ${plural(rows.length, 'run', 'runs')}, nothing broke`
        : 'nothing ran';

  return {
    served: false,
    from,
    to,
    awayMs,
    lede,
    headline,
    numbers,
    ruled: gates,
    broke,
    needsYou,
    coverage: cov,
    coverageLines,
    coverageText: coverageLines.join(' · '),
    // The card is worth raising when it can say something. An empty digest is not raised —
    // waking someone to tell them nothing happened is a way of teaching them to dismiss it.
    empty: rows.length === 0 && gates.length === 0 && broke.length === 0 && needsYou.length === 0,
    sections: [
      { key: 'numbers', label: 'THE NUMBERS', items: numbers },
      { key: 'ruled', label: 'WHAT RULED', items: gates },
      { key: 'broke', label: 'WHAT BROKE', items: broke },
      { key: 'needs', label: 'WHAT NEEDS YOU', items: needsYou },
    ].filter((sec) => sec.items.length > 0),
  };
}

function metric(key, value, text, source) {
  const known = isNum(value);
  return { key, value: known ? value : null, text: known ? text : DASH, known, source, label: key };
}

/** 'Eight hours' — words, because a lede that opens '8h12m away' reads like a log line. */
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
export function spanWords(msSpan) {
  if (!isNum(msSpan) || msSpan < 0) return 'an unknown time';
  const mins = Math.round(msSpan / 60_000);
  if (mins < 60) return `${mins} ${plural(mins, 'minute', 'minutes')}`;
  const h = Math.round(msSpan / 3_600_000);
  const word = h <= 12 ? WORDS[h] : String(h);
  if (h < 24) return `${word} ${plural(h, 'hour', 'hours')}`;
  const d = Math.round(h / 24);
  return `${d <= 12 ? WORDS[d] : d} ${plural(d, 'day', 'days')}`;
}
