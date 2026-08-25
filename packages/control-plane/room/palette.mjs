/**
 * palette.mjs — C6. ⌘K.
 *
 * A fixed deck answers "is it stuck" with no interaction at all; the palette is how the
 * founder reaches everything the deck deliberately does NOT put on screen. It is the reason
 * the nav rail could be cut: nothing is more than three keystrokes away, and the glance stays
 * free of a chrome that would have cost it.
 *
 * Two corpora, one list. LOCAL items are commands and objects the page already holds — the
 * control actions, every catalog entry, every role, the themes, the bell. REMOTE hits come
 * from /api/search, which reads the whole store; they are appended in their own group and
 * never outrank a command, because a founder typing 'stop' wants the button.
 *
 * This module builds and ranks; it does not run anything. `run` on each item is the caller's
 * own function, so no side effect is ever authored here.
 */

import { count, isNum, isText, money, oneLine, plural } from './format.mjs';
import { groupResults, search } from './search.mjs';

/** Group order is rank order for equal scores: what you can DO comes before what you can READ. */
export const GROUPS = ['ACTION', 'GO', 'SPEC', 'ROLE', 'VIEW', 'BELL', 'LOG'];

const item = (o) => ({ keywords: [], priority: 0, danger: false, ...o });

/**
 * The local corpus. `handlers` is a bag of callbacks the page supplies; an item whose handler
 * is missing is simply not built, so the palette can never offer a command that does nothing.
 */
export function localItems(state, handlers = {}, opts = {}) {
  const s = state || {};
  const out = [];
  const has = (k) => typeof handlers[k] === 'function';

  /* -------------------------------------------------------- the control actions ---- */
  // Ranked by consequence, and the two that stop the loop say so in `danger` so app.html can
  // demand a second keystroke rather than firing on a fuzzy match.
  const actions = [
    { key: 'start', label: 'Start the loop', keywords: ['run', 'go', 'resume', 'dispatch'], danger: false, priority: 60 },
    { key: 'stop', label: 'Arm stop — finish this run, then halt', keywords: ['halt', 'pause', 'end'], danger: true, priority: 55 },
    { key: 'kill', label: 'Arm kill — stop the run now', keywords: ['halt', 'abort', 'now'], danger: true, priority: 40 },
    { key: 'clearStop', label: 'Clear the stop flag', keywords: ['unstop', 'disarm', 'resume'], danger: false, priority: 50 },
    { key: 'clearKill', label: 'Clear the kill flag', keywords: ['unkill', 'disarm'], danger: false, priority: 45 },
  ];
  for (const a of actions) {
    if (!has(a.key)) continue;
    out.push(item({ id: `action:${a.key}`, group: 'ACTION', label: a.label, keywords: a.keywords, danger: a.danger, priority: a.priority, run: handlers[a.key] }));
  }

  /* --------------------------------------------------------------- the catalog ---- */
  const entries = Array.isArray(s.catalog && s.catalog.entries) ? s.catalog.entries : [];
  for (const e of entries) {
    if (!e || !isText(e.id) || !has('openSpec')) continue;
    const p = e.progress || {};
    out.push(item({
      id: `spec:${e.id}`,
      group: 'SPEC',
      label: `Spec ${e.id} — ${isText(e.slug) ? e.slug : 'no slug'}`,
      hint: [
        isText(e.status) ? e.status : null,
        isNum(p.done) && isNum(p.total) ? `${count(p.done)}/${count(p.total)}` : 'no tasks.md the room can read',
        e.closingGateWarning ? 'closing gate flagged' : null,
      ].filter(Boolean).join(' · '),
      keywords: [e.id, e.slug, e.status, e.stage].filter(isText),
      // What is being worked, and what is flagged, sort above the settled middle of the list.
      priority: e.closingGateWarning ? 30 : e.status === 'active' ? 25 : e.status === 'awaiting-founder' ? 20 : 0,
      run: () => handlers.openSpec(e.id),
    }));
  }

  /* ----------------------------------------------------------------- the roles ---- */
  for (const r of Array.isArray(opts.roles) ? opts.roles : []) {
    if (!r || !isText(r.id) || !has('openRole')) continue;
    out.push(item({
      id: `role:${r.id}`,
      group: 'ROLE',
      label: `Ask ${isText(r.name) ? r.name : r.id}`,
      hint: isText(r.title) ? r.title : null,
      keywords: [r.id, r.name, r.title].filter(isText),
      priority: r.busy ? 10 : 0,
      run: () => handlers.openRole(r.id),
    }));
  }

  /* ------------------------------------------------------------ jumping around ---- */
  for (const desk of Array.isArray(opts.desks) ? opts.desks : []) {
    if (!has('jumpDesk')) break;
    out.push(item({ id: `desk:${desk}`, group: 'GO', label: `Wire — ${desk}`, keywords: ['wire', 'jump', desk.toLowerCase()], run: () => handlers.jumpDesk(desk) }));
  }
  const jumps = [
    ['openDigest', 'Open the late edition — what happened while you were away', ['digest', 'slept', 'overnight', 'handover', 'while']],
    ['openLedger', 'Open the raw ledger', ['ledger', 'runs', 'ticks', 'rows', 'money']],
    ['openHealth', 'Open the health roster', ['health', 'supervisor', 'checks']],
    ['openParked', 'Open what is parked', ['parked', 'blocked', 'stuck']],
    ['openOwed', 'Open what you owe', ['owed', 'signoff', 'sign-off', 'journey', 'mine']],
    ['openShortcuts', 'Show the keyboard shortcuts', ['keys', 'help', 'shortcuts', '?']],
  ];
  for (const [key, label, keywords] of jumps) {
    if (!has(key)) continue;
    out.push(item({ id: `go:${key}`, group: 'GO', label, keywords, run: handlers[key] }));
  }

  /* ------------------------------------------------------------------- the view ---- */
  for (const theme of ['auto', 'paper', 'night']) {
    if (!has('setTheme')) break;
    out.push(item({ id: `theme:${theme}`, group: 'VIEW', label: `Theme — ${theme}`, keywords: ['theme', 'dark', 'light', 'colour', 'color', theme], run: () => handlers.setTheme(theme) }));
  }
  for (const density of ['comfortable', 'console', 'wall']) {
    if (!has('setDensity')) break;
    out.push(item({
      id: `density:${density}`,
      group: 'VIEW',
      label: `Density — ${density}`,
      hint: density === 'wall' ? 'for a screen across the room' : density === 'console' ? 'the deck default' : 'the roomier scale',
      keywords: ['density', 'size', 'scale', 'zoom', density],
      run: () => handlers.setDensity(density),
    }));
  }
  if (has('ackAll')) out.push(item({ id: 'ack', group: 'VIEW', label: 'Acknowledge every lit annunciator', keywords: ['ack', 'silence', 'clear', 'alarm'], priority: 15, run: handlers.ackAll }));
  if (has('copyRestart')) {
    out.push(item({
      id: 'copy:restart',
      group: 'VIEW',
      label: 'Copy the command that restarts this room',
      keywords: ['restart', 'copy', 'command', 'dashboard', 'server'],
      run: handlers.copyRestart,
    }));
  }

  /* ------------------------------------------------------------------- the bell ---- */
  if (has('toggleBell')) {
    const st = opts.bell && opts.bell.status ? opts.bell.status() : null;
    out.push(item({
      id: 'bell:toggle',
      group: 'BELL',
      // The label states the CURRENT state, so a founder reading the list is told whether the
      // bell is on — including when the browser has refused it, which never reads as 'off'.
      label: st && st.state === 'denied'
        ? 'Night bell — DENIED by the browser'
        : `Night bell — ${st ? st.label : 'unknown'}`,
      hint: st ? st.text : null,
      keywords: ['bell', 'notify', 'notification', 'wake', 'alert', 'night'],
      priority: st && st.state === 'denied' ? 35 : 5,
      run: handlers.toggleBell,
    }));
  }
  if (has('testBell')) {
    for (const rule of Array.isArray(opts.rules) ? opts.rules : []) {
      out.push(item({
        id: `bell:test:${rule.id}`,
        group: 'BELL',
        label: `Test the bell — ${rule.label}`,
        // A silently-broken alerter is worse than none, so every rule is reachable and
        // testable from here without opening a settings pane.
        hint: 'posts one real notification so you can prove it works',
        keywords: ['test', 'bell', 'notify', rule.id, rule.klass],
        run: () => handlers.testBell(rule.id),
      }));
    }
  }

  return out;
}

/** The server's log hits, as palette items. Their own group; they never outrank a command. */
export function remoteItems(hits, handlers = {}) {
  const open = typeof handlers.openHit === 'function' ? handlers.openHit : null;
  return (Array.isArray(hits) ? hits : []).map((h) => item({
    id: `hit:${h.kind}:${h.id}`,
    group: 'LOG',
    label: isText(h.title) ? h.title : `${h.kind} ${h.id}`,
    hint: [isText(h.snippet) ? oneLine(h.snippet, 96) : null, isText(h.source) ? h.source : null].filter(Boolean).join(' · ') || null,
    keywords: [h.kind, h.id].filter(isText),
    // Negative, so a log row can never displace an ACTION at an equal fuzzy score.
    priority: -50,
    at: h.at ?? null,
    run: open ? () => open(h) : null,
  })).filter((i) => typeof i.run === 'function');
}

/** How the palette weighs its fields. Label first; a keyword hit is real but worth less. */
export const FIELDS = [['label', 1], ['keywords', 0.55], ['hint', 0.35], ['group', 0.25]];

/**
 * Rank a query across both corpora and group the result. Returns a flat `results` list too,
 * because arrow-key navigation runs down the visual order, not down the groups.
 */
export function rank(query, items, opts = {}) {
  const results = search(items, query, { fields: FIELDS, limit: isNum(opts.limit) ? opts.limit : 40 });
  const groups = groupResults(results).sort((a, b) => GROUPS.indexOf(a.key) - GROUPS.indexOf(b.key));
  const flat = groups.flatMap((g) => g.items);
  return {
    query: isText(query) ? query : '',
    results: flat,
    groups,
    // A query that matched nothing says so, and says what it searched — a palette that goes
    // blank leaves the founder unsure whether it is broken or empty.
    emptyText: flat.length === 0
      ? `nothing matched${isText(query) && query.trim() ? ` “${query.trim()}”` : ''} across ${count(items.length)} ${plural(items.length, 'command', 'commands')}`
      : null,
  };
}

/**
 * Keyboard state, kept pure so selection wrapping is testable without a DOM. Arrow keys wrap;
 * a list you can fall off the end of costs a keystroke every time.
 */
export function move(index, delta, length) {
  if (!isNum(length) || length <= 0) return 0;
  const next = (isNum(index) ? index : 0) + delta;
  return ((next % length) + length) % length;
}
