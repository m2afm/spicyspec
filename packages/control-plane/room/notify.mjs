/**
 * notify.mjs — C4, THE NIGHT BELL. The highest live value on the deck, because the founder
 * leaves this running overnight and the room's job is to wake them for the four things worth
 * waking for and for nothing else.
 *
 * 127.0.0.1 is a secure context, so the Notification API works with no server, no push
 * service and no account. Everything here is local.
 *
 * Three rules that are not negotiable:
 *  1. RULES FIRE ON EDGES, NEVER ON POLLS. Every rule reads a journal TRANSITION. A rule that
 *     fired off "is the supervisor down right now" would fire every four seconds all night.
 *  2. PERMISSION IS ONLY EVER REQUESTED FROM A REAL CLICK on the bell. Nothing here prompts
 *     on load — an auto-prompt gets denied, and a denied bell is a silent one forever.
 *  3. EVERY RULE HAS A TEST BUTTON. A silently-broken alerter is worse than no alerter: it
 *     converts "I heard nothing" from "I do not know" into "nothing happened".
 *
 * The pure half — the rules, the quiet-hours window, the dedupe — is what the tests cover.
 */

import { count, isNum, isText, money, oneLine, plural } from './format.mjs';
import { EXIT_BAD } from './metrics.mjs';

export const CRITICAL = 'critical';
export const MONEY = 'money';
export const OWED = 'owed';

/**
 * The rule table. `tag` is the Notification tag, set per rule CLASS so an overnight run
 * replaces its own last notice rather than stacking forty of them on the lock screen.
 */
export const RULES = [
  {
    id: 'loop-left-working',
    label: 'The loop stops working',
    klass: CRITICAL,
    tag: 'loop',
    kinds: ['activity.state'],
    match: (e) => (e.from === 'WORKING' && e.to !== 'WORKING'
      ? { title: `The loop went ${e.to}`, body: isText(e.reason) ? e.reason : 'no reason was reported' }
      : null),
  },
  {
    id: 'health-failed',
    label: 'A health check fails',
    klass: CRITICAL,
    tag: 'health',
    kinds: ['health.row'],
    match: (e) => (e.to === 'failed' || e.to === 'blocked'
      ? { title: `${e.label || e.check} is ${e.to}`, body: isText(e.detail) ? e.detail : 'the supervisor reported no detail' }
      : null),
  },
  {
    id: 'supervisor-silent',
    label: 'The supervisor stops reporting',
    klass: CRITICAL,
    tag: 'health',
    kinds: ['supervisor.reporting'],
    match: (e) => (e.to === false
      ? { title: 'The supervisor stopped reporting', body: isText(e.advice) ? e.advice : 'nothing is watching the loop now' }
      : null),
  },
  {
    id: 'feed-silent',
    label: 'The event feed goes silent',
    klass: CRITICAL,
    tag: 'health',
    kinds: ['feed'],
    match: (e) => (e.to === 'down'
      ? { title: 'This page stopped being told anything', body: 'the event stream went silent — everything on the deck is frozen at its last value' }
      : null),
  },
  {
    id: 'run-ended-badly',
    label: 'A run ends badly',
    klass: CRITICAL,
    tag: 'run',
    kinds: ['tick.end'],
    match: (e) => (isText(e.exit) && EXIT_BAD.has(e.exit)
      ? { title: `A run ended ${e.exit}`, body: [isText(e.spec) ? `Spec ${e.spec}` : null, isNum(e.cost) ? money(e.cost) : null].filter(Boolean).join(' · ') || 'no detail was recorded' }
      : null),
  },
  {
    id: 'parked',
    label: 'Something gets parked',
    klass: OWED,
    tag: 'desk',
    kinds: ['parked.add'],
    match: (e) => ({ title: 'The loop parked on something', body: oneLine(e.value, 140) }),
  },
  {
    id: 'owed',
    label: 'Something lands on your desk',
    klass: OWED,
    tag: 'desk',
    kinds: ['owed.delta'],
    match: (e) => (isNum(e.to) && isNum(e.from) && e.to > e.from
      ? { title: `${count(e.to - e.from)} new ${plural(e.to - e.from, 'item', 'items')} need you`, body: `${count(e.to)} ${plural(e.to, 'thing', 'things')} now waiting on you` }
      : null),
  },
  {
    id: 'gate-warning',
    label: 'A closing gate is flagged',
    klass: OWED,
    tag: 'desk',
    kinds: ['gate.warning'],
    match: (e) => ({ title: `Spec ${e.id} raised a closing-gate warning`, body: isText(e.value) ? oneLine(e.value, 140) : 'the server flagged the gate but published no note' }),
  },
  {
    id: 'account-refused',
    label: 'An account refuses work',
    klass: MONEY,
    tag: 'bureau',
    kinds: ['account.refused'],
    match: (e) => ({ title: `${e.id} refused work`, body: isText(e.reason) ? e.reason : 'no reason was reported' }),
  },
  {
    id: 'account-cold',
    label: 'An account goes cold',
    klass: MONEY,
    tag: 'bureau',
    kinds: ['account.cold'],
    match: (e) => (e.to === true
      ? { title: `${e.id} went cold`, body: isNum(e.coldMinutes) && e.coldMinutes > 0 ? `${e.coldMinutes}m before it can be used again` : 'no wait was reported' }
      : null),
  },
  {
    id: 'notional',
    label: 'Spend crosses another $250',
    klass: MONEY,
    tag: 'money',
    kinds: ['notional'],
    match: (e) => ({ title: `Spend passed ${money(e.to)}`, body: isNum(e.actual) ? `the ledger now reads ${money(e.actual)}` : 'read off totals.notional' }),
  },
];

export const RULE_IDS = RULES.map((r) => r.id);

/** Everything on by default: a bell the founder has to switch on rule by rule is a bell off. */
export function defaultConfig() {
  return {
    enabled: false,                    // until a real click grants permission
    rules: Object.fromEntries(RULES.map((r) => [r.id, true])),
    quiet: { enabled: false, from: 23, to: 7 },   // local hours; CRITICAL overrides
  };
}

/**
 * Is `now` inside the quiet window? Handles a window that wraps midnight, which is the only
 * kind anybody actually sets.
 */
export function inQuietHours(quiet, now = Date.now()) {
  if (!quiet || !quiet.enabled) return false;
  const from = isNum(quiet.from) ? quiet.from : 23;
  const to = isNum(quiet.to) ? quiet.to : 7;
  const h = new Date(now).getHours();
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

/**
 * Turn journal transitions into notifications. Pure: returns what SHOULD be posted, and the
 * caller posts it. Suppressions are returned too, not dropped — the bell panel shows what it
 * held back, because a filter nobody can see is a filter nobody trusts.
 */
export function evaluate(entries, config, opts = {}) {
  const now = isNum(opts.now) ? opts.now : Date.now();
  const cfg = config || defaultConfig();
  const sent = opts.sent instanceof Set ? opts.sent : new Set(opts.sent || []);
  const quiet = inQuietHours(cfg.quiet, now);
  const byKind = new Map();
  for (const rule of RULES) for (const k of rule.kinds) byKind.set(k, [...(byKind.get(k) || []), rule]);

  const post = [];
  const held = [];

  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !isText(e.kind) || !isNum(e.at)) continue;
    // A reconstructed entry is a thing we learned about after the fact. Firing the bell for a
    // run that ended five hours ago, on page load, would wake the founder for the past.
    if (e.reconstructed) continue;
    for (const rule of byKind.get(e.kind) || []) {
      const hit = rule.match(e);
      if (!hit) continue;
      const sig = `${rule.id}:${e.id}`;
      if (sent.has(sig)) continue;
      const notice = {
        sig,
        ruleId: rule.id,
        klass: rule.klass,
        tag: rule.tag,
        at: e.at,
        title: hit.title,
        body: hit.body,
        entryId: e.id,
      };
      if (cfg.rules && cfg.rules[rule.id] === false) { held.push({ ...notice, reason: 'this rule is switched off' }); continue; }
      // Quiet hours never hold a CRITICAL. The whole point of leaving it running overnight is
      // that the four critical things get through.
      if (quiet && rule.klass !== CRITICAL) { held.push({ ...notice, reason: 'quiet hours' }); continue; }
      post.push(notice);
    }
  }
  return { post, held, quiet };
}

/** The one notice the TEST button posts, per rule — real machinery, obviously fake content. */
export function testNotice(ruleId) {
  const rule = RULES.find((r) => r.id === ruleId);
  if (!rule) return null;
  return {
    sig: `test:${ruleId}:${Date.now()}`,
    ruleId,
    klass: rule.klass,
    tag: rule.tag,
    at: Date.now(),
    title: `Test — ${rule.label}`,
    body: 'If you can read this, the night bell works. This is a test and nothing has happened.',
    test: true,
  };
}

/**
 * The browser adapter. Everything above is pure; this is the only part that touches the
 * Notification API, and it is written so that every failure mode has a NAME the page can show:
 * unsupported / default / granted / denied. None of them is silence.
 */
export function createBell(opts = {}) {
  const Ctor = opts.Notification !== undefined ? opts.Notification : (typeof Notification !== 'undefined' ? Notification : null);
  const sent = new Set();
  let config = opts.config || defaultConfig();

  const permission = () => {
    if (!Ctor) return 'unsupported';
    return Ctor.permission || 'default';
  };

  /**
   * The bell's own status word, which Z0 and Z6 both print. DENIED is loud and in `--hot`,
   * never swallowed: a founder who thinks the bell is on when the browser refused it is worse
   * off than one who never turned it on.
   */
  const status = () => {
    const p = permission();
    if (p === 'unsupported') return { state: 'unsupported', label: 'NO BELL', tone: 'warn', text: 'this browser has no Notification API' };
    if (p === 'denied') return { state: 'denied', label: 'DENIED', tone: 'hot', text: 'the browser refused notifications for this page — clear it in site settings' };
    if (p === 'granted') return config.enabled
      ? { state: 'on', label: 'ON', tone: 'ok', text: 'the night bell will wake you' }
      : { state: 'off', label: 'OFF', tone: 'warn', text: 'permission granted, but the bell is switched off' };
    return { state: 'default', label: 'OFF', tone: 'warn', text: 'click to let this page notify you' };
  };

  return {
    status,
    permission,
    get config() { return config; },
    set config(next) { config = next || defaultConfig(); },

    /** ONLY call this from a real click handler. Never on load. */
    async request() {
      if (!Ctor || typeof Ctor.requestPermission !== 'function') return status();
      try {
        const result = await Ctor.requestPermission();
        config = { ...config, enabled: result === 'granted' };
      } catch {
        /* a browser that throws on request is a browser without a bell — status() says so */
      }
      return status();
    },

    /** Post one notice. Returns what happened, so the panel can show a rule that never fires. */
    post(notice) {
      if (!notice) return { posted: false, reason: 'nothing to post' };
      const p = permission();
      if (p !== 'granted') return { posted: false, reason: `permission is ${p}` };
      if (!config.enabled && !notice.test) return { posted: false, reason: 'the bell is switched off' };
      try {
        // eslint-disable-next-line no-new
        new Ctor(notice.title, { body: notice.body, tag: notice.tag, silent: false, requireInteraction: notice.klass === CRITICAL });
        if (notice.sig) sent.add(notice.sig);
        return { posted: true, reason: null };
      } catch (err) {
        return { posted: false, reason: `the browser refused it: ${err && err.message ? err.message : 'no reason given'}` };
      }
    },

    /** Run the rules over new transitions and post what survives them. */
    fire(entries, o = {}) {
      const result = evaluate(entries, config, { ...o, sent });
      const posted = [];
      for (const notice of result.post) {
        const r = this.post(notice);
        if (r.posted) posted.push(notice);
        else result.held.push({ ...notice, reason: r.reason });
        sent.add(notice.sig);
      }
      return { ...result, posted };
    },

    test(ruleId) { return this.post(testNotice(ruleId)); },
    sentCount: () => sent.size,
  };
}
