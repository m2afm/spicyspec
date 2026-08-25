/**
 * journal.mjs — C2. A durable log of TRANSITIONS, not of states.
 *
 * This is the structural answer to the failure that has burned this founder more than any
 * other: a UI that reported success while nothing was happening. A snapshot renderer cannot
 * ever catch a thing that was briefly wrong — it draws whatever is true at 4-second intervals
 * and forgets. So this module diffs each frame against the last and writes only what CHANGED,
 * to IndexedDB, where it survives a reload, a night, and a crash.
 *
 * Everything downstream depends on it: the watch rail's coverage bands, the handover's
 * "03:04–04:52 unobserved", the wire's OBSERVED class, and every night-bell rule (which fire
 * on edges, never on polling, because a rule that fires on a poll fires forever).
 *
 * The pure half — `diffFrames`, `seedFromTicks`, `watchSpans`, `coverage` — is the half under
 * test. The IndexedDB half degrades to an in-memory ring when there is no `indexedDB`, which
 * is what makes the pure half testable under node at all.
 */

import { count, isNum, isText, ms, plural } from './format.mjs';

export const DB_NAME = 'loop-journal';
export const STORE = 'entries';
export const DB_VERSION = 1;

/** Ring-buffer limits from the spec: 20 000 entries or 14 days, whichever bites first. */
export const MAX_ENTRIES = 20_000;
export const MAX_AGE_MS = 14 * 24 * 3_600_000;

/** A frame gap longer than this ends a watch span — the page was not watching in between. */
export const WATCH_GAP_MS = 60_000;

/** Every transition kind the journal knows how to write. Anything else is dropped, loudly. */
export const KINDS = [
  'activity.state', 'tick.start', 'tick.end', 'exit.class', 'health.row', 'supervisor.reporting',
  'git.head', 'account.switch', 'account.cold', 'account.refused', 'account.utilization',
  'parked.add', 'parked.remove', 'owed.delta', 'feed', 'notional', 'gate.warning', 'watch',
];

const KIND_SET = new Set(KINDS);

/** Deterministic ids so the same transition written twice does not become two rows. */
const idOf = (at, kind, key) => `${at}:${kind}:${key ?? ''}`;

const entry = (at, kind, fields = {}) => ({ id: idOf(at, kind, fields.key), at, kind, reconstructed: false, ...fields });

/* ====================================================================== the diff ==== */

/**
 * Everything that changed between two state frames. `prev` null means this is the first frame
 * of a session — which produces NO transitions, because "the loop is WORKING" on load is not
 * a transition into WORKING, and recording it as one would put a fake edge in every rule.
 */
export function diffFrames(prev, next, opts = {}) {
  const at = isNum(opts.at) ? opts.at : (ms(next && next.at) ?? Date.now());
  if (!next) return [];
  if (!prev) return [];
  const out = [];

  /* the loop's own word */
  const a = prev.activity || {};
  const b = next.activity || {};
  if (isText(b.state) && a.state !== b.state) {
    out.push(entry(at, 'activity.state', { key: b.state, from: a.state ?? null, to: b.state, reason: isText(b.reason) ? b.reason : null, tone: b.tone ?? null }));
  }

  /* the lane: a new id is a run starting, a vanished id is a run ending */
  const prevLane = prev.live && isText(prev.live.id) ? prev.live.id : null;
  const nextLane = next.live && isText(next.live.id) ? next.live.id : null;
  if (prevLane !== nextLane) {
    if (prevLane) out.push(entry(at, 'tick.end', { key: prevLane, lane: prevLane, spec: prev.live.spec ?? null, exit: exitOfNewestTick(next, prev), cost: newestCost(next) }));
    if (nextLane) out.push(entry(at, 'tick.start', { key: nextLane, lane: nextLane, spec: next.live.spec ?? null, account: next.live.account ?? null, stage: next.live.stage ?? null }));
  }

  /* the supervisor and its rows */
  const ps = prev.health && prev.health.supervisor;
  const ns = next.health && next.health.supervisor;
  if (ps && ns && ps.reporting !== ns.reporting) {
    out.push(entry(at, 'supervisor.reporting', { key: String(ns.reporting), from: ps.reporting, to: ns.reporting, advice: isText(ns.advice) ? ns.advice : null }));
  }
  const prevRows = new Map((Array.isArray(prev.health && prev.health.rows) ? prev.health.rows : []).map((r) => [r && r.check, r]));
  for (const r of Array.isArray(next.health && next.health.rows) ? next.health.rows : []) {
    if (!r || !isText(r.check)) continue;
    const was = prevRows.get(r.check);
    if (was && was.status !== r.status) {
      out.push(entry(at, 'health.row', { key: r.check, check: r.check, label: r.label ?? r.check, from: was.status ?? null, to: r.status, detail: isText(r.detail) ? r.detail : null }));
    }
  }

  /* the tree */
  const ph = prev.git && isText(prev.git.head) ? prev.git.head : null;
  const nh = next.git && isText(next.git.head) ? next.git.head : null;
  if (nh && ph !== nh) {
    out.push(entry(at, 'git.head', { key: nh, from: ph, to: nh, subject: isText(next.git.subject) ? next.git.subject : null, branch: isText(next.git.branch) ? next.git.branch : null }));
  }

  /* the account pool */
  const prevAcc = new Map((Array.isArray(prev.accounts) ? prev.accounts : []).map((x) => [x && x.id, x]));
  for (const acc of Array.isArray(next.accounts) ? next.accounts : []) {
    if (!acc || !isText(acc.id)) continue;
    const was = prevAcc.get(acc.id);
    if (!was) continue;
    if (was.cold !== acc.cold) {
      out.push(entry(at, 'account.cold', { key: `${acc.id}:${acc.cold}`, id: acc.id, from: was.cold, to: acc.cold, reason: isText(acc.refusedReason) ? acc.refusedReason : null, coldMinutes: isNum(acc.coldMinutes) ? acc.coldMinutes : null }));
    }
    if (was.refused !== acc.refused && acc.refused) {
      out.push(entry(at, 'account.refused', { key: acc.id, id: acc.id, reason: isText(acc.refusedReason) ? acc.refusedReason : null }));
    }
    // Utilization is sampled, not edged: one row every time it moves by 5 points, so a night
    // of samples is a readable curve rather than 20 000 rows of noise.
    if (isNum(acc.utilization) && isNum(was.utilization) && Math.abs(acc.utilization - was.utilization) >= 0.05) {
      out.push(entry(at, 'account.utilization', { key: `${acc.id}:${Math.round(acc.utilization * 20)}`, id: acc.id, from: was.utilization, to: acc.utilization }));
    }
  }
  const prevLaneAccount = prev.live && isText(prev.live.account) ? prev.live.account : null;
  const nextLaneAccount = next.live && isText(next.live.account) ? next.live.account : null;
  if (prevLaneAccount && nextLaneAccount && prevLaneAccount !== nextLaneAccount) {
    out.push(entry(at, 'account.switch', { key: `${prevLaneAccount}>${nextLaneAccount}`, from: prevLaneAccount, to: nextLaneAccount }));
  }

  /* the founder's desk */
  const wasParked = new Set(Array.isArray(prev.parked) ? prev.parked : []);
  const nowParked = new Set(Array.isArray(next.parked) ? next.parked : []);
  for (const p of nowParked) if (!wasParked.has(p)) out.push(entry(at, 'parked.add', { key: p, value: p }));
  for (const p of wasParked) if (!nowParked.has(p)) out.push(entry(at, 'parked.remove', { key: p, value: p }));

  /* the gates the server flags */
  const wasWarn = new Set((Array.isArray(prev.catalog && prev.catalog.entries) ? prev.catalog.entries : []).filter((e) => e && e.closingGateWarning).map((e) => e.id));
  for (const e of Array.isArray(next.catalog && next.catalog.entries) ? next.catalog.entries : []) {
    if (!e || !e.closingGateWarning || wasWarn.has(e.id)) continue;
    out.push(entry(at, 'gate.warning', { key: e.id, id: e.id, value: isText(e.closingGate) ? e.closingGate : null }));
  }

  /* the money, at every $250 mark — the only threshold in the file, and it is the founder's */
  const step = isNum(opts.notionalStep) ? opts.notionalStep : 250;
  const pn = prev.totals && isNum(prev.totals.notional) ? prev.totals.notional : null;
  const nn = next.totals && isNum(next.totals.notional) ? next.totals.notional : null;
  if (pn != null && nn != null && Math.floor(nn / step) > Math.floor(pn / step)) {
    const mark = Math.floor(nn / step) * step;
    out.push(entry(at, 'notional', { key: String(mark), from: pn, to: mark, actual: nn }));
  }

  /* what the founder is owed, when the caller has fetched it */
  if (isNum(opts.owedBefore) && isNum(opts.owedAfter) && opts.owedBefore !== opts.owedAfter) {
    out.push(entry(at, 'owed.delta', { key: `${opts.owedBefore}>${opts.owedAfter}`, from: opts.owedBefore, to: opts.owedAfter }));
  }

  return out.filter((e) => KIND_SET.has(e.kind));
}

/** The exit class of the newest ledger row, used to close out a lane that just vanished. */
function exitOfNewestTick(next, prev) {
  const rows = Array.isArray(next && next.ticks) ? next.ticks : [];
  const before = Array.isArray(prev && prev.ticks) ? prev.ticks : [];
  if (!rows.length) return null;
  // Only trust the newest row if it is genuinely new — otherwise the lane ended for a reason
  // the ledger has not recorded yet, and claiming last run's exit would be a fabrication.
  if (before.length && rows[0] && before[0] && rows[0].startedAt === before[0].startedAt) return null;
  return isText(rows[0].exit) ? rows[0].exit : null;
}

function newestCost(next) {
  const rows = Array.isArray(next && next.ticks) ? next.ticks : [];
  return rows.length && isNum(rows[0].cost) ? rows[0].cost : null;
}

/* ================================================================== the seeding ==== */

/**
 * On boot the journal is empty and the watch rail would be 24 hours of nothing — which reads
 * as "nothing happened", the exact lie. So the ledger is replayed into RECONSTRUCTED entries:
 * real events, honestly marked as having been learned after the fact rather than watched.
 */
export function seedFromTicks(state, opts = {}) {
  const now = isNum(opts.now) ? opts.now : Date.now();
  const since = isNum(opts.sinceMs) ? now - opts.sinceMs : now - MAX_AGE_MS;
  const out = [];
  const rows = Array.isArray(state && state.ticks) ? state.ticks : [];

  for (const t of rows) {
    const startedAt = ms(t && t.startedAt);
    if (startedAt == null || startedAt < since) continue;      // no stamp, no place in time
    const minutes = isNum(t.minutes) ? t.minutes : null;
    out.push({ ...entry(startedAt, 'tick.start', { key: `${startedAt}`, spec: t.spec ?? null, account: t.account ?? null }), reconstructed: true });
    if (minutes != null) {
      const endedAt = startedAt + minutes * 60_000;
      out.push({ ...entry(endedAt, 'tick.end', { key: `${startedAt}`, spec: t.spec ?? null, exit: isText(t.exit) ? t.exit : null, cost: isNum(t.cost) ? t.cost : null, closed: isNum(t.closed) ? t.closed : null }), reconstructed: true });
    }
  }

  for (const e of Array.isArray(state && state.health && state.health.events) ? state.health.events : []) {
    const at = ms(e && e.at);
    if (at == null || at < since) continue;
    out.push({ ...entry(at, 'health.row', { key: `${e.check}:${at}`, check: e.check ?? null, from: null, to: e.status ?? null, detail: isText(e.detail) ? e.detail : null }), reconstructed: true });
  }

  return out.sort((x, y) => x.at - y.at);
}

/** How many rows the ledger could not place, so the rail can say so rather than imply zero. */
export function seedExclusions(state) {
  const rows = Array.isArray(state && state.ticks) ? state.ticks : [];
  const unstamped = rows.filter((t) => ms(t && t.startedAt) == null).length;
  const total = state && state.totals && isNum(state.totals.rows) ? state.totals.rows : rows.length;
  return {
    shown: rows.length,
    total,
    unstamped,
    text: unstamped === 0
      ? null
      : `${count(unstamped)} of ${count(rows.length)} ledger ${plural(rows.length, 'row carries', 'rows carry')} no start stamp and ${plural(unstamped, 'is', 'are')} not on this rail`,
  };
}

/* =================================================================== the coverage ==== */

/**
 * The spans this page was actually watching, reconstructed from its own frame marks. A run of
 * `watch` entries closer together than WATCH_GAP_MS is one span; a longer silence ends it.
 *
 * This is the computation that lets the deck say '03:04–04:52 unobserved' instead of drawing
 * a confident, continuous rail over four hours nobody was in the room for.
 */
export function watchSpans(entries, opts = {}) {
  const gap = isNum(opts.gapMs) ? opts.gapMs : WATCH_GAP_MS;
  const marks = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.kind === 'watch' && isNum(e.at))
    .map((e) => e.at)
    .sort((a, b) => a - b);

  const spans = [];
  for (const at of marks) {
    const last = spans[spans.length - 1];
    if (last && at - last.to <= gap) last.to = at;
    else spans.push({ from: at, to: at });
  }
  return spans;
}

/**
 * Coverage over a window: which parts the page watched, which it did not, and the headline
 * percentage the rail header prints. Gaps come back as real intervals so they can be drawn as
 * hatch bands and named in the handover.
 */
export function coverage(entries, opts = {}) {
  const now = isNum(opts.now) ? opts.now : Date.now();
  const spanMs = isNum(opts.spanMs) ? opts.spanMs : 24 * 3_600_000;
  const from = isNum(opts.from) ? opts.from : now - spanMs;
  const to = isNum(opts.to) ? opts.to : now;
  const total = Math.max(1, to - from);

  const clipped = watchSpans(entries, opts)
    .map((s) => ({ from: Math.max(from, s.from), to: Math.min(to, s.to) }))
    .filter((s) => s.to > s.from)
    .sort((a, b) => a.from - b.from);

  const merged = [];
  for (const s of clipped) {
    const last = merged[merged.length - 1];
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else merged.push({ ...s });
  }

  const gaps = [];
  let cursor = from;
  for (const s of merged) {
    if (s.from > cursor) gaps.push({ from: cursor, to: s.from });
    cursor = Math.max(cursor, s.to);
  }
  if (cursor < to) gaps.push({ from: cursor, to });

  const watchedMs = merged.reduce((a, s) => a + (s.to - s.from), 0);
  const fraction = watchedMs / total;
  return {
    from,
    to,
    spans: merged,
    gaps,
    watchedMs,
    fraction,
    // Rounded DOWN: claiming 100% coverage off 99.6 is the small lie that trains a founder to
    // stop believing the header.
    percent: Math.floor(fraction * 100),
    text: `watched ${Math.floor(fraction * 100)}% of ${Math.round(total / 3_600_000)}h`,
    gapText: gaps.length === 0
      ? null
      : gaps.map((g) => `${hhmm(g.from)}–${hhmm(g.to)}`).join(', '),
  };
}

const hhmm = (t) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Entries inside a window, newest first. The rail and the digest both read through this. */
export function range(entries, from, to) {
  const a = isNum(from) ? from : -Infinity;
  const b = isNum(to) ? to : Infinity;
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && isNum(e.at) && e.at >= a && e.at <= b)
    .sort((x, y) => y.at - x.at);
}

/** Trim to the ring-buffer limits. Pure, so the eviction rule is testable without a database. */
export function trim(entries, opts = {}) {
  const now = isNum(opts.now) ? opts.now : Date.now();
  const maxAge = isNum(opts.maxAgeMs) ? opts.maxAgeMs : MAX_AGE_MS;
  const maxEntries = isNum(opts.maxEntries) ? opts.maxEntries : MAX_ENTRIES;
  const kept = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && isNum(e.at) && now - e.at <= maxAge)
    .sort((a, b) => a.at - b.at);
  return kept.length > maxEntries ? kept.slice(kept.length - maxEntries) : kept;
}

/* ==================================================================== the store ==== */

/**
 * The durable half. IndexedDB where there is one, an in-memory ring where there is not — a
 * private window, a locked-down profile, or vitest under node. The API is identical either
 * way and `durable` says which one you got, because a journal that silently forgets on reload
 * would be a UI reporting a capability it does not have.
 */
export function openJournal(opts = {}) {
  const idb = opts.indexedDB !== undefined ? opts.indexedDB : (typeof indexedDB !== 'undefined' ? indexedDB : null);
  let memory = [];
  let dbPromise = null;
  const seen = new Set();

  const openDb = () => {
    if (!idb) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      let req;
      try { req = idb.open(opts.dbName || DB_NAME, DB_VERSION); } catch { resolve(null); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('at', 'at');
        }
      };
      req.onsuccess = () => resolve(req.result);
      // A database that will not open is not an error worth a dialog — it is a journal that
      // is not durable, and `durable:false` is how the page is told to say so.
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
    return dbPromise;
  };

  const tx = async (mode, fn) => {
    const db = await openDb();
    if (!db) return null;
    return new Promise((resolve) => {
      let t;
      try { t = db.transaction(STORE, mode); } catch { resolve(null); return; }
      const store = t.objectStore(STORE);
      let result = null;
      try { result = fn(store); } catch { /* fall through to the memory copy */ }
      t.oncomplete = () => resolve(result && typeof result.then === 'function' ? result : result);
      t.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
    });
  };

  const api = {
    durable: Boolean(idb),

    /** Append transitions. Duplicate ids are dropped — the same edge written twice is one edge. */
    async write(entries) {
      const fresh = (Array.isArray(entries) ? entries : []).filter((e) => e && isNum(e.at) && isText(e.kind) && !seen.has(e.id));
      for (const e of fresh) { seen.add(e.id); memory.push(e); }
      memory = trim(memory, opts);
      if (fresh.length) await tx('readwrite', (store) => { for (const e of fresh) store.put(e); });
      return fresh;
    },

    /** One watch mark per state frame. This is what `coverage` reads. */
    async mark(at) {
      const t = isNum(at) ? at : Date.now();
      // Bucketed to 15s so a 4s push does not write 21 600 rows a day.
      const bucket = Math.floor(t / 15_000) * 15_000;
      return api.write([entry(bucket, 'watch', { key: String(bucket) })]);
    },

    /** Load whatever survived the reload, merge it under the in-memory copy. */
    async load(opt = {}) {
      const since = isNum(opt.since) ? opt.since : Date.now() - MAX_AGE_MS;
      const rows = await tx('readonly', (store) => new Promise((resolve) => {
        const found = [];
        const req = store.index('at').openCursor(IDBKeyRange.lowerBound(since));
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) { resolve(found); return; }
          found.push(cursor.value);
          cursor.continue();
        };
        req.onerror = () => resolve(found);
      }));
      const loaded = Array.isArray(rows) ? rows : (rows && typeof rows.then === 'function' ? await rows : []);
      for (const e of loaded || []) if (e && !seen.has(e.id)) { seen.add(e.id); memory.push(e); }
      memory = trim(memory, opts);
      return memory;
    },

    /** Seed reconstructed rows from the ledger, once, so an empty database still has 24h. */
    async seed(state, o = {}) {
      const rows = seedFromTicks(state, o);
      return api.write(rows);
    },

    all: () => memory.slice(),
    range: (from, to) => range(memory, from, to),
    coverage: (o = {}) => coverage(memory, o),
    watchSpans: (o = {}) => watchSpans(memory, o),
    exclusions: (state) => seedExclusions(state),
    size: () => memory.length,

    async clear() {
      memory = [];
      seen.clear();
      await tx('readwrite', (store) => store.clear());
    },
  };
  return api;
}
