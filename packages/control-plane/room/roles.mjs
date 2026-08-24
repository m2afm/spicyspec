/**
 * The three people you can talk to — spicyspec edition of the prototype's lib/roles.mjs.
 *
 * The loop has always had exactly one overseer: a supervisor program that starts workers and
 * records what they did. It has no voice — you read its log. And nothing audits IT. When it
 * marked 006 "built but unverified" having never started it, the only reason anyone found out
 * was that a checklist generator refused to invent steps for a spec it could not find.
 *
 * So three roles, each a real Claude Code session held open across turns:
 *
 *   supervisor  speaks for the loop. Knows its state files, answers what is happening and
 *               why, and can be told to pause, report or look at something.
 *   manager     audits the supervisor and the workers. Exists because a single overseer that
 *               grades its own homework is how 006 happened. Reads the same evidence and is
 *               instructed to disagree when the evidence says so.
 *   special     yours. Its mandate is a file you edit, for work that is neither supervising
 *               nor auditing.
 *
 * Each is a session, not a request. `claude --session-id <uuid>` opens one and `--resume`
 * continues it, which was verified before any of this was built: turn one was told to
 * remember 8317, turn two — a separate process — was asked what the number was and answered
 * 8317. Without that, "chat" would have meant a series of strangers.
 *
 * Two things worth knowing about the cost and the risk:
 *
 * COST. A first turn measured $0.42, because the session loads the full toolset before it
 * reads your message. This is not free and the UI says so per message rather than hiding it.
 *
 * PERMISSION. Supervisor and manager default to `plan` — they can read the repo and cannot
 * change it. That is deliberate: their job is to observe and to tell you, and an auditor that
 * can quietly fix what it is auditing is not an auditor. The special agent's mode is yours to
 * set, and the UI shows which mode each role is in rather than leaving you to assume.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const ROLE_IDS = ['supervisor', 'manager', 'special'];

/* ------------------------------------------------------------- mandates ---- */

const SHARED = [
  'You are one of three roles in the control room of an unattended build loop. The founder is',
  'talking to you directly through a dashboard. Answer them, do not narrate to a third party.',
  '',
  'Where the truth lives — read these rather than guessing, and cite what you read:',
  '  .spicyspec/runner.db            the store (SQLite): queue entries, run ledger, gate',
  '                                  verdicts and the account pool — the single writer is the',
  '                                  runner; query it read-only (e.g. node -e with node:sqlite)',
  '  .spicyspec/runs/<n>/            one directory per run: packet.md is the assignment,',
  '                                  stream.jsonl is what the worker actually did',
  '  .spicyspec/gates.jsonl          gate verdicts, machine-readable (the store\'s git export)',
  '  .spicyspec/PARKED.md            what only the founder can clear',
  '  specs/<id>-*/tasks.md           the task list whose checkboxes are the build\'s progress',
  '  HANDOFF-PACKAGE.md              the generated handoff brief, when one was written',
  '',
  'How to answer:',
  '- Short. The founder reads this in a side panel, not a document.',
  '- Every number you state must come from a file you actually opened this turn. If you did',
  '  not check, say you did not check.',
  '- "I do not know" is a complete answer. Guessing has cost this project real days.',
  '- If you are asked for something you cannot do, say which part and why, then do the rest.',
];

const MANDATES = {
  supervisor: [
    'YOU ARE THE SUPERVISOR of this build loop.',
    '',
    'You speak for the machinery: the runner process, the run it is executing, the queue it is',
    'working through, the accounts it rotates. When the founder asks what is happening, look',
    'at the newest run transcript under .spicyspec/runs/ and tell them what the worker is',
    'actually doing right now, not what it was assigned to do.',
    '',
    'You have been wrong before, in ways worth remembering. You once marked spec 006 as built',
    'and awaiting review when it had never been started, because a run assigned to it spent',
    'its 102 minutes finishing 005 and you stamped the outcome on whatever entry was active.',
    'You also retired 005 while its closing gate still had open findings, because its task',
    'checkboxes were all ticked. When the founder asks whether something is really done, that',
    'history is the reason to check rather than assume.',
    '',
    ...SHARED,
  ].join('\n'),

  manager: [
    'YOU ARE THE MANAGER. You audit the supervisor and the workers. You do not run the loop.',
    '',
    'You exist because one overseer grading its own homework is how spec 006 came to be marked',
    '"built but unverified" having never been started. Your job is to be the second pair of',
    'eyes that would have caught it.',
    '',
    'What you check, and how:',
    '- Does the run ledger agree with git? A run credited to one spec whose commits all name a',
    '  different one is the exact failure that cost 006. Compare the store\'s run rows against',
    '  `git log` for the same window.',
    '- Does a status match its evidence? "done" wants a signed-off tag. "awaiting-review"',
    '  wants a spec directory and commits. Check, do not accept.',
    '- Do the workers\' claims survive reading? A run that says a gate passed should have a',
    '  record in .spicyspec/gates.jsonl. Say so when it does not.',
    '- Is the machinery\'s own reasoning sound? Read the run packets and transcripts under',
    '  .spicyspec/runs/ and question the decisions, especially the ones that retired or',
    '  advanced a spec.',
    '',
    'Do not agree by default. An audit that always concludes "looks fine" is worth nothing,',
    'and the prototype has 45 recorded defects to prove things are not always fine. But do not',
    'manufacture a finding either — if the evidence is clean, say it is clean and say what you',
    'checked to know that.',
    '',
    'When you state a COUNT, print the command that produced it. Your first real audit was',
    'right about everything that mattered and said "15 commits" where the range holds 14 — a',
    'number you had genuinely derived from a command you ran, and then misreported. The finding',
    'survived the error, but the founder had to re-run the command to know which part to trust.',
    'A count with its command beside it is checkable in one paste; a count on its own is not.',
    '',
    ...SHARED,
  ].join('\n'),

  special: [
    'YOU ARE THE FOUNDER\'S OWN AGENT. Your mandate is whatever the file says it is.',
    '',
    'If .spicyspec/roles/special/mandate.md exists, that file is your brief and it',
    'overrides any default you might assume. Read it first, every session.',
    '',
    'With no mandate written yet, be a general assistant on this repository: answer questions',
    'about it, investigate what the founder asks about, and say plainly when something is',
    'outside what you can see or do.',
    '',
    ...SHARED,
  ].join('\n'),
};

export const ROLE_DEFS = {
  supervisor: {
    id: 'supervisor', name: 'Supervisor', tagline: 'speaks for the loop',
    // Read-only by default. Its job is to tell you what is happening; a supervisor that can
    // rewrite the state it reports on cannot be cross-checked by the manager.
    permissionMode: 'plan',
    watches: ['the store\'s queue and run ledger', 'the live run transcript', '.spicyspec/gates.jsonl'],
  },
  manager: {
    id: 'manager', name: 'Manager', tagline: 'audits the supervisor and the workers',
    // Read-only, and this one is not configurable in spirit: an auditor that can edit what it
    // audits is not an auditor.
    permissionMode: 'plan',
    watches: ['run rows vs git', 'queue vs its evidence', 'gates.jsonl', 'run transcripts'],
  },
  special: {
    id: 'special', name: 'My Special Agent', tagline: 'yours — mandate is a file you edit',
    permissionMode: 'plan',
    watches: ['whatever its mandate says'],
  },
};

/* ---------------------------------------------------------------- store ---- */

const roleDir = (stateDir, id) => join(stateDir, 'roles', id);

function ensureDir(stateDir, id) {
  const dir = roleDir(stateDir, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const readJson = (path, fallback) => {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback; } catch { return fallback; }
};

export function loadSession(stateDir, id) {
  const dir = ensureDir(stateDir, id);
  return readJson(join(dir, 'session.json'), { sessionId: null, turns: 0, createdAt: null, lastAt: null, costUsd: 0 });
}

function saveSession(stateDir, id, session) {
  writeFileSync(join(ensureDir(stateDir, id), 'session.json'), JSON.stringify(session, null, 1), 'utf8');
}

/** The transcript. Append-only, so a reply that crashes mid-write cannot erase the history. */
export function readMessages(stateDir, id, limit = 200) {
  const path = join(ensureDir(stateDir, id), 'messages.jsonl');
  if (!existsSync(path)) return [];
  const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  return rows.slice(-limit);
}

function appendMessage(stateDir, id, msg) {
  appendFileSync(join(ensureDir(stateDir, id), 'messages.jsonl'), JSON.stringify(msg) + '\n', 'utf8');
  return msg;
}

export function readTasks(stateDir, id) {
  const path = join(ensureDir(stateDir, id), 'tasks.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function addTask(stateDir, id, { text, scheduledFor = null }) {
  const task = {
    id: randomUUID().slice(0, 8),
    at: new Date().toISOString(),
    text: String(text ?? '').slice(0, 4000),
    scheduledFor: scheduledFor ?? null,
    status: scheduledFor ? 'scheduled' : 'queued',
  };
  appendFileSync(join(ensureDir(stateDir, id), 'tasks.jsonl'), JSON.stringify(task) + '\n', 'utf8');
  return task;
}

export function updateTask(stateDir, id, taskId, patch) {
  const tasks = readTasks(stateDir, id).map((t) => (t.id === taskId ? { ...t, ...patch, updatedAt: new Date().toISOString() } : t));
  writeFileSync(join(ensureDir(stateDir, id), 'tasks.jsonl'),
    tasks.map((t) => JSON.stringify(t)).join('\n') + (tasks.length ? '\n' : ''), 'utf8');
  return tasks.find((t) => t.id === taskId) ?? null;
}

/** The mandate file, for the special agent. Returns null when the role has no editable brief. */
export function readMandate(stateDir, id) {
  if (id !== 'special') return null;
  const path = join(ensureDir(stateDir, id), 'mandate.md');
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

export function writeMandate(stateDir, id, text) {
  if (id !== 'special') throw new Error('only the special agent has an editable mandate');
  writeFileSync(join(ensureDir(stateDir, id), 'mandate.md'), String(text ?? '').slice(0, 20_000), 'utf8');
}

/* ------------------------------------------------------------ speaking ---- */

/**
 * One in-flight turn per role, at most.
 *
 * A session cannot be resumed twice at once — two processes replaying the same conversation
 * would each write their own continuation and one would win silently. So a second message
 * while one is in flight is REFUSED with a reason, rather than queued behind a spinner or
 * dropped.
 */
const inFlight = new Map();

export const isBusy = (id) => inFlight.has(id);

/**
 * Send one message and stream what happens.
 *
 * `onEvent` receives the raw stream events as they arrive — tool calls, text, the final
 * result — so the caller can show the role working rather than a spinner. That live view is
 * the whole reason for stream-json here; the transcript could have been had from `--print`.
 *
 * `spawnFn` exists for the tests only: the storage, 409 and envelope-reading logic must be
 * provable without a real `claude` on PATH, and a mock of node:child_process cannot reach a
 * dynamically-imported vendored module.
 */
export function say({ stateDir, root, id, text, config, onEvent, spawnFn = spawn }) {
  if (!ROLE_IDS.includes(id)) throw new Error('unknown role: ' + id);
  if (inFlight.has(id)) {
    throw new Error(ROLE_DEFS[id].name + ' is still answering the previous message. ' +
      'A session cannot be resumed twice at once, so this one is refused rather than silently lost.');
  }

  const session = loadSession(stateDir, id);
  const def = ROLE_DEFS[id];
  const mandate = MANDATES[id] + (readMandate(stateDir, id) ? '\n\nYOUR MANDATE FILE SAYS:\n' + readMandate(stateDir, id) : '');

  const fresh = !session.sessionId;
  const sessionId = session.sessionId ?? randomUUID();

  const args = [
    '-p', text,
    fresh ? '--session-id' : '--resume', sessionId,
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', def.permissionMode,
    // Drop the founder's interactive hooks. A SessionStart hook once made a WORKER answer the
    // hook instead of doing its job for two whole ticks; a chat is even easier to derail.
    '--setting-sources', 'project,local',
    '--append-system-prompt', mandate,
  ];

  appendMessage(stateDir, id, { at: new Date().toISOString(), from: 'founder', text });

  return new Promise((resolve) => {
    // `bin` is what the runner config's worker section actually calls it. The fallback chain
    // is here rather than at the call site so every caller gets the same resolution.
    const child = spawnFn(config.bin ?? config.claudeBin ?? 'claude', args, {
      cwd: root, windowsHide: true, env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    inFlight.set(id, child);

    let buf = '';
    let reply = '';
    let cost = 0;
    let isError = false;
    const activity = [];
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }

        if (event.type === 'assistant') {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'text' && block.text) reply += block.text;
            if (block.type === 'tool_use') {
              const step = { at: new Date().toISOString(), tool: block.name, detail: describeInput(block) };
              activity.push(step);
              onEvent?.({ kind: 'doing', role: id, step });
            }
          }
          if (event.message?.content?.some((b) => b.type === 'text')) {
            onEvent?.({ kind: 'partial', role: id, text: reply });
          }
        }
        if (event.type === 'result') {
          cost = event.total_cost_usd ?? 0;
          isError = Boolean(event.is_error);
          if (!reply && typeof event.result === 'string') reply = event.result;
        }
      }
    });

    child.stderr.on('data', (c) => { stderr += c.toString('utf8').slice(0, 2000); });

    const finish = (failure) => {
      inFlight.delete(id);
      const at = new Date().toISOString();
      const message = {
        at, from: id, text: reply || failure || '(no reply)',
        costUsd: cost, activity: activity.slice(-40),
        error: failure ?? (isError ? 'the session reported an error' : null),
      };
      appendMessage(stateDir, id, message);
      saveSession(stateDir, id, {
        sessionId, turns: (session.turns ?? 0) + 1,
        createdAt: session.createdAt ?? at, lastAt: at,
        costUsd: Number(((session.costUsd ?? 0) + cost).toFixed(4)),
      });
      onEvent?.({ kind: 'done', role: id, message });
      resolve(message);
    };

    child.on('error', (err) => finish('could not start claude: ' + err.message));
    child.on('close', (code) => {
      // Exit code 0 does not mean success here — a refused account or a stream error also
      // exits 0, which is why the result envelope's is_error is read above rather than $?.
      if (!reply && code !== 0) return finish('claude exited ' + code + (stderr ? ': ' + stderr.split('\n')[0] : ''));
      finish(null);
    });
  });
}

/** A short label for what a tool call is doing, so the live view reads as work. */
function describeInput(block) {
  const i = block.input ?? {};
  const trim = (s, n = 110) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) + '…' : s) : '');
  switch (block.name) {
    case 'Bash': return trim(i.command);
    case 'Read': case 'Write': case 'Edit': return trim(i.file_path);
    case 'Grep': return trim(i.pattern) + (i.path ? ' in ' + trim(i.path, 50) : '');
    case 'Glob': return trim(i.pattern);
    case 'Agent': case 'Task': return trim(i.description);
    default: return trim(i.description || i.command || i.pattern || i.file_path || '');
  }
}

/** Everything the dashboard needs to draw the three cards. */
export function rolesSnapshot(stateDir) {
  return ROLE_IDS.map((id) => {
    const def = ROLE_DEFS[id];
    const session = loadSession(stateDir, id);
    const msgs = readMessages(stateDir, id, 6);
    const tasks = readTasks(stateDir, id);
    const last = [...msgs].reverse().find((m) => m.from === id) ?? null;
    return {
      ...def,
      busy: isBusy(id),
      turns: session.turns ?? 0,
      costUsd: session.costUsd ?? 0,
      lastAt: session.lastAt ?? null,
      started: Boolean(session.sessionId),
      hasMandate: Boolean(readMandate(stateDir, id)),
      openTasks: tasks.filter((t) => t.status === 'queued' || t.status === 'scheduled').length,
      lastSaid: last ? String(last.text).replace(/\s+/g, ' ').slice(0, 220) : null,
      lastActivity: last?.activity?.slice(-3) ?? [],
    };
  });
}
