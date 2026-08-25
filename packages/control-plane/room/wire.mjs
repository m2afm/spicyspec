/**
 * wire.mjs — THE WIRE. One reverse-chronological river of everything that happened, merged
 * from six desks, each row carrying the exact source it came from.
 *
 * The observation that earned this pane: `.specify/board/GATES.jsonl` carries dozens of
 * rulings — seat, verdict, confidence, and notes hundreds of characters long — and the room
 * renders literally none of it. A ruling is the densest fact the loop produces and it was
 * invisible. The wire is where a 900-character ruling is actually read.
 *
 * The honesty rule specific to this pane: A ROW WITHOUT A TIMESTAMP IS NOT PLACED IN TIME.
 * `state.accountEvents` are bare strings with no stamp; sorting them into the river at "now"
 * would invent a chronology. They come back with `at: null` and the pane lists them apart,
 * under a heading that says so.
 *
 * Pure. `provenance` here is the SOURCE STRING a founder can go and read; the four-class
 * evidence grammar lives in fact.mjs and travels alongside it.
 */

import { clockHMS, count, isNum, isText, money, ms, oneLine, pct, plural, sentence, shortHead } from './format.mjs';
import { OBSERVED, RECONSTRUCTED, REPORTED, UNKNOWN } from './fact.mjs';
import { exitClass, ledgerRows } from './metrics.mjs';

/** The six desks. A row belongs to exactly one; the filter chips are unions of these. */
export const DESKS = ['RULINGS', 'LEDGER', 'BUREAU', 'HEALTH', 'TREE', 'DESK'];

/** The filter chips, as desk unions plus one predicate each. */
export const FILTERS = {
  ALL: { label: 'ALL', desks: null },
  RULINGS: { label: 'RULINGS', desks: ['RULINGS'] },
  MONEY: { label: 'MONEY', desks: ['LEDGER', 'BUREAU'] },
  BREAKS: { label: 'BREAKS', desks: ['HEALTH', 'LEDGER'], only: (r) => r.desk === 'HEALTH' || r.tone === 'bad' },
  MINE: { label: 'MINE', desks: ['DESK'] },
};

const row = (o) => ({ note: null, tone: null, at: null, ...o });

/**
 * Every row the deck can show, newest first, plus the undated ones kept apart.
 *
 * `state.gates` does not exist in today's payload — the GATES.jsonl ingest is server work.
 * This reads it if it is there and says nothing if it is not; it never fabricates a ruling.
 */
export function wireRows(state, opts = {}) {
  const s = state || {};
  const dated = [];
  const undated = [];

  /* ---- RULINGS: the densest rows on the wire ----
     `state.gates` is a GateDigest whose notes are PREVIEWED, because the frame is pushed every
     four seconds and a 900-character ruling would be most of it. `noteChars` always carries
     the full length, so a row can say how much it is holding back and the chevron can fetch
     the whole thing from /api/gates rather than pretending the preview is the ruling. */
  const gateDigest = s.gates && !Array.isArray(s.gates) ? s.gates : null;
  const gates = Array.isArray(s.gates) ? s.gates : (gateDigest && Array.isArray(gateDigest.rows) ? gateDigest.rows : []);
  const notePreview = gateDigest && isNum(gateDigest.notePreview) ? gateDigest.notePreview : null;
  gates.forEach((g, i) => {
    if (!g) return;
    const at = ms(g.at || g.decidedAt || g.ts);
    const verdict = isText(g.verdict) ? g.verdict.toUpperCase() : null;
    const seat = isText(g.seat) ? g.seat : isText(g.role) ? g.role : null;
    const conf = isNum(g.confidence) ? g.confidence : null;
    const note = isText(g.note) ? g.note : isText(g.rationale) ? g.rationale : null;
    const noteChars = isNum(g.noteChars) ? g.noteChars : (note ? note.length : 0);
    const truncated = note != null && noteChars > note.length;
    const target = [isText(g.spec) ? `Spec ${g.spec}` : null, isText(g.gate) ? g.gate : null, isText(g.stage) ? g.stage : null].filter(Boolean).join(' · ');
    const r = row({
      key: `gate:${g.source || 'gates'}:${g.line != null ? g.line : i}:${at ?? 'undated'}`,
      at,
      desk: 'RULINGS',
      headline: [verdict, target || 'ruling', seat ? `— ${seat}` : null].filter(Boolean).join(' '),
      note,
      noteChars,
      truncated,
      // The chevron's own label, so the founder is told what expanding will get them.
      noteMore: truncated ? `${count(noteChars - note.length)} more characters in the full ruling` : null,
      tone: verdict === 'REVISE' || verdict === 'BLOCK' ? 'bad' : verdict === 'APPROVE' ? 'good' : null,
      meta: [seat, conf == null ? null : `confidence ${conf.toFixed(2)}`].filter(Boolean).join(' · ') || null,
      // Exactly the sentence the spec asked for: `gates.jsonl · frozen ebe5e0c`.
      provenance: [
        isText(g.source) ? g.source : 'gates',
        isText(g.frozen) ? `frozen ${shortHead(g.frozen)}` : null,
        g.line != null ? `line ${g.line}` : null,
      ].filter(Boolean).join(' · '),
      evidence: RECONSTRUCTED,
      fetchFull: truncated ? { url: '/api/gates', preview: notePreview } : null,
    });
    (at == null ? undated : dated).push(r);
  });

  /* ---- LEDGER: one row per run, with what it cost and what it bought ---- */
  for (const t of ledgerRows(s)) {
    const cls = exitClass(t.exit);
    const bought = t.closed == null ? 'no task count reported' : `${count(t.closed)} ${plural(t.closed, 'task', 'tasks')} closed`;
    const r = row({
      key: `tick:${t.key}`,
      at: t.startedAt,
      desk: 'LEDGER',
      headline: `${t.spec ? `Spec ${t.spec} ` : ''}run ${t.tick != null ? t.tick : `#${t.index + 1}`} ended ${t.exit || 'without a reported class'}`,
      note: [
        t.note.raw,
        t.redFirst.length ? `first red: ${t.redFirst.join(', ')}` : null,
      ].filter(isText).join(' — ') || null,
      tone: cls === 'bad' ? 'bad' : cls === 'good' ? 'good' : cls === 'owed' ? 'owed' : null,
      meta: [
        t.cost == null ? null : money(t.cost),
        t.minutes == null ? null : `${count(t.minutes)}m`,
        bought,
        t.account,
        t.attempt,
      ].filter(Boolean).join(' · '),
      provenance: `ledger${t.head ? ` · ${shortHead(t.head)}` : ''}`,
      // A run this page never watched is reconstructed, always — the ledger is a record, not
      // a witness. The journal upgrades the ones we saw land, in `mergeObserved` below.
      evidence: t.startedAt == null ? UNKNOWN : RECONSTRUCTED,
    });
    (t.startedAt == null ? undated : dated).push(r);
  }

  /* ---- BUREAU: the account pool. The state frame carries these as bare strings with no
     stamp; /api/digest serves them as rows that DO carry one. Both shapes are accepted, and a
     row without a stamp is not placed in time — sorting it in at "now" would invent a
     chronology out of a string. ---- */
  const events = Array.isArray(s.accountEvents) ? s.accountEvents : [];
  events.forEach((e, i) => {
    const text = isText(e) ? e : (e && isText(e.text) ? e.text : null);
    if (!text) return;
    const at = e && !isText(e) ? ms(e.at) : null;
    const r = row({
      key: `acct:${i}:${text}`,
      at,
      desk: 'BUREAU',
      headline: sentence(text),
      tone: e && e.kind === 'refused' ? 'bad' : null,
      meta: e && !isText(e) ? [e.account, e.tick != null ? `run ${e.tick}` : null].filter(Boolean).join(' · ') || null : null,
      provenance: at == null
        ? 'accountEvents · no timestamp published'
        : `accountEvents${e && isText(e.source) ? ` · ${e.source}` : ''}`,
      evidence: at == null ? UNKNOWN : REPORTED,
    });
    (at == null ? undated : dated).push(r);
  });

  /* ---- HEALTH: the supervisor's own log ---- */
  for (const e of Array.isArray(s.health && s.health.events) ? s.health.events : []) {
    if (!e) continue;
    const at = ms(e.at);
    const r = row({
      key: `health:${e.at}:${e.check}:${e.status}`,
      at,
      desk: 'HEALTH',
      headline: `${sentence(e.check || 'check')} ${e.status || 'reported nothing'}`,
      note: isText(e.detail) ? e.detail : null,
      tone: e.status === 'failed' || e.status === 'blocked' ? 'bad' : e.status === 'repaired' ? 'good' : null,
      provenance: 'health:events',
      evidence: REPORTED,
      meta: null,
    });
    (at == null ? undated : dated).push(r);
  }

  /* ---- TREE and DESK: only the journal can supply these, because they are transitions ---- */
  for (const entry of Array.isArray(opts.journal) ? opts.journal : []) {
    if (!entry || !isNum(entry.at)) continue;
    const mapped = journalRow(entry);
    if (mapped) dated.push(mapped);
  }

  dated.sort((a, b) => b.at - a.at);

  const seen = ms(opts.lastSeenAt);
  const newCount = seen == null ? 0 : dated.filter((r) => r.at > seen).length;

  const withTime = dated.map((r) => ({ ...r, time: clockHMS(r.at) }));

  return Object.assign(withTime, {
    rows: withTime,
    undated,
    // The divider does not move while the tab is hidden — the caller freezes `lastSeenAt`,
    // and this only reports where the mark falls.
    newSince: seen == null ? null : { at: seen, count: newCount, label: `NEW SINCE ${clockHMS(seen)}` },
    // The pane's own coverage line, and the reason the undated group exists at all.
    undatedText: undated.length === 0
      ? null
      : `${count(undated.length)} ${plural(undated.length, 'row carries', 'rows carry')} no timestamp and ${plural(undated.length, 'is', 'are')} not placed in time`,
    deskCounts: DESKS.reduce((acc, d) => Object.assign(acc, { [d]: withTime.filter((r) => r.desk === d).length + undated.filter((r) => r.desk === d).length }), {}),
  });
}

/** One journal transition, as a wire row. These are the only OBSERVED rows on the wire. */
export function journalRow(entry) {
  const base = { key: `j:${entry.id || `${entry.at}:${entry.kind}`}`, at: entry.at, evidence: entry.reconstructed ? RECONSTRUCTED : OBSERVED, provenance: entry.reconstructed ? 'journal · reconstructed from the ledger' : 'journal · watched by this page' };
  switch (entry.kind) {
    case 'git.head':
      return row({ ...base, desk: 'TREE', headline: `Head moved to ${shortHead(entry.to)}`, note: isText(entry.subject) ? entry.subject : null, meta: isText(entry.branch) ? entry.branch : null });
    case 'parked.add':
      return row({ ...base, desk: 'DESK', tone: 'bad', headline: 'A new item was parked', note: isText(entry.value) ? entry.value : null, meta: null });
    case 'parked.remove':
      return row({ ...base, desk: 'DESK', tone: 'good', headline: 'A parked item cleared', note: isText(entry.value) ? entry.value : null, meta: null });
    case 'owed.delta':
      return row({ ...base, desk: 'DESK', headline: `Owed went ${entry.from} → ${entry.to}`, note: isText(entry.value) ? entry.value : null, meta: null });
    case 'activity.state':
      return row({ ...base, desk: 'HEALTH', tone: entry.to === 'WORKING' ? 'good' : 'bad', headline: `The loop went ${entry.from || 'unknown'} → ${entry.to}`, note: isText(entry.reason) ? entry.reason : null, meta: null });
    case 'account.switch':
      return row({ ...base, desk: 'BUREAU', headline: `Switched ${entry.from} → ${entry.to}`, meta: null });
    case 'account.cold':
      return row({ ...base, desk: 'BUREAU', tone: 'bad', headline: `${entry.id} went cold`, note: isText(entry.reason) ? entry.reason : null, meta: null });
    case 'health.row':
      return row({ ...base, desk: 'HEALTH', tone: entry.to === 'failed' || entry.to === 'blocked' ? 'bad' : 'good', headline: `${sentence(entry.check)} ${entry.from || 'unknown'} → ${entry.to}`, note: isText(entry.detail) ? entry.detail : null, meta: null });
    case 'supervisor.reporting':
      return row({ ...base, desk: 'HEALTH', tone: entry.to ? 'good' : 'bad', headline: entry.to ? 'The supervisor started reporting again' : 'The supervisor stopped reporting', meta: null });
    case 'feed':
      return row({ ...base, desk: 'HEALTH', tone: entry.to === 'up' ? 'good' : 'bad', headline: entry.to === 'up' ? 'The event feed reconnected' : 'The event feed went silent', meta: null });
    case 'notional':
      return row({ ...base, desk: 'LEDGER', headline: `Spend crossed ${money(entry.to)}`, meta: null });
    case 'tick.end':
      return row({ ...base, desk: 'LEDGER', tone: exitClass(entry.exit) === 'bad' ? 'bad' : null, headline: `A run ended ${entry.exit || 'without a reported class'}`, meta: entry.cost == null ? null : money(entry.cost) });
    case 'tick.start':
      return row({ ...base, desk: 'LEDGER', headline: `A run started${isText(entry.spec) ? ` on Spec ${entry.spec}` : ''}`, meta: isText(entry.account) ? entry.account : null });
    case 'gate.warning':
      // `value` is the gate's state word, not a note — 'unknown' means the table could not be
      // read, which is a different fact from a gate that refused.
      return row({ ...base, desk: 'RULINGS', tone: 'bad', headline: `Spec ${entry.id} raised a closing-gate warning`, note: isText(entry.value) ? `the gate reads “${entry.value}”, not “approved”` : null, meta: null });
    default:
      return null;
  }
}

/**
 * Apply a filter chip. Kept out of the row builder so the chips can change without the river
 * being rebuilt, and so `deskCounts` above always counts the whole river.
 */
export function filterWire(rows, name) {
  const f = FILTERS[name] || FILTERS.ALL;
  const list = Array.isArray(rows) ? rows : [];
  if (!f.desks) return list;
  return list.filter((r) => f.desks.includes(r.desk) && (typeof f.only !== 'function' || f.only(r)));
}

/**
 * Upgrade a river's evidence class where the journal proves the page watched it land. A LEDGER
 * row for a run that finished while the tab was open is `observed`; the identical row for a
 * run that finished overnight stays `reconstructed`. That distinction is the entire reason
 * the journal exists.
 */
export function mergeObserved(rows, journal, opts = {}) {
  const tolerance = isNum(opts.toleranceMs) ? opts.toleranceMs : 120_000;
  const marks = (Array.isArray(journal) ? journal : []).filter((e) => e && isNum(e.at) && !e.reconstructed);
  const list = Array.isArray(rows) ? rows : [];
  const mapped = list.map((r) => {
    if (r.evidence === OBSERVED || !isNum(r.at)) return r;
    const witnessed = marks.some((e) => Math.abs(e.at - r.at) <= tolerance && deskOf(e.kind) === r.desk);
    return witnessed ? { ...r, evidence: OBSERVED, provenance: `${r.provenance} · watched by this page` } : r;
  });
  // `wireRows` hangs the pane's own metadata off the array — the undated group, the NEW SINCE
  // mark, the desk counts. A bare `.map()` drops all of it, which is how the undated rows
  // silently vanished from the pane the first time this ran.
  return Object.assign(mapped, {
    rows: mapped,
    undated: list.undated || [],
    undatedText: list.undatedText ?? null,
    newSince: list.newSince ?? null,
    deskCounts: list.deskCounts || {},
  });
}

const KIND_DESK = {
  'git.head': 'TREE', 'parked.add': 'DESK', 'parked.remove': 'DESK', 'owed.delta': 'DESK',
  'activity.state': 'HEALTH', 'health.row': 'HEALTH', 'supervisor.reporting': 'HEALTH', feed: 'HEALTH',
  'account.switch': 'BUREAU', 'account.cold': 'BUREAU', 'account.utilization': 'BUREAU',
  'tick.start': 'LEDGER', 'tick.end': 'LEDGER', notional: 'LEDGER', 'gate.warning': 'RULINGS',
};
const deskOf = (kind) => KIND_DESK[kind] || null;
export { deskOf };
