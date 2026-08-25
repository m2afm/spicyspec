/**
 * instruments.mjs — the one import app.html needs.
 *
 *   import * as instruments from './instruments.mjs';
 *   instruments.cadence(ring, { now, live, loopState })
 *
 * The deck's spec calls every derivation `instruments.something()`. The implementations live
 * in focused modules — metrics, charts, anomalies, wire, digest, journal, notify, palette,
 * search, fact, format — because a single 2 000-line file is the thing this room is escaping.
 * This is the façade over them, and it is the only name app.html has to know.
 *
 * Everything re-exported here is pure with two named exceptions, both of which say so:
 * `openJournal` (IndexedDB, degrades to memory) and `createBell` (the Notification API).
 */

export * from './format.mjs';
export * from './fact.mjs';
export * from './charts.mjs';
export * from './metrics.mjs';
export * from './wire.mjs';
export * from './search.mjs';

// Named rather than star-exported: each of these owns a name that also exists elsewhere
// (`anomalies` vs the state field, `coverage` in both fact and journal, `range`, `rank`), and
// an ambiguous star-export silently resolves to nothing in an ES module.
export { anomalies, clientFallback, ALARM as ANOMALY_ALARM, CAUTION as ANOMALY_CAUTION } from './anomalies.mjs';

export {
  openJournal, diffFrames, seedFromTicks, seedExclusions, watchSpans, trim as trimJournal,
  coverage as watchCoverage, range as journalRange,
  DB_NAME, STORE as JOURNAL_STORE, KINDS as JOURNAL_KINDS, MAX_ENTRIES, MAX_AGE_MS, WATCH_GAP_MS,
} from './journal.mjs';

export {
  digestDiff, handover, shouldHandover, spanWords, HANDOVER_MIN_AWAY_MS,
} from './digest.mjs';

export {
  createBell, evaluate as evaluateBell, defaultConfig as defaultBellConfig, inQuietHours,
  testNotice, RULES as BELL_RULES, RULE_IDS as BELL_RULE_IDS,
  CRITICAL as BELL_CRITICAL, MONEY as BELL_MONEY, OWED as BELL_OWED,
} from './notify.mjs';

export {
  localItems as paletteItems, remoteItems as paletteRemoteItems, rank as paletteRank,
  move as paletteMove, GROUPS as PALETTE_GROUPS, FIELDS as PALETTE_FIELDS,
} from './palette.mjs';

import {
  annunciatorSummary, annunciators, applyAcks, burn as burnOf, cadence, ladder as ladderOf,
  ledgerSeries as ledgerSeriesOf, rankOwed, runway as runwayOf, telemetry as telemetryOf,
} from './metrics.mjs';
import { anomalies as anomaliesOf } from './anomalies.mjs';
import { mergeObserved, wireRows } from './wire.mjs';
import { isNum } from './format.mjs';

/**
 * The cadence ring, as a helper rather than a component, so app.html's ref holds plain data
 * and nothing about proof-of-life depends on a render happening.
 *
 * R4: this is the ONLY thing that is supposed to change on every 4s push, and it changes a
 * data structure, not a class — no animation is keyed off it except the heartbeat dot, whose
 * entire meaning is "a push just landed".
 */
export function pushSample(ring, state, opts = {}) {
  const slots = isNum(opts.slots) ? opts.slots : 60;
  const at = isNum(opts.now) ? opts.now : Date.now();
  const live = state && state.live ? state.live : null;
  const next = Array.isArray(ring) ? ring.slice() : [];
  const last = next[next.length - 1];
  // Two frames inside the same second are one frame — a reconnect that replays `hello` plus a
  // `state` must not read as a second of activity.
  if (last && at - last.at < 1000) return next;
  next.push({
    at,
    laneId: live && live.id != null ? String(live.id) : null,
    tools: live && isNum(live.tools) ? live.tools : null,
    verification: live && isNum(live.verification) ? live.verification : null,
    subagents: live && isNum(live.subagents) ? live.subagents : null,
  });
  return next.length > slots + 1 ? next.slice(next.length - (slots + 1)) : next;
}

/**
 * One call that produces everything Z0–Z6 needs from a frame, so app.html reads one object
 * rather than orchestrating nine derivations in render order. Every field is plain data;
 * nothing here touches the DOM, fetches, or keeps state between calls.
 */
export function readDeck(state, opts = {}) {
  const now = isNum(opts.now) ? opts.now : Date.now();
  const cad = cadence(opts.ring, {
    now,
    live: state && state.live,
    loopState: state && state.activity && state.activity.state,
    slots: opts.slots,
  });
  const slots = applyAcks(annunciators(state, { ...opts, now, cadence: cad }), opts.acked || new Map(), now);
  const river = mergeObserved(wireRows(state, { ...opts, journal: opts.journal }), opts.journal, opts);

  return {
    now,
    cadence: cad,
    annunciators: slots,
    summary: annunciatorSummary(slots),
    anomalies: anomaliesOf(state, { ...opts, now, cadence: cad }),
    burn: burnOf(state, opts),
    runway: runwayOf(state, { ...opts, now }),
    ladder: ladderOf(state),
    owed: rankOwed(opts.owed || [], opts),
    telemetry: telemetryOf(state, { ...opts, now }),
    ledger: ledgerSeriesOf(state),
    wire: river,
  };
}

export { cadence };
