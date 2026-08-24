/**
 * "Where are we right now?" — derived from the transcript, not asked of a model.
 *
 * The obvious implementation is to send the tick's transcript to a model and print what it
 * says. That is rejected on two grounds. It costs quota on every refresh of a dashboard
 * meant to be left open all day, and it puts an unverifiable narrator between the founder
 * and the evidence — this project has already been burned twice by summaries that read well
 * and were wrong, which is why the ledger records executed commands and the harvest pairs
 * tool calls with their results.
 *
 * So every sentence below is assembled from something recorded: an agent's own status, a
 * committed gate record, a task count, the worker's own narration. If a claim here is wrong,
 * the underlying event is wrong too, and that is a bug you can chase rather than a
 * hallucination you cannot.
 */

const STAGES = {
  shape: 'SHAPING — writing spec.md, plan.md and tasks.md from the catalog entry',
  design: 'DESIGN — the gate reviews all three artifacts together before any code',
  build: 'BUILDING — implement waves, each gated as it closes',
  converge: 'CONVERGING — closing gates and reconciling the record',
};

/**
 * Phrases the worker uses when it crosses a real boundary. First match wins, so the order is
 * the priority order — and it ranks by WHAT IS HAPPENING, not by where it is happening.
 *
 * "Wave 3 gate returned REVISE with two findings" matched the generic wave-gate marker first
 * and reported "at a wave gate", throwing away the only part a founder would act on. A
 * verdict outranks a location every time: REVISE means there are findings being fixed, which
 * is a different state from sitting at a gate waiting.
 */
const PHASE_MARKERS = [
  [/\bgate\b.*\bREVISE\b/i, 'a gate returned REVISE — fixing findings'],
  [/\bREVISE\b/, 'working through REVISE findings'],
  [/\bgate\b.*\bAPPROVE\b/i, 'a gate just approved'],
  [/\bclosing gate\b/i, 'at the closing gate'],
  [/\bterminal gate|final gate\b/i, 'at the terminal gate'],
  [/\bwave (\d+)\b.*\bgate\b/i, 'at a wave gate'],
  [/\bred[- ]first\b/i, 'proving a test can fail before making it pass'],
  [/\bfounder journey\b/i, 'blocked on a founder journey'],
  [/\bwave (\d+)\b/i, 'building a wave'],
  [/\bspec\.md\b|\btasks\.md\b/i, 'writing spec artifacts'],
];

const ago = (iso, now = Date.now()) => {
  if (!iso) return null;
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 90) return Math.round(s) + 's';
  if (s < 5400) return Math.round(s / 60) + 'm';
  return (s / 3600).toFixed(1) + 'h';
};

const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);

/**
 * @param {object} input
 *  - agents: snapshot() from agents.mjs
 *  - narration: the root's recent text blocks
 *  - tick: { number, spec, stage, account, startedAt, elapsedMin }
 *  - queue: the catalog entries
 *  - commitsThisTick: subject lines committed since the tick began
 *  - running: is a tick in flight at all
 */
export function describeWhereWeAre(input) {
  const { agents = [], narration = [], tick = null, queue = [], commitsThisTick = [], running = false } = input ?? {};
  const now = Date.now();
  const real = agents.filter((a) => a.kind === 'local_agent');
  const shells = agents.filter((a) => a.kind === 'local_bash');
  const live = real.filter((a) => a.status === 'running');
  const liveShells = shells.filter((a) => a.status === 'running');
  // Only genuine failures. A `stopped` task was cancelled on purpose and is not a problem
  // the founder needs shown — see normaliseStatus in agents.mjs. Agents and commands are
  // counted separately because "an agent came back wrong" and "a shell command died" are
  // different sizes of problem.
  const failed = real.filter((a) => a.status === 'failed');
  const failedShells = shells.filter((a) => a.status === 'failed');

  const owed = queue.filter((e) => e.status === 'awaiting-founder');
  const done = queue.filter((e) => e.status === 'done');
  const active = queue.find((e) => e.status === 'active');

  /* ── headline: the one line worth reading if you read nothing else ───────── */
  let headline;
  if (!running) {
    headline = owed.length
      ? 'Idle — ' + plural(owed.length, 'spec') + ' waiting on a founder journey you have to click'
      : 'Idle — no tick in flight';
  } else if (live.length) {
    headline = plural(live.length, 'agent') + ' working right now on ' +
      (active ? 'spec ' + active.id : 'the active spec');
  } else if (liveShells.length) {
    headline = 'The worker is waiting on ' + plural(liveShells.length, 'command') + ' it dispatched';
  } else {
    headline = 'The worker is working alone — no subagent out at the moment';
  }

  /* ── phase: inferred only from the worker's own words, and said to be inferred ── */
  let phase = tick?.stage ? (STAGES[tick.stage] ?? tick.stage.toUpperCase()) : null;
  let phaseFrom = tick?.stage ? 'the queue entry' : null;
  const recent = narration.slice(-6).map((n) => n.text).join('\n');
  for (const [re, label] of PHASE_MARKERS) {
    if (re.test(recent)) {
      phase = (phase ? phase + ' · ' : '') + label;
      phaseFrom = phaseFrom ? phaseFrom + ' + the worker\'s own narration' : 'the worker\'s own narration';
      break;
    }
  }

  /* ── sentences: each one traceable to a recorded fact ────────────────────── */
  const sentences = [];
  if (tick) {
    sentences.push('Tick ' + tick.number + ' has been running ' +
      (tick.elapsedMin != null ? Math.round(tick.elapsedMin) + ' minutes' : 'for an unknown time') +
      ' on ' + (tick.spec ? 'spec ' + tick.spec : 'no spec') +
      (tick.account ? ' via the ' + tick.account + ' account' : '') + '.');
  }
  if (real.length) {
    sentences.push('It has dispatched ' + plural(real.length, 'agent') +
      (shells.length ? ' and ' + plural(shells.length, 'background command') : '') + '. ' +
      (live.length ? plural(live.length, 'is', 'are') + ' still out' : 'All have returned') +
      (failed.length ? ', and ' + plural(failed.length, 'returned') + ' something other than success' : '') + '.');
  }
  for (const a of live.slice(0, 4)) {
    sentences.push(a.name + ' — ' + a.description + (a.lastActivity ? ': ' + a.lastActivity : '') +
      (a.lastActivityAt ? ' (' + ago(a.lastActivityAt, now) + ' ago)' : ''));
  }
  if (commitsThisTick.length) {
    sentences.push('It has landed ' + plural(commitsThisTick.length, 'commit') + ' this tick, most recently "' +
      String(commitsThisTick[0]).slice(0, 90) + '".');
  } else if (running) {
    sentences.push('Nothing has been committed in this tick yet.');
  }
  sentences.push(done.length + ' of ' + queue.length + ' catalog entries are signed off' +
    (owed.length
      ? ', and ' + plural(owed.length, 'spec') + ' (' + owed.map((e) => e.id).join(', ') + ') ' +
        (owed.length === 1 ? 'is' : 'are') + ' built but unverified — the loop cannot click a founder journey'
      : '') + '.');

  /* ── blockers: only things that actually stop progress ───────────────────── */
  const blockers = [];
  if (owed.length) {
    blockers.push({
      what: plural(owed.length, 'spec') + ' awaiting your click: ' + owed.map((e) => e.id).join(', '),
      why: 'The founder journey is the only exit-bar item the loop cannot perform, and the only detector that has caught the unreachable-screen class.',
    });
  }
  for (const a of failed) {
    blockers.push({ what: a.name + ' did not return cleanly', why: a.description });
  }
  for (const a of failedShells) {
    blockers.push({ what: 'a background command failed', why: a.description });
  }
  const stale = live.filter((a) => a.lastActivityAt && now - new Date(a.lastActivityAt).getTime() > 12 * 60_000);
  for (const a of stale) {
    blockers.push({ what: a.name + ' has been silent ' + ago(a.lastActivityAt, now), why: 'Last seen: ' + (a.lastActivity ?? 'no progress reported') });
  }

  return {
    headline,
    phase,
    phaseFrom,
    sentences,
    blockers,
    stats: {
      agents: real.length,
      agentsLive: live.length,
      commands: shells.length,
      commandsLive: liveShells.length,
      tokens: real.reduce((n, a) => n + (a.tokens ?? 0), 0),
      deepest: agents.reduce((d, a) => Math.max(d, a.depth), 0),
    },
    derivedFrom: 'the tick transcript, the queue and git — no model was asked',
  };
}
