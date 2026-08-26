/**
 * Control-room suite — real localhost socket, real store, real vendored room modules.
 *
 * Every test here is named after a founder-visible break the port shipped with: numbers that
 * only moved on the 15s poll, a Management tab starved of roles, an agent sheet that opened
 * empty, a "built" bar that was always zero because held tasks were counted as nothing, a
 * Kill button whose armed state never displayed.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, type Store } from '@spicyspec/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accountEventRows,
  budgetsFor,
  COMMIT_SEP,
  composeDigest,
  coverageOf,
  detectAnomalies,
  HEALTH_KEY,
  ledgerDigest,
  mergeGateRows,
  parseCommitLog,
  searchCorpus,
  STATE_PUSH_MS,
  statOf,
  windowStartOf,
  healthRows,
  INSTALL_HINT,
  KILL_KEY,
  parseArmedFlag,
  parseHealthEvents,
  recentHealthEvents,
  reviewCapOf,
  dirtyPathsFrom,
  specProgress,
  startControlRoom,
  STOP_KEY,
  supervisorHealth,
  topLine,
  type HealthEvent,
  type HealthRow,
  type SupervisorHealth,
  type RunningRoom,
} from './room-server.js';

/** The vendored page, read as text: the panel under test is plain JS with no build step. */
const ROOM_DIR = fileURLToPath(new URL('../../room/', import.meta.url));

let store: Store;
let room: RunningRoom;
let base: string;
let repo: string;
let stateDir: string;
let token: string;

const write = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
};

/** A run directory the pump will tail: fresh mtime, a meta.json, one assistant turn.
 *  Returns the stream path so a test can age it into the pump's stale window. */
function seedRun(spec: string, lines: unknown[], number = 1): string {
  const dir = join(repo, '.spicyspec', 'runs', String(number));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({ number, spec, stage: 'build', account: 'primary', startedAt: new Date().toISOString() }),
    'utf8',
  );
  const stream = join(dir, 'stream.jsonl');
  writeFileSync(stream, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return stream;
}

/** One pump interval plus slack for the read and the ingest. */
const onePump = () => new Promise((r) => setTimeout(r, 1400));

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'room-repo-'));
  stateDir = mkdtempSync(join(tmpdir(), 'room-state-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  } catch {
    /* git absent is survivable: the state's git block degrades to empty strings */
  }
  store = openStore(':memory:');
  await store.saveQueue({ entries: [{ id: '002', status: 'active', stage: 'build' }] });
  const configPath = join(repo, 'runner.json');
  writeFileSync(configPath, JSON.stringify({ worker: { bin: 'claude-does-not-exist' } }), 'utf8');
  room = await startControlRoom({
    store,
    projectName: 'Spicy',
    repoCwd: repo,
    stateDir,
    runnerBin: join(repo, 'no-such-cli.js'),
    configPath,
    accountIds: ['primary'],
  });
  base = `http://127.0.0.1:${room.port}`;
  const page = await (await fetch(base + '/')).text();
  token = /name="loop-token" content="([^"]+)"/.exec(page)?.[1] ?? '';
});

afterEach(async () => {
  await room.close();
  store.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

const post = (path: string, body: unknown, withToken = true) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(withToken ? { 'x-loop-token': token } : {}) },
    body: JSON.stringify(body),
  });

const state = async () => (await (await fetch(base + '/api/state')).json()) as Record<string, never>;

/* ------------------------------------------------------------- spec progress ---- */

describe('specProgress', () => {
  const TASKS = [
    '## Wave 1 · red first',
    '- [x] **T001** write the failing test',
    '- [X] T002 plain-id style, still a task',
    '- [ ] **T003** make it pass',
    '## Wave 2 · hardening',
    '- [ ] **T004** NOT CLOSED — the gate has open findings',
    '- **T005** an explanatory bullet, not a row: no checkbox, so not a task',
    '- [ ] **T006** last one',
    'Prose that merely mentions **T003** again must not count twice.',
    'A paragraph naming T009 is not a task line.',
  ].join('\n');

  it('classifies done, open and held separately — held:0 made the built bar always empty', () => {
    write(join(repo, 'specs', '002-x', 'tasks.md'), TASKS);
    const p = specProgress(repo, 'specs/002-x', '002');
    // T001+T002 done, T003+T006 open, T004 open WITH a stated blocker so it counts as held.
    // T005 carries an id but no checkbox, the repeated **T003** in prose is the same id, and
    // T009 sits in a paragraph: none of the three is a row, so the file holds five tasks.
    // The wave label stops at the '·' exactly as the terminal view's did.
    // deferred: 0 asserted deliberately — a fixture with no DEFERRED marker must defer nothing.
    expect(p).toEqual({ done: 2, open: 2, held: 1, deferred: 0, total: 5, deferredTotal: 5, waves: 2, currentWave: 'Wave 1' });
  });

  it('reports the wave holding the FIRST open task, not the last heading it read', () => {
    write(
      join(repo, 'specs', '002-x', 'tasks.md'),
      ['## Wave 1', '- [x] **T001** done', '## Wave 2', '- [ ] **T002** open', '## Wave 3', '- [x] **T003** done'].join('\n'),
    );
    expect(specProgress(repo, 'specs/002-x', '002')?.currentWave).toBe('Wave 2');
  });

  it('falls back to the last wave when nothing is open — a finished list has no current wave to point at', () => {
    write(join(repo, 'specs', '002-x', 'tasks.md'), ['## Wave 1', '- [x] **T001**', '## Wave 2', '- [x] **T002**'].join('\n'));
    expect(specProgress(repo, 'specs/002-x', '002')?.currentWave).toBe('Wave 2');
  });

  it("prefers the lane worktree's tasks.md — the main tree's copy is stale the moment a lane commits", () => {
    write(join(repo, 'specs', '002-x', 'tasks.md'), '- [ ] **T001** stale');
    write(join(repo, '.spicyspec', 'worktrees', '002', 'specs', '002-x', 'tasks.md'), '- [x] **T001** landed');
    expect(specProgress(repo, 'specs/002-x', '002')).toMatchObject({ done: 1, open: 0 });
  });

  it('returns null rather than zeroes when there is no task list — unknown is not "0 of 0"', () => {
    expect(specProgress(repo, 'specs/nope', '002')).toBeNull();
    expect(specProgress(repo, null)).toBeNull();
  });
});

/* -------------------------------------------------------------------- state ---- */

describe('room state', () => {
  it('reports armed stop and kill from the store flags — a Kill button that never shows armed reads as broken', async () => {
    expect(await state()).toMatchObject({ stopArmed: false, killArmed: false });
    await store.setKv(STOP_KEY, JSON.stringify({ armedAt: new Date().toISOString() }));
    await store.setKv(KILL_KEY, JSON.stringify({ armedAt: new Date().toISOString() }));
    expect(await state()).toMatchObject({ stopArmed: true, killArmed: true });
  });

  it('does not read the stop flags as runners — they share the runner: prefix', async () => {
    await store.setKv(STOP_KEY, JSON.stringify({ armedAt: new Date().toISOString() }));
    const s = await state();
    expect(s['running']).toBe(false);
    expect(s['driver']).toBeNull();
  });

  it('surfaces the runner\'s startedAt so uptime can show at all', async () => {
    await store.setKv(
      'runner:main',
      JSON.stringify({ pid: 4242, heartbeatAt: new Date().toISOString(), startedAt: '2026-08-24T09:00:00.000Z' }),
    );
    expect((await state())['driver']).toMatchObject({ pid: 4242, startedAt: '2026-08-24T09:00:00.000Z' });
  });

  it('flags a spec that retired on an empty task list with no closing-gate APPROVE', async () => {
    await store.saveQueue({ entries: [{ id: '002', status: 'awaiting-review', stage: 'handoff' }] });
    write(join(repo, 'specs', '002-x', 'tasks.md'), '- [x] **T001** done');
    const withoutRecord = (await state())['catalog'] as unknown as { entries: Array<Record<string, unknown>> };
    expect(withoutRecord.entries[0]).toMatchObject({ closingGate: 'unknown', closingGateWarning: true });

    await store.appendGate({ at: new Date().toISOString(), spec: '002', gate: 'closing', verdict: 'APPROVE' });
    const approved = (await state())['catalog'] as unknown as { entries: Array<Record<string, unknown>> };
    expect(approved.entries[0]).toMatchObject({ closingGate: 'approved', closingGateWarning: false });
  });

  it('reads the LATEST closing verdict, not any APPROVE ever recorded', async () => {
    await store.saveQueue({ entries: [{ id: '002', status: 'awaiting-review', stage: 'handoff' }] });
    write(join(repo, 'specs', '002-x', 'tasks.md'), '- [x] **T001** done');
    await store.appendGate({ at: '2026-08-01T00:00:00.000Z', spec: '002', gate: 'closing', verdict: 'APPROVE' });
    await store.appendGate({ at: '2026-08-02T00:00:00.000Z', spec: '002', gate: 'closing', verdict: 'REVISE' });
    const c = (await state())['catalog'] as unknown as { entries: Array<Record<string, unknown>> };
    expect(c.entries[0]).toMatchObject({ closingGate: 'open', closingGateWarning: true });
  });

  it('lists PARKED.md headings and names a parked spec that had no diagnosis written', async () => {
    await store.saveQueue({ entries: [{ id: '002', status: 'parked', stage: 'build' }, { id: '003', status: 'parked', stage: 'build' }] });
    write(join(repo, '.spicyspec', 'PARKED.md'), ['# Parked', '', '## 2026-08-20 · 002 needs a founder decision on pricing', 'why: money', ''].join('\n'));
    const parked = (await state())['parked'] as unknown as string[];
    expect(parked[0]).toContain('002 needs a founder decision');
    expect(parked.some((p) => p.startsWith('003 —') && p.includes('no diagnosis'))).toBe(true);
  });

  it('counts verification commands only — every Bash call counted made 30 greps read as 30 verifications', async () => {
    seedRun('002', [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'grep -rn foo .' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'pnpm nx test control-plane' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'npx vitest run' } }] } },
    ]);
    await onePump();
    const lanes = (await state())['lanes'] as unknown as Array<Record<string, unknown>>;
    expect(lanes[0]).toMatchObject({ tools: 3, verification: 2 });
  }, 10_000);

  it('counts a PowerShell verification too — the Bash-only gate read every PowerShell test run as zero', async () => {
    seedRun('002', [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p1', name: 'PowerShell', input: { command: 'pnpm nx test control-plane' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p2', name: 'PowerShell', input: { command: 'Get-ChildItem -Recurse' } }] } },
    ]);
    await onePump();
    const lanes = (await state())['lanes'] as unknown as Array<Record<string, unknown>>;
    expect(lanes[0]).toMatchObject({ tools: 2, verification: 1 });
  }, 10_000);

  it('reports the rate window from rateResetsAt in seconds without multiplying a millisecond value', async () => {
    const resetsAt = Math.floor(Date.parse('2026-08-24T18:00:00.000Z') / 1000);
    await store.appendRun({ tick: 1, account: 'primary', exit: 'clean', rateStatus: 'allowed_warning', utilization: 0.93, rateResetsAt: resetsAt });
    const seconds = ((await state())['accounts'] as unknown as Array<Record<string, unknown>>)[0];
    expect(seconds).toMatchObject({ rateStatus: 'allowed_warning', utilization: 0.93, windowEndsAt: resetsAt * 1000 });

    await store.appendRun({ tick: 2, account: 'primary', exit: 'clean', rateResetsAt: resetsAt * 1000 });
    const millis = ((await state())['accounts'] as unknown as Array<Record<string, unknown>>)[0];
    expect(millis['windowEndsAt']).toBe(resetsAt * 1000);
  });

  it('lights up the founder numbers the engine persists on a run row: minutes, dur, head and redFirst', async () => {
    await store.appendRun({
      tick: 1,
      account: 'primary',
      exit: 'clean',
      durationMinutes: 12.4,
      head: 'abc1234',
      startedAt: '2026-08-24T09:00:00.000Z',
      tasksClosed: 3,
      costUsd: 1.5,
      redFirstResidue: [{ file: 'a.spec.ts', marker: 'it.skip' }],
    });
    await store.appendRun({ tick: 2, account: 'primary', exit: 'clean', durationMinutes: 5 });
    const s = await state();
    expect(s['totals']).toMatchObject({ minutes: 17, closed: 3, rows: 2, ticks: 2 });
    const ticks = s['ticks'] as unknown as Array<Record<string, unknown>>;
    const first = ticks.find((t) => t['tick'] === 1);
    expect(first).toMatchObject({ minutes: 12, head: 'abc1234', startedAt: '2026-08-24T09:00:00.000Z' });
    expect(first?.['redFirst']).toEqual([{ file: 'a.spec.ts', marker: 'it.skip' }]);
    // Absence is unknown, never clean — the column renders '—' only for null.
    expect(ticks.find((t) => t['tick'] === 2)?.['redFirst']).toBeNull();
  });
});

/* --------------------------------------------------------------------- feed ---- */

describe('live feed', () => {
  it('pushes state over SSE without waiting for the page poll — the 15s poll was the only thing moving the numbers', async () => {
    const res = await fetch(base + '/api/live');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let seen = '';
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && !seen.includes('event: state')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    expect(seen).toContain('event: hello');
    expect(seen).toContain('event: state');
  }, 20_000);

  it('carries the derived narrative in hello and over the where event', async () => {
    const where = (await (await fetch(base + '/api/where')).json()) as Record<string, unknown>;
    expect(typeof where['headline']).toBe('string');
    expect(Array.isArray(where['sentences'])).toBe(true);
    expect(Array.isArray(where['blockers'])).toBe(true);
    expect(where['derivedFrom']).toContain('no model was asked');
  });

  it('returns the full agent record for the sheet, and 404 for an id no lane knows', async () => {
    seedRun('002', [
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 't1',
        tool_use_id: 'u1',
        task_type: 'local_agent',
        subagent_type: 'qa-critic',
        description: 'review the diff',
        prompt: 'Read the diff and report findings.',
      },
    ]);
    await onePump();
    const hello = (await (await fetch(base + '/api/agents')).json()) as { agents: Array<{ id: string }> };
    const child = hello.agents.find((a) => a.id.endsWith('t1'));
    expect(child, 'the pump must register a task_started agent').toBeTruthy();
    const detail = (await (await fetch(base + '/api/agent?id=' + encodeURIComponent(child!.id))).json()) as Record<string, unknown>;
    expect(detail['prompt']).toContain('Read the diff');
    expect(detail['id']).toBe(child!.id);
    expect((await fetch(base + '/api/agent?id=002%C2%B7nope')).status).toBe(404);
  }, 10_000);

  it('still opens the sheet for a lane the pump has reaped — the History list survives the reap and its rows 404d', async () => {
    const stream = seedRun('002', [
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 't9',
        tool_use_id: 'u9',
        task_type: 'local_agent',
        subagent_type: 'qa-critic',
        description: 'review the diff',
        prompt: 'Read the diff and report findings.',
      },
      { type: 'session_end' },
    ]);
    await onePump();
    const hello = (await (await fetch(base + '/api/agents')).json()) as { agents: Array<{ id: string }> };
    const id = hello.agents.find((a) => a.id.endsWith('t9'))?.id;
    expect(id, 'the pump must register the agent while the lane is live').toBeTruthy();

    // Age the stream past LANE_FRESH_MS: the ended lane is now stale, which is what reaps it.
    const old = new Date(Date.now() - 30 * 60_000);
    utimesSync(stream, old, old);
    await onePump();

    const after = (await (await fetch(base + '/api/agents')).json()) as { agents: Array<{ id: string }> };
    expect(after.agents.some((a) => a.id === id), 'the tail must really have been reaped').toBe(false);
    const sheet = await fetch(base + '/api/agent?id=' + encodeURIComponent(id!));
    expect(sheet.status).toBe(200);
    expect(((await sheet.json()) as Record<string, unknown>)['prompt']).toContain('Read the diff');
  }, 15_000);
});

/* ----------------------------------------------------------------- controls ---- */

describe('controls', () => {
  it('arms the durable stop flag and promises pause-after-tick, not a kill, when the halt CLI cannot be reached', async () => {
    const res = (await (await post('/api/action/stop', {})).json()) as { ok: boolean; message: string };
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/^stop armed — the run in flight finishes and settles/);
    expect(res.message).toContain('halt CLI unreachable');
    expect(await store.getKv(STOP_KEY)).toBeTruthy();
    expect(await state()).toMatchObject({ stopArmed: true });
  }, 40_000);

  it('says the kill flag stays armed when there is no live runner — silence there reads as a disarm', async () => {
    const res = (await (await post('/api/action/kill', {})).json()) as { ok: boolean; message: string };
    expect(res.message).toContain('kill-now armed — the live session is interrupted and the rotation opens nothing further');
    expect(res.message).toContain('no live runner to kill');
    expect(res.message).toContain('Clear stop');
    expect(await store.getKv(KILL_KEY)).toBeTruthy();
    expect(await state()).toMatchObject({ killArmed: true });
  }, 40_000);

  it('resume disarms both flags and does not claim to have restarted anything', async () => {
    await store.setKv(STOP_KEY, JSON.stringify({ armedAt: new Date().toISOString() }));
    await store.setKv(KILL_KEY, JSON.stringify({ armedAt: new Date().toISOString() }));
    const res = (await (await post('/api/action/resume', {})).json()) as { ok: boolean; message: string };
    expect(res.message).toContain('disarmed');
    expect(res.message).toContain('START dispatches the rotation');
    expect(await store.getKv(STOP_KEY)).toBeNull();
    expect(await store.getKv(KILL_KEY)).toBeNull();
    expect(await state()).toMatchObject({ stopArmed: false, killArmed: false });
  });

  it("frames a single lane the way the prototype did — '1 lane' was a multi-lane frame worn by one lane", async () => {
    const page = await (await fetch(base + '/')).text();
    expect(page).toContain("sub: 'tick ' + all[0].id");
    expect(page).not.toContain("' lane' : ' lanes'");
  });

  it('the header chip says armed, not acting, while nothing is running — a flag is not an event', async () => {
    // The distinction survives; only its author moved. The page no longer derives the chip at
    // all — it renders the server's top line, which knows the difference between a flag armed
    // over a live lane (STOPPING / KILLING) and one armed over an empty rotation (IDLE).
    await store.setKv(STOP_KEY, JSON.stringify({ armedAt: new Date().toISOString(), armedBy: 'founder' }));
    await store.setKv('runner:main', JSON.stringify({ pid: 7, heartbeatAt: new Date().toISOString() }));
    const armed = (await state()) as unknown as { activity: { state: string; reason: string } };
    expect(armed.activity.state).toBe('IDLE');
    expect(armed.activity.reason).toContain('stop armed by founder');
    const page = await (await fetch(base + '/')).text();
    expect(page).toContain('const top = s.activity');
    expect(page).not.toContain("s.running ? 'stopping after tick' : 'stop armed'");
  });
});

/* -------------------------------------------------------------------- roles ---- */

describe('roles', () => {
  it('serves the three cards the Management tab draws', async () => {
    const body = (await (await fetch(base + '/api/roles')).json()) as { roles: Array<{ id: string; name: string }> };
    expect(body.roles.map((r) => r.id)).toEqual(['supervisor', 'manager', 'special']);
    expect(body.roles.every((r) => typeof r.name === 'string')).toBe(true);
  });

  it('serves one role with its transcript, tasks and mandate — and 404s an unknown id', async () => {
    const body = (await (await fetch(base + '/api/role?id=manager')).json()) as Record<string, unknown>;
    expect(body['id']).toBe('manager');
    expect(body['messages']).toEqual([]);
    expect(body['tasks']).toEqual([]);
    expect(body['busy']).toBe(false);
    expect((await fetch(base + '/api/role?id=nobody')).status).toBe(404);
  });

  it('refuses a role POST without the control token', async () => {
    expect((await post('/api/role/task', { id: 'manager', text: 'x' }, false)).status).toBe(403);
  });

  it('queues a task and closes it, both broadcast as role events', async () => {
    const added = (await (await post('/api/role/task', { id: 'manager', text: 'check the ledger against git' })).json()) as {
      ok: boolean;
      task: { id: string; status: string };
    };
    expect(added).toMatchObject({ ok: true, task: { status: 'queued' } });
    const closed = (await (await post('/api/role/task-status', { id: 'manager', taskId: added.task.id, status: 'done' })).json()) as {
      task: { status: string };
    };
    expect(closed.task.status).toBe('done');
    const after = (await (await fetch(base + '/api/role?id=manager')).json()) as { tasks: Array<{ status: string }> };
    expect(after.tasks).toEqual([expect.objectContaining({ status: 'done' })]);
    expect((await post('/api/role/task-status', { id: 'manager', taskId: 'nope', status: 'done' })).status).toBe(404);
  });

  it('only the special agent has an editable mandate', async () => {
    const ok = await post('/api/role/mandate', { id: 'special', text: 'Watch the money.' });
    expect(ok.status).toBe(200);
    expect(((await (await fetch(base + '/api/role?id=special')).json()) as Record<string, unknown>)['mandate']).toBe('Watch the money.');
    const refused = await post('/api/role/mandate', { id: 'supervisor', text: 'be nice' });
    expect(refused.status).toBe(400);
  });

  it('refuses an empty message rather than spending a turn on it', async () => {
    expect((await post('/api/role/say', { id: 'supervisor', text: '   ' })).status).toBe(400);
  });

  it('accepts a message with 202 and reports the failure over the feed when the binary is absent', async () => {
    const res = await post('/api/role/say', { id: 'supervisor', text: 'what is happening?' });
    expect(res.status).toBe(202);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ ok: true, streaming: true });
    // The spawn fails (no such binary), so the turn resolves as a recorded failure message
    // rather than hanging — a founder must never watch a spinner that will not end.
    for (let i = 0; i < 40; i += 1) {
      const detail = (await (await fetch(base + '/api/role?id=supervisor')).json()) as { messages: Array<{ from: string; error: string | null }> };
      if (detail.messages.some((m) => m.from === 'supervisor')) {
        expect(detail.messages[0].from).toBe('founder');
        expect(detail.messages[1].error).toContain('claude');
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the turn never resolved');
  }, 15_000);
});

/* ------------------------------------------------------------------ self-healing ---- */

/**
 * The overnight incident, in tests. The founder left the loop running and found it dead for
 * ~8 hours: a STOP flag armed by an AGENT was never cleared, the rotation workflow was
 * CANCELED, and nothing supervised the processes — while the room's header said RUNNING and
 * LIVE FEED the whole time, because both chips described PROCESSES and neither described
 * PROGRESS. Every test below is named after one half of that lie.
 */
describe('supervisor report', () => {
  const EVENTS: HealthEvent[] = [
    { at: '2026-08-25T01:00:00.000Z', check: 'temporal', status: 'ok' },
    { at: '2026-08-25T01:00:01.000Z', check: 'rotation', status: 'failed', detail: 'workflow CANCELED' },
    { at: '2026-08-25T01:00:02.000Z', check: 'worker', status: 'failed', detail: 'no heartbeat for 41m' },
    { at: '2026-08-25T01:05:00.000Z', check: 'worker', status: 'repaired', detail: 'restarted spicyspec-runner start' },
    { at: '2026-08-25T01:06:00.000Z', check: 'worker', status: 'ok' },
    { at: '2026-08-25T01:06:01.000Z', check: 'stop-flags', status: 'blocked', detail: 'stop armed by founder — left alone' },
  ];
  const byCheck = (rows: HealthRow[], check: string) => rows.find((r) => r.check === check) as HealthRow;

  it('renders a row for every supervised check even when the supervisor has said nothing', () => {
    // A missing row says nothing at all; "not reported" is the single most useful thing this
    // panel can say, which is why the empty case still produces the full roster.
    const rows = healthRows([]);
    expect(rows.map((r) => r.label)).toEqual(['Temporal', 'Worker heartbeat', 'Rotation', 'Dashboard', 'Stop flags', 'Account leases']);
    expect(rows.every((r) => r.status === 'unknown' && r.checkedAt === null && r.lastRepairAt === null)).toBe(true);
  });

  it('takes the newest report per check and keeps the last repair with its timestamp', () => {
    const rows = healthRows(EVENTS);
    // The worker failed, was repaired, and is now ok. All three facts survive: the CURRENT
    // state is ok, and the repair that produced it is still on the row with its time.
    expect(byCheck(rows, 'worker')).toMatchObject({
      status: 'ok',
      checkedAt: '2026-08-25T01:06:00.000Z',
      lastRepairAt: '2026-08-25T01:05:00.000Z',
      lastRepairDetail: 'restarted spicyspec-runner start',
    });
    expect(byCheck(rows, 'rotation')).toMatchObject({ status: 'failed', detail: 'workflow CANCELED' });
    expect(byCheck(rows, 'stop-flags')).toMatchObject({ status: 'blocked' });
    expect(byCheck(rows, 'dashboard')).toMatchObject({ status: 'unknown', reported: null });
  });

  it('keeps the word the supervisor actually used, and appends checks nobody thought to name', () => {
    const rows = healthRows([{ at: '2026-08-25T01:00:00.000Z', check: 'disk', status: 'wedged', detail: 'C: 99% full' }]);
    const disk = byCheck(rows, 'disk');
    // 'wedged' is not one of the five states this panel can colour — it is still shown
    // verbatim, because a status the room refuses to render is a status nobody watches.
    expect(disk).toMatchObject({ label: 'Disk', status: 'unknown', reported: 'wedged', detail: 'C: 99% full' });
    expect(rows.slice(0, 6).map((r) => r.check)).toEqual(['temporal', 'worker', 'rotation', 'dashboard', 'stop-flags', 'accounts']);
  });

  it('accepts every shape the supervisor might have written, and no shape it did not', () => {
    const one = { at: '2026-08-25T01:00:00.000Z', check: 'temporal', status: 'ok' };
    expect(parseHealthEvents(JSON.stringify([one]))).toHaveLength(1);
    expect(parseHealthEvents(JSON.stringify({ events: [one, one] }))).toHaveLength(2);
    expect(parseHealthEvents(JSON.stringify(one))).toHaveLength(1);
    expect(parseHealthEvents([JSON.stringify(one), 'not json', JSON.stringify(one)].join('\n'))).toHaveLength(2);
    expect(parseHealthEvents('{oh no')).toEqual([]);
    expect(parseHealthEvents(null)).toEqual([]);
    expect(parseHealthEvents('')).toEqual([]);
  });

  it('calls the supervisor silent after its own interval and names the command that installs it', () => {
    const now = Date.parse('2026-08-25T02:00:00.000Z');
    const fresh = supervisorHealth([], JSON.stringify({ at: '2026-08-25T01:59:00.000Z', intervalMs: 60_000 }), now);
    expect(fresh).toMatchObject({ reporting: true, advice: null });

    // Three missed beats is a dead supervisor, not a slow disk.
    const stale = supervisorHealth([], JSON.stringify({ at: '2026-08-25T01:50:00.000Z', intervalMs: 60_000 }), now);
    expect(stale.reporting).toBe(false);
    expect(stale.advice).toContain('spicyspec-runner install-autostart');

    // No record at all is the case that mattered: nothing was installed, so nothing wrote.
    const absent = supervisorHealth([], null, now);
    expect(absent).toMatchObject({ reporting: false, lastAt: null });
    expect(absent.advice).toBe(INSTALL_HINT);

    // An event is proof the supervisor ran, even with no heartbeat record of its own.
    expect(supervisorHealth([{ at: '2026-08-25T01:59:30.000Z', check: 'temporal', status: 'ok' }], null, now).reporting).toBe(true);
  });

  it("speaks the supervisor's own check names — 'leases' is the accounts row, 'lock' is its own", () => {
    // runner health.ts HealthCheck: lock | temporal | worker | rotation | stop-flags | leases
    // | dashboard. Six of those are the founder's roster; the two spellings that differ must
    // still land somewhere a founder can read.
    const rows = healthRows([
      { at: '2026-08-25T01:00:00.000Z', check: 'leases', status: 'repaired', detail: 'released a stale lease' },
      { at: '2026-08-25T01:00:01.000Z', check: 'lock', status: 'ok' },
    ]);
    expect(rows.find((r) => r.label === 'Account leases')).toMatchObject({ status: 'repaired' });
    expect(rows.find((r) => r.check === 'lock')).toMatchObject({ label: 'Supervisor lock', status: 'ok' });
  });

  it('narrates a repair once, though the supervisor deliberately records it in two keys', async () => {
    // The failures ring holds what went wrong; the cycle document holds the whole picture,
    // ok checks included — so every repair exists in both, and the room reads both.
    const repair: HealthEvent = { at: new Date().toISOString(), check: 'worker', status: 'repaired', detail: 'restarted the worker' };
    const ok: HealthEvent = { at: new Date().toISOString(), check: 'temporal', status: 'ok' };
    await store.setKv(HEALTH_KEY, JSON.stringify([repair]));
    await store.setKv('health:last-cycle', JSON.stringify({ at: repair.at, healthy: false, events: [repair, ok] }));

    const s = (await state()) as unknown as { health: { rows: HealthRow[]; events: HealthEvent[] } };
    expect(s.health.events.filter((e) => e.status === 'repaired')).toHaveLength(1);
    // The cycle document is also what makes GREEN rows possible: the ring never carries them.
    expect(s.health.rows.find((r) => r.check === 'temporal')).toMatchObject({ status: 'ok' });
    expect(s.health.rows.find((r) => r.check === 'worker')).toMatchObject({ status: 'repaired', lastRepairDetail: 'restarted the worker' });
  });

  it('serves the report over /api/state, and says "not reporting" rather than crashing without one', async () => {
    const empty = (await state()) as unknown as { health: { supervisor: { reporting: boolean; advice: string }; rows: HealthRow[] } };
    expect(empty.health.supervisor.reporting).toBe(false);
    expect(empty.health.supervisor.advice).toBe(INSTALL_HINT);
    expect(empty.health.rows).toHaveLength(6);

    await store.setKv(HEALTH_KEY, JSON.stringify(EVENTS.map((e) => ({ ...e, at: new Date().toISOString() }))));
    const seeded = (await state()) as unknown as { health: { supervisor: { reporting: boolean }; rows: HealthRow[]; events: HealthEvent[] } };
    expect(seeded.health.supervisor.reporting).toBe(true);
    expect(seeded.health.rows.find((r) => r.check === 'rotation')).toMatchObject({ status: 'failed', detail: 'workflow CANCELED' });
    expect(seeded.health.events.length).toBe(EVENTS.length);
  });
});

/* --------------------------------------------------------------- health panel ---- */

/**
 * The panel itself, evaluated out of room/app.html with a stub `h`. The page is plain JS with
 * no build step, so this is the only way to prove the markup a founder sees is produced from
 * the report rather than from hope — and it fails loudly if the panel is renamed away.
 *
 * The only input to `new Function` is this package's own vendored page, read off disk at test
 * time; nothing here evaluates a value that came from a store, a request or a user.
 */
type Node = { type: unknown; props: Record<string, unknown> | null; children: unknown[] };

/** Cut a named block out of the vendored page. Fails loudly if the block is renamed away. */
function pageSlicer(): (from: string, to: string) => string {
  const page = readFileSync(join(ROOM_DIR, 'app.html'), 'utf8');
  return (from: string, to: string): string => {
    const a = page.indexOf(from);
    const b = page.indexOf(to, a + from.length);
    if (a < 0 || b < 0) throw new Error(`app.html no longer contains ${from}`);
    return page.slice(a, b);
  };
}

/**
 * The page's OWN React, loaded out of the vendored UMD bundle. There is no `react` package in
 * this workspace and no npm install is allowed here, so the only real React available to a test
 * is the same file the browser gets — which is the point: the error boundary below is exercised
 * against the actual `React.Component` the room runs on, not a stand-in.
 */
type VendoredReact = {
  version: string;
  Fragment: unknown;
  Component: new (props: unknown) => unknown;
  createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => Node;
};

function loadVendoredReact(): VendoredReact {
  const src = readFileSync(join(ROOM_DIR, 'react.production.min.js'), 'utf8');
  const mod = { exports: {} as Record<string, unknown> };
  new Function('module', 'exports', src)(mod, mod.exports);
  return mod.exports as unknown as VendoredReact;
}

function loadHealthPanel(): (props: { health: unknown }) => Node {
  const slice = pageSlicer();
  const src = [
    slice('const ago = (iso) => {', '\nconst clock'),
    // Panel hands its body to the boundary, so the boundary has to come with it.
    slice('class PanelBoundary extends React.Component {', '\nfunction Panel'),
    slice('function Panel({ title, sub, alert, children }) {', '\nfunction Stat'),
    slice('const HEALTH_TAG = {', '\n/* The body of one lane:'),
    'return Health;',
  ].join('\n');
  const h = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({ type, props, children });
  return new Function('h', 'React', src)(h, loadVendoredReact()) as (props: { health: unknown }) => Node;
}

/** Every string anywhere in the tree — what the founder would read off the panel. */
function text(node: unknown, out: string[] = []): string[] {
  if (node == null || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) text(n, out); return out; }
  const n = node as Node;
  if (n.props) for (const v of Object.values(n.props)) if (typeof v === 'string') out.push(v);
  text(n.children, out);
  return out;
}

describe('health panel', () => {
  const Health = loadHealthPanel();
  const now = Date.now();
  // Stamped at CALL time, not at suite-load time: the panel formats against the real clock,
  // so a fixture anchored when the file loaded drifts to "31m ago" as soon as the suite ahead
  // of it takes a minute — green alone, red in a full run.
  const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

  it('says nobody is watching when the report is missing entirely', () => {
    // An older server, or a store that could not answer. Silence must read as silence.
    expect(text(Health({ health: null })).join(' ')).toContain('no supervisor reporting');
  });

  it('carries a header chip for a silent supervisor — an unwatched loop must not look watched', async () => {
    const page = await (await fetch(base + '/')).text();
    // The GUARANTEE, not the widget: a supervisor that is not reporting must reach the
    // header, because a loop nobody watches must never look watched. This was written
    // against a fixed 'SUPV' annunciator slot that shipped in a deck redesign and was
    // reverted when that build blanked the page; the guarantee survived the revert in the
    // form of a header chip, so the test follows the guarantee rather than the widget.
    // THE GUARANTEE, not the widget. A supervisor that is not reporting must reach the
    // header, because a loop nobody watches must never look watched. Two shells have
    // carried it — a header chip in the scrolling layout, a fixed SUPV annunciator in the
    // deck — and the layout has already been reverted and restored once. Assert that the
    // state is derived and that SOME header element is driven by it; pinning the widget
    // made this test fail on a change that never touched the guarantee.
    expect(page).toContain('!s.health.supervisor.reporting');
    const surfaced =
      /unsupervised && h\('span', \{ className: 'chip warn' \}/.test(page) ||
      /id: 'SUPV', level: supBad \? 'alarm' : 'nominal'/.test(page);
    expect(surfaced).toBe(true);
  });

  it('renders the full roster and the install command when the supervisor has never reported', () => {
    const health = { supervisor: supervisorHealth([], null, now), rows: healthRows([]), events: [] };
    const said = text(Health({ health })).join(' | ');
    for (const label of ['Temporal', 'Worker heartbeat', 'Rotation', 'Dashboard', 'Stop flags', 'Account leases']) {
      expect(said).toContain(label);
    }
    expect(said).toContain('not reported');
    expect(said).toContain('never checked');
    expect(said).toContain('spicyspec-runner install-autostart');
  });

  it('shows each check, its state, when it was checked, and the last repair with its time', () => {
    const events: HealthEvent[] = [
      { at: iso(2), check: 'temporal', status: 'ok' },
      { at: iso(3), check: 'rotation', status: 'failed', detail: 'workflow CANCELED' },
      { at: iso(30), check: 'worker', status: 'repaired', detail: 'restarted the worker' },
      { at: iso(29), check: 'worker', status: 'ok' },
    ];
    const health = { supervisor: supervisorHealth(events, null, now), rows: healthRows(events), events: recentHealthEvents(events) };
    const said = text(Health({ health })).join(' | ');
    expect(said).toContain('workflow CANCELED');
    expect(said).toContain('restarted the worker');
    expect(said).toMatch(/repaired 30m ago/);
    expect(said).toContain('checked 3m ago');
    // A failed check wears the page's red, the same class Accounts uses for a cold account.
    expect(said).toContain('tag hot');
    expect(said).not.toContain('spicyspec-runner install-autostart');
  });
});

/* ------------------------------------------------------------- panel boundary ---- */

/**
 * THE GUARANTEE THIS SECTION DEFENDS: one bad call may cost the founder one panel, and may
 * never cost them the page.
 *
 * It has cost them the page twice — `metrics.burn()` read as a number when it returns a Fact,
 * `charts.sparkPath()` called positionally when it takes (values, opts) and returns an object.
 * Both threw inside render; nothing caught them; React unmounted the whole tree and the room
 * went blank while an unattended build kept running behind it.
 *
 * `react-dom` cannot run in this suite — there is no DOM and no npm install — so the rule React
 * applies is modelled by `renderTree` below in the smallest honest form: a throw travels up to
 * the nearest ancestor declaring `getDerivedStateFromError`, that ancestor renders its fallback,
 * and NOTHING outside it is touched. The half of the contract that is actually ours, and that
 * these tests pin, is the tree shape: that such an ancestor sits between every panel and its
 * siblings, and that the fallback names the panel and says the rest of the room is still live.
 * The empirical half was measured against the running room and is recorded in the commit.
 */
type Boundary = {
  PanelBoundary: (new (props: Record<string, unknown>) => { state: unknown; render: () => Node; componentDidCatch?: (e: unknown, i: unknown) => void }) & {
    getDerivedStateFromError: (err: unknown) => unknown;
  };
  guard: (name: string, node: unknown, zone?: string) => unknown;
  Panel: (props: Record<string, unknown>) => Node;
};

function loadBoundary(React: VendoredReact): Boundary {
  const slice = pageSlicer();
  const src = [
    slice('class PanelBoundary extends React.Component {', '\nfunction Panel'),
    slice('function Panel({ title, sub, alert, children }) {', '\nfunction Stat'),
    'return { PanelBoundary, guard, Panel };',
  ].join('\n');
  return new Function('h', 'React', src)(React.createElement, React) as Boundary;
}

/** The reconciler's one rule, in the smallest form that can be checked without a DOM. */
function renderTree(node: unknown): unknown {
  if (node == null || node === false || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(renderTree);
  const el = node as Node & { props: Record<string, unknown> };
  const type = el.type as (new (p: unknown) => { state: unknown; render: () => Node; componentDidCatch?: (e: unknown, i: unknown) => void }) &
    ((p: unknown) => Node) & { getDerivedStateFromError?: (err: unknown) => unknown; prototype?: { isReactComponent?: unknown } };

  if (typeof type === 'function') {
    if (typeof type.getDerivedStateFromError === 'function') {
      const inst = new type(el.props);
      try {
        return renderTree(inst.render());
      } catch (err) {
        inst.state = type.getDerivedStateFromError(err);
        inst.componentDidCatch?.(err, { componentStack: '(test)' });
        return renderTree(inst.render());
      }
    }
    if (type.prototype && type.prototype.isReactComponent) return renderTree(new type(el.props).render());
    return renderTree(type(el.props));
  }
  const kids = el.props ? el.props['children'] : undefined;
  return { type: el.type, props: el.props, children: renderTree(kids === undefined ? [] : Array.isArray(kids) ? kids : [kids]) };
}

describe('panel boundary', () => {
  const React = loadVendoredReact();
  const { PanelBoundary, guard, Panel } = loadBoundary(React);
  const h = React.createElement;
  const Good = (p: Record<string, unknown>) => h('p', null, p['label']);
  /** The exact shape of both blankings: a module return read as something it is not. */
  const Burn = () => {
    const fromModule = undefined as unknown as { perTask: string };
    return h('p', null, fromModule.perTask);
  };

  it('a throwing panel does not take its siblings down with it', () => {
    const deck = h('div', { className: 'deckwrap' },
      guard('Act column', h(Good, { label: 'owed by you' }), 'deckcol act'),
      guard('Burn', h(Burn, {}), 'pfd-cell'),
      guard('Record column', h(Good, { label: 'the wire' }), 'deckcol record'));

    const said = text(renderTree(deck)).join(' | ');
    // The two that did not throw are still on the page — this is the whole point.
    expect(said).toContain('owed by you');
    expect(said).toContain('the wire');
    // And the one that did threw into a card rather than into the void.
    expect(said).toContain('failed to draw');
    expect(said).toContain("Cannot read properties of undefined (reading 'perTask')");
  });

  it('names the panel that failed and says the rest of the room is unaffected', () => {
    // A red box with no name sends the founder reading source to find out what broke, and a
    // red box with no reassurance makes them distrust every other number on the page.
    const said = text(renderTree(guard('Burn', h(Burn, {}), 'pfd-cell'))).join(' | ');
    expect(said).toContain('Burn');
    expect(said).toContain('Only this panel is affected');
  });

  it('keeps the failed cell in its own grid slot rather than shoving the deck', () => {
    // Deck zones are placed by grid-area off their class. A fallback that dropped the class
    // would land in the wrong cell, so the layout would break in a SECOND way at the moment
    // it is least readable.
    const out = renderTree(guard('Flight display', h(Burn, {}), 'z-pfd')) as Node;
    expect(String((out.props as Record<string, unknown>)['className'])).toContain('z-pfd');
    expect(String((out.props as Record<string, unknown>)['role'])).toBe('alert');
  });

  it('adds no node of its own while everything is healthy', () => {
    // In the healthy path it renders a Fragment. If it rendered a wrapper element instead,
    // every `.deckwrap > .z-*` grid placement on the page would silently stop matching.
    const inst = new PanelBoundary({ name: 'Ticker', children: h('i', null, 'x') });
    expect(inst.render().type).toBe(React.Fragment);
  });

  it('every Panel puts its body behind the boundary, so a new panel is covered by default', () => {
    const said = text(renderTree(h(Panel, { title: 'Fan-out', sub: 'this tick' }, h(Burn, {})))).join(' | ');
    expect(said).toContain('Fan-out');        // the panel's own chrome still drew
    expect(said).toContain('this tick');
    expect(said).toContain('failed to draw'); // only the body was replaced
  });

  it('leaves no zone unguarded: every top-level child of the deck wrapper goes through one', () => {
    // The guarantee, not the widget list. Zones get added and renamed; what must hold is that
    // NOTHING is a direct child of the deck wrapper without a boundary in front of it, on any
    // tab. Written as a shape check so a zone added tomorrow fails this test if it is bare.
    const page = readFileSync(join(ROOM_DIR, 'app.html'), 'utf8');
    const start = page.indexOf("return h('div', { className: 'deckwrap' },");
    const end = page.indexOf('\nReactDOM.createRoot', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const zones = page.slice(start, end).split('\n').slice(1).filter((l) => /^ {4}[A-Za-z]/.test(l));
    expect(zones.length).toBeGreaterThanOrEqual(8);
    expect(zones.filter((l) => !l.trimStart().startsWith('guard('))).toEqual([]);
  });
});

/* ------------------------------------------------------------- overview helpers ---- */

/**
 * The Overview rebuild's derivations, sliced out of the same vendored page and evaluated the
 * same way `loadHealthPanel` does. They decide what the founder reads FIRST — the elapsed
 * clock in the marquee, the order of the owed grid, and the one sentence a collapsed
 * self-healing strip is allowed to show — so a formatter that is only ever exercised through
 * a screenshot is a formatter nobody has tested.
 */
type OverviewHelpers = {
  laneElapsed: (startedAt: number | null, now?: number) => string;
  sortOwed: (items: unknown[]) => Array<Record<string, unknown>>;
  healthWorst: (rows: unknown[]) => string;
};

function loadOverviewHelpers(): OverviewHelpers {
  const page = readFileSync(join(ROOM_DIR, 'app.html'), 'utf8');
  const from = '/* ── pure helpers';
  const to = '/* ── end pure helpers';
  const a = page.indexOf(from);
  const b = page.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('app.html no longer carries the pure-helper block');
  const src = `${page.slice(a, b)}\nreturn { laneElapsed, sortOwed, healthWorst };`;
  return new Function(src)() as OverviewHelpers;
}

describe('overview helpers', () => {
  const { laneElapsed, sortOwed, healthWorst } = loadOverviewHelpers();

  describe('laneElapsed', () => {
    it('counts in seconds, because a figure frozen for a minute is a frozen page', () => {
      const now = 1_000_000_000;
      expect(laneElapsed(now - 65_000, now)).toBe('01:05');
      expect(laneElapsed(now - 9_000, now)).toBe('00:09');
    });

    it('grows an hours field rather than running past 60 minutes', () => {
      const now = 1_000_000_000;
      expect(laneElapsed(now - 3_725_000, now)).toBe('1:02:05');
    });

    it('says nothing rather than zero when the lane has no start stamp', () => {
      // A lane whose start was never recorded has an UNKNOWN elapsed, and '00:00' would
      // claim it just started — the same class of lie as a heartbeat read as progress.
      expect(laneElapsed(null, 1_000)).toBe('—');
    });

    it('never counts backwards from a clock that has drifted', () => {
      expect(laneElapsed(2_000, 1_000)).toBe('00:00');
    });
  });

  describe('sortOwed', () => {
    const item = (key: string, extra: Record<string, unknown> = {}) => ({ key, kind: 'spec', id: key, ...extra });

    it('puts what one click would finish at the front', () => {
      const out = sortOwed([
        item('a', { progress: { done: 1, total: 4, complete: false } }),
        item('b', { progress: { done: 3, total: 3, complete: true } }),
      ]);
      expect(out.map((o) => o.key)).toEqual(['b', 'a']);
    });

    it('then the most-progressed, which is the shortest walk to the next sign-off', () => {
      const out = sortOwed([
        item('low', { progress: { done: 1, total: 10, complete: false } }),
        item('high', { progress: { done: 8, total: 10, complete: false } }),
      ]);
      expect(out.map((o) => o.key)).toEqual(['high', 'low']);
    });

    it('breaks a tie on the oldest recorded date, and sorts an undated item after a dated one', () => {
      const out = sortOwed([
        item('undated'),
        item('new', { recordedOn: '2026-08-22' }),
        item('old', { recordedOn: '2026-08-01' }),
      ]);
      expect(out.map((o) => o.key)).toEqual(['old', 'new', 'undated']);
    });

    it('keeps a signed-off item, last — a debt that vanishes when paid cannot be checked', () => {
      const out = sortOwed([
        item('done', { signedOff: true, progress: { done: 2, total: 2, complete: true } }),
        item('open', { progress: { done: 0, total: 5, complete: false } }),
      ]);
      expect(out.map((o) => o.key)).toEqual(['open', 'done']);
      expect(out).toHaveLength(2);
    });

    it('does not mutate the list it was handed', () => {
      const input = [item('a', { recordedOn: '2026-08-30' }), item('b', { recordedOn: '2026-08-01' })];
      sortOwed(input);
      expect(input.map((o) => o.key)).toEqual(['a', 'b']);
    });
  });

  describe('healthWorst', () => {
    const row = (check: string, status: string, reported = status) => ({ check, label: check.toUpperCase(), status, reported });

    it('names the failing checks rather than averaging them away', () => {
      // "5 of 6 ok" is the RUNNING / LIVE FEED header wearing a new font.
      const said = healthWorst([row('temporal', 'ok'), row('rotation', 'failed'), row('worker', 'ok')]);
      expect(said).toContain('FAILING');
      expect(said).toContain('ROTATION');
      expect(said).not.toContain('ok');
    });

    it('reports a caution when nothing is failing but something was repaired', () => {
      expect(healthWorst([row('worker', 'repaired'), row('temporal', 'ok')])).toContain('repaired');
    });

    it('says nothing has reported when nothing has, rather than calling silence ok', () => {
      const said = healthWorst([row('a', 'unknown', ''), row('b', 'unknown', '')]);
      expect(said).toContain('nothing reported yet');
    });

    it('counts the partially silent instead of claiming the whole roster is ok', () => {
      expect(healthWorst([row('a', 'ok'), row('b', 'unknown', '')])).toBe('1 of 2 checks have never reported');
    });

    it('only says everything is ok when everything is', () => {
      expect(healthWorst([row('a', 'ok'), row('b', 'ok')])).toBe('all 2 checks ok');
      expect(healthWorst([])).toBe('no checks on the roster');
    });
  });
});

/**
 * The rebuild moved panels; it removed no field. These are the load-bearing structural
 * claims, asserted against the served page rather than a screenshot.
 */
describe('overview structure', () => {
  it('keeps every Run-totals figure after the panel itself is folded into the marquee', async () => {
    const page = await (await fetch(base + '/')).text();
    expect(page).not.toContain("h(Panel, { title: 'Run totals' }");
    for (const field of ['t.notional', 't.ticks', 't.closed', 't.billable', 'fmtMin(t.minutes)']) {
      expect(page).toContain(field);
    }
    expect(page).toContain('Notional is list-price token value, not money.');
  });

  it('renders the dirty paths the state has always carried and the page never showed', async () => {
    const page = await (await fetch(base + '/')).text();
    expect(page).toContain('git.dirtyPaths');
  });

  it('collapses self-healing visually, never conditionally — a break may not be unrendered', async () => {
    const page = await (await fetch(base + '/')).text();
    // The roster and the feed sit inside a `.disclose` wrapper whose only job is 0fr → 1fr.
    expect(page).toContain("'disclose' + (open ? ' open' : '')");
    // and the panel re-opens itself when a NEW break appears, keyed to a signature so an
    // identical 4-second push does not fight a founder who collapsed a known failure.
    expect(page).toContain('healthSig');
  });

  it('never animates from a render — the state word is keyed to the value that changed', async () => {
    const page = await (await fetch(base + '/')).text();
    expect(page).toContain('if (prev.current === state) return undefined;');
    expect(page).toContain("node.addEventListener('animationend', done, { once: true });");
  });
});

/* ------------------------------------------------------------------- top line ---- */

/**
 * `running` is a fresh runner heartbeat and nothing more, and for eight hours that heartbeat
 * was the only thing the header consulted. These are the states it could not tell apart.
 */
describe('top line', () => {
  const now = Date.parse('2026-08-25T12:00:00.000Z');
  const LIVE = {
    running: true, lanes: 0, stop: null, kill: null, rotation: null,
    awaitingFounder: 0, reviewCap: 3, pending: 4, parked: 0,
    heartbeatAt: '2026-08-25T11:59:50.000Z', now,
  };

  it('calls it WORKING only when a lane is actually in flight', () => {
    expect(topLine({ ...LIVE, lanes: 1 })).toEqual({ state: 'WORKING', reason: null, tone: 'on' });
  });

  it('names the founder and the hour when a stop is armed — the flag nobody could attribute', () => {
    const stop = { armedAt: '2026-08-25T09:00:00.000Z', armedBy: 'founder' };
    const idle = topLine({ ...LIVE, stop });
    expect(idle.state).toBe('IDLE');
    expect(idle.reason).toContain('stop armed by founder 3.0h ago');
    expect(idle.reason).toContain('opens nothing further until Clear stop');

    // Armed while a lane still runs is a different promise: this tick finishes, then it ends.
    expect(topLine({ ...LIVE, lanes: 1, stop })).toMatchObject({ state: 'STOPPING' });
    expect(topLine({ ...LIVE, lanes: 1, kill: stop })).toMatchObject({ state: 'KILLING' });
  });

  it('says an unsigned flag is unsigned rather than implying a founder set it', () => {
    const reason = topLine({ ...LIVE, stop: { armedAt: null, armedBy: null } }).reason ?? '';
    expect(reason).toContain('armed by an unrecorded author');
    expect(reason).toContain('at an unrecorded time');
  });

  it('repeats the supervisor\'s rotation verdict verbatim — a cancelled workflow is the whole story', () => {
    const rotation = healthRows([{ at: '2026-08-25T11:00:00.000Z', check: 'rotation', status: 'failed', detail: 'workflow CANCELED' }])
      .find((r) => r.check === 'rotation') ?? null;
    expect(topLine({ ...LIVE, rotation })).toMatchObject({ state: 'IDLE', reason: 'rotation failed — workflow CANCELED' });
  });

  it('distinguishes review cap, a drained queue and an undispatched rotation', () => {
    expect(topLine({ ...LIVE, awaitingFounder: 3, reviewCap: 3 }).reason).toContain('review cap reached');
    expect(topLine({ ...LIVE, pending: 0, parked: 2 }).reason).toBe('queue drained — nothing pending, 2 parked');
    expect(topLine({ ...LIVE }).reason).toContain('no rotation dispatched');
  });

  it('reports a dead host as STOPPED with the command that revives it, not as a bare "stopped"', () => {
    const dead = topLine({ ...LIVE, running: false, heartbeatAt: '2026-08-25T04:00:00.000Z' });
    expect(dead).toMatchObject({ state: 'STOPPED', tone: 'off' });
    expect(dead.reason).toContain('no runner heartbeat since 8.0h ago');
    expect(dead.reason).toContain('spicyspec-runner start');
    expect(topLine({ ...LIVE, running: false, heartbeatAt: null }).reason).toContain('no runner has ever registered');
  });

  it('is served on /api/state so the header never derives it from a heartbeat again', async () => {
    const idle = (await state()) as unknown as { activity: { state: string; reason: string } };
    expect(idle.activity.state).toBe('STOPPED');
    await store.setKv('runner:main', JSON.stringify({ pid: 99, heartbeatAt: new Date().toISOString() }));
    const alive = (await state()) as unknown as { running: boolean; activity: { state: string; reason: string } };
    // The exact lie: a live heartbeat, nothing in flight. RUNNING then; IDLE with a reason now.
    expect(alive.running).toBe(true);
    expect(alive.activity.state).toBe('IDLE');
    expect(alive.activity.reason).toBeTruthy();
  });

  it('reads maxAwaitingReview off the runner config, and falls back to the runner default', () => {
    const path = join(repo, 'cap.json');
    writeFileSync(path, JSON.stringify({ maxAwaitingReview: 7 }), 'utf8');
    expect(reviewCapOf(path)).toBe(7);
    writeFileSync(path, JSON.stringify({ maxAwaitingReview: 0 }), 'utf8');
    expect(reviewCapOf(path)).toBe(3);
    expect(reviewCapOf(join(repo, 'no-such-config.json'))).toBe(3);
  });
});

/* ----------------------------------------------------------------- flag author ---- */

describe('stop flag authorship', () => {
  it('signs the founder\'s stop so the supervisor never auto-clears it', async () => {
    await post('/api/action/stop', {});
    expect(parseArmedFlag(await store.getKv(STOP_KEY))).toEqual({ armedAt: expect.any(String), armedBy: 'founder' });
    const s = (await state()) as unknown as { stopFlag: { armedBy: string }; stopArmed: boolean };
    expect(s.stopArmed).toBe(true);
    expect(s.stopFlag.armedBy).toBe('founder');
  }, 40_000);

  it('signs the founder\'s kill the same way', async () => {
    await post('/api/action/kill', {});
    expect(parseArmedFlag(await store.getKv(KILL_KEY))).toMatchObject({ armedBy: 'founder' });
    expect((await state()) as unknown as { killFlag: { armedBy: string } }).toMatchObject({ killFlag: { armedBy: 'founder' } });
  }, 40_000);

  it('treats an unreadable or unsigned flag as armed by nobody, never as armed by the founder', async () => {
    // This is the flag from the incident: written by an agent, with no author on it.
    await store.setKv(STOP_KEY, JSON.stringify({ armedAt: '2026-08-25T01:00:00.000Z' }));
    expect((await state()) as unknown as { stopFlag: unknown }).toMatchObject({ stopFlag: { armedBy: null } });
    await store.setKv(STOP_KEY, 'not json at all');
    expect((await state()) as unknown as { stopArmed: boolean }).toMatchObject({ stopArmed: true });
    expect(parseArmedFlag('not json at all')).toEqual({ armedAt: null, armedBy: null });
    expect(parseArmedFlag(null)).toBeNull();
  });
});

describe('which tasks.md the progress bar believes', () => {
  const mkSpec = (root: string, rel: string, body: string) => {
    mkdirSync(join(root, rel), { recursive: true });
    writeFileSync(join(root, rel, 'tasks.md'), body, 'utf8');
  };

  it('reads the copy written most recently, not the worktree by habit', () => {
    // The founder watched 008 sit at 35/61 for hours while the loop ticked its way to 43/72:
    // single-spec runs work the REPO, but the room preferred a worktree left over from the
    // parallel era and never touched again. Recency is the only honest tie-breaker.
    const root = mkdtempSync(join(tmpdir(), 'roomprog-'));
    const rel = 'specs/008-x';
    mkSpec(join(root, '.spicyspec', 'worktrees', '008'), rel, '- [x] T001 a\n- [ ] T002 b\n');
    mkSpec(root, rel, '- [x] T001 a\n- [x] T002 b\n- [ ] T003 c\n');
    // Make the repo copy unambiguously newer than the worktree's.
    const stale = new Date(Date.now() - 3 * 3600_000);
    utimesSync(join(root, '.spicyspec', 'worktrees', '008', rel, 'tasks.md'), stale, stale);

    expect(specProgress(root, rel, '008')).toMatchObject({ done: 2, open: 1, total: 3 });
  });

  it('still prefers a lane worktree while that lane is the one being written', () => {
    const root = mkdtempSync(join(tmpdir(), 'roomprog-'));
    const rel = 'specs/009-y';
    mkSpec(root, rel, '- [x] T001 a\n- [ ] T002 b\n- [ ] T003 c\n');
    mkSpec(join(root, '.spicyspec', 'worktrees', '009'), rel, '- [x] T001 a\n- [x] T002 b\n- [ ] T003 c\n');
    const stale = new Date(Date.now() - 3 * 3600_000);
    utimesSync(join(root, rel, 'tasks.md'), stale, stale);

    expect(specProgress(root, rel, '009')).toMatchObject({ done: 2, open: 1, total: 3 });
  });
});

describe('dirty paths survive git porcelain padding', () => {
  it('keeps the first character of a worktree-modified path', () => {
    // stdout.trim() eats the leading space of ' M path' on the FIRST line only, and a fixed
    // slice(3) then ate a real character with it: the tree strip read 'picyspec.runner.json'.
    const porcelain = 'M spicyspec.runner.json\n?? .specify/loop/ship-pr-body.md\n M apps/web/src/main.ts';
    expect(dirtyPathsFrom(porcelain)).toEqual([
      'spicyspec.runner.json',
      '.specify/loop/ship-pr-body.md',
      'apps/web/src/main.ts',
    ]);
  });
});

/* ==================================================================== THE DECK ====
 *
 * The instrument deck's arithmetic. Every test below is named after the lie the helper is
 * there to refuse — a zero standing in for a missing number, a median drawn from a rendering
 * window, a ruling narrated twice because it is written to two files on purpose.
 * ------------------------------------------------------------------------------------ */

describe('statOf', () => {
  it('says null, not zero, when nothing was measured — a median of 0 reads as a measurement', () => {
    expect(statOf([])).toEqual({ n: 0, total: 0, mean: null, median: null, p90: null, min: null, max: null });
    expect(statOf([null, undefined, 'x', NaN])).toMatchObject({ n: 0, median: null });
  });

  it('counts only the rows that carry a number, and never averages a blank as zero', () => {
    // Four rows, two priced. The mean is of the two, not of the four.
    expect(statOf([10, null, 20, undefined])).toMatchObject({ n: 2, total: 30, mean: 15, median: 15 });
  });

  it('takes the midpoint of an even sample and the middle of an odd one', () => {
    expect(statOf([1, 2, 3, 4]).median).toBe(2.5);
    expect(statOf([1, 2, 3]).median).toBe(2);
  });

  it('reports p90 by nearest rank, so the figure is always a value that was observed', () => {
    expect(statOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).p90).toBe(9);
  });
});

describe('coverageOf', () => {
  it('prints the exclusion sentence the deck shows under every aggregate', () => {
    const c = coverageOf(16, 40, 'a cost', 'no cost');
    expect(c.line).toBe('16 of 40 rows carry a cost');
    expect(c.missingLine).toBe('24 of 40 rows carry no cost');
  });

  it('has no missing sentence when nothing was excluded — there is nothing honest to print', () => {
    expect(coverageOf(40, 40, 'a cost', 'no cost').missingLine).toBeNull();
  });
});

describe('ledgerDigest', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 7, 24, h, 0, 0)).toISOString();
  const rows = [
    { tick: 1, costUsd: 10, durationMinutes: 30, tasksClosed: 2, startedAt: at(0), exit: 'clean', account: 'primary' },
    { tick: 2, costUsd: 20, durationMinutes: 60, tasksClosed: 0, startedAt: at(1), exit: 'stalled', account: 'primary' },
    { tick: 3, startedAt: at(2), exit: 'clean', account: 'secondary' },
    { tick: 4, costUsd: 30, durationMinutes: 30, tasksClosed: 4, exit: 'clean', account: 'secondary' },
  ];

  it('states how many rows each figure was computed from, and which were left out', () => {
    const d = ledgerDigest(rows, Date.parse(at(3)));
    expect(d.rows).toBe(4);
    expect(d.runs).toBe(4);
    expect(d.priced.line).toBe('3 of 4 rows carry a cost');
    expect(d.priced.missingLine).toBe('1 of 4 rows carry no cost');
    // Run 4 has no startedAt: it belongs to no window and the coverage line says so.
    expect(d.stamped.line).toBe('3 of 4 rows carry a start stamp');
    expect(d.cost).toMatchObject({ n: 3, total: 60, median: 20 });
  });

  it('divides by what it actually has — never by a count that includes the blanks', () => {
    const d = ledgerDigest(rows, Date.parse(at(3)));
    // $60 over 4 distinct runs, and the basis names the 3 rows the money came from.
    expect(d.burn.perRun).toMatchObject({ value: 15, n: 3 });
    // 'run NUMBERS', not 'runs': the live ledger restarts numbering per spec, so the
    // denominator is a count of distinct numbers and the basis line must not pretend
    // otherwise — 83 rows collapse to 51 numbers there, and the $/run figure inherits that.
    expect(d.burn.perRun.basis).toBe('3 priced rows over 4 distinct run numbers');
    // $60 over 6 tasks closed.
    expect(d.burn.perTaskClosed.value).toBe(10);
  });

  it('returns null rather than Infinity when the divisor is zero — no task closed is not free', () => {
    const d = ledgerDigest([{ tick: 1, costUsd: 5, tasksClosed: 0, startedAt: at(0) }], Date.parse(at(1)));
    expect(d.burn.perTaskClosed.value).toBeNull();
    // One stamped row is an instant, not a span: there is no rate to state.
    expect(d.burn.perHour.value).toBeNull();
  });

  it('reads a verification result off the residue the pipeline wrote, and unknown when it did not', () => {
    const d = ledgerDigest(
      [
        { tick: 1, redFirstResidue: [{ file: 'a', marker: 'it.skip' }], startedAt: at(0) },
        { tick: 2, startedAt: at(1) },
      ],
      Date.parse(at(2)),
    );
    expect(d.series.verifyFailed).toEqual([1, null]);
    expect(d.verified.line).toBe('1 of 2 rows carry a verification result');
  });

  it('measures the WHOLE ledger, not the slice the page renders — the founder acts on the comparison', () => {
    // 60 cheap runs then one expensive one. A median taken from the last forty rows would be
    // a different number, and the anomaly card quotes this one at the founder.
    const many = Array.from({ length: 60 }, (_, i) => ({ tick: i + 1, costUsd: 1, startedAt: at(0) }));
    const d = ledgerDigest([...many, { tick: 61, costUsd: 100, startedAt: at(1) }], Date.parse(at(2)));
    expect(d.cost.n).toBe(61);
    expect(d.cost.median).toBe(1);
  });

  it('changes its revision when a row lands, so the page refetches on a fact and not a timer', () => {
    const a = ledgerDigest(rows, 0).revision;
    const b = ledgerDigest([...rows, { tick: 5, startedAt: at(3), exit: 'clean' }], 0).revision;
    expect(a).not.toBe(b);
  });
});

describe('mergeGateRows', () => {
  const record = (over: Record<string, unknown> = {}) => ({
    at: '2026-08-23T19:09:59Z',
    spec: '007',
    stage: 'closing',
    gate: 'terminal',
    verdict: 'APPROVE',
    confidence: 0.92,
    seat: 'board-qa-critic',
    frozen: 'abeddc2',
    note: 'both findings closed',
    ...over,
  });

  it('narrates a ruling once, though the DB and the JSONL both hold it on purpose', () => {
    const rows = mergeGateRows([
      { source: 'store', path: null, records: [record()] as never, problems: [], readAt: null },
      { source: 'GATES.jsonl', path: '/x', records: [record()] as never, problems: [], readAt: null },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('store');
  });

  it('keeps a re-review as its own row — the same seat ruling twice is the whole story', () => {
    const rows = mergeGateRows([
      {
        source: 'GATES.jsonl',
        path: '/x',
        records: [record({ verdict: 'REVISE', at: '2026-08-23T18:00:00Z', note: 'cov 68.96' }), record()] as never,
        problems: [],
        readAt: null,
      },
    ]);
    expect(rows.map((r) => r.verdict)).toEqual(['REVISE', 'APPROVE']);
  });

  it('previews a long note but always states the full length, so a row can say what it is hiding', () => {
    const note = 'x'.repeat(900);
    const [row] = mergeGateRows([{ source: 'GATES.jsonl', path: '/x', records: [record({ note })] as never, problems: [], readAt: null }], 220);
    expect(row.note).toHaveLength(220);
    expect(row.noteChars).toBe(900);
  });

  it('carries the file it was read from and the tree it judged — the row prints its own provenance', () => {
    const [row] = mergeGateRows([{ source: 'GATES.jsonl', path: '/x', records: [record()] as never, problems: [], readAt: null }]);
    expect(`${row.source} · frozen ${row.frozen}`).toBe('GATES.jsonl · frozen abeddc2');
  });
});

describe('windowStartOf', () => {
  const ends = Date.parse('2026-08-24T18:00:00.000Z');
  const rows = [
    { tick: 1, account: 'primary', startedAt: '2026-08-24T14:00:00.000Z', rateResetsAt: ends / 1000 },
    { tick: 2, account: 'primary', startedAt: '2026-08-24T15:00:00.000Z', rateResetsAt: ends / 1000 },
    { tick: 3, account: 'primary', startedAt: '2026-08-24T09:00:00.000Z', rateResetsAt: Date.parse('2026-08-24T12:00:00.000Z') / 1000 },
  ];

  it('names the earliest run that PROVED the window was already open, and labels it as derived', () => {
    expect(windowStartOf(rows, 'primary', ends)).toEqual({
      at: '2026-08-24T14:00:00.000Z',
      source: 'first-run-observed-in-this-window',
    });
  });

  it('refuses to invent a start when no row reported this window — a now-marker needs a record', () => {
    expect(windowStartOf(rows, 'secondary', ends)).toEqual({ at: null, source: null });
    expect(windowStartOf(rows, 'primary', null)).toEqual({ at: null, source: null });
  });
});

describe('accountEventRows', () => {
  it('stamps each switch and cooling so the wire can place it beside a ruling', () => {
    const out = accountEventRows(
      [
        { tick: 1, account: 'primary', startedAt: '2026-08-24T09:00:00.000Z', exit: 'clean' },
        { tick: 2, account: 'secondary', startedAt: '2026-08-24T10:00:00.000Z', exit: 'rate-limited' },
      ],
      {},
      Date.parse('2026-08-24T11:00:00.000Z'),
    );
    expect(out.map((e) => [e.kind, e.account, e.at])).toEqual([
      ['switch', 'secondary', '2026-08-24T10:00:00.000Z'],
      ['cooling', 'secondary', '2026-08-24T10:00:00.000Z'],
    ]);
    expect(out[0].text).toBe('run 2: switched primary → secondary');
  });

  it("reads a cold account off the pool's own state and names the refusal", () => {
    const now = Date.parse('2026-08-24T11:00:00.000Z');
    const out = accountEventRows([], { tertiary: { coldUntilMs: now + 600_000, refusedReason: 'quota exhausted' } }, now);
    expect(out[0]).toMatchObject({ kind: 'refused', account: 'tertiary' });
    expect(out[0].text).toContain('quota exhausted');
  });
});

describe('detectAnomalies', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 7, 24, h, 0, 0)).toISOString();
  const healthy: SupervisorHealth = { reporting: true, lastAt: at(3), staleAfterMs: 180_000, advice: null };
  const working = { state: 'WORKING' as const, reason: null, tone: 'on' as const };
  const base = (runs: Array<Record<string, unknown>>, over: Partial<Parameters<typeof detectAnomalies>[0]> = {}) => ({
    ledger: ledgerDigest(runs, Date.parse(at(4))),
    runs,
    accounts: [],
    healthRows: [] as HealthRow[],
    supervisor: healthy,
    activity: working,
    entries: [],
    gates: [],
    activeSpec: null,
    now: Date.parse(at(4)),
    ...over,
  });

  it('says nothing at all when nothing is wrong — an all-clear box is a chip that is always on', () => {
    const runs = Array.from({ length: 8 }, (_, i) => ({ tick: i + 1, costUsd: 10, tasksClosed: 2, durationMinutes: 20, exit: 'clean', startedAt: at(3) }));
    expect(detectAnomalies(base(runs))).toEqual([]);
  });

  it('states the number, the comparison and the reason, in that order', () => {
    const runs = [
      ...Array.from({ length: 8 }, (_, i) => ({ tick: i + 1, costUsd: 10, tasksClosed: 2, durationMinutes: 20, exit: 'clean', startedAt: at(1) })),
      { tick: 9, costUsd: 22, tasksClosed: 0, durationMinutes: 20, exit: 'clean', startedAt: at(3), toolCalls: 407 },
    ];
    const hit = detectAnomalies(base(runs)).find((a) => a.kind === 'cost');
    expect(hit?.headline).toBe('Run 9 cost $22.00 — 2.2× the $10.00 median across 9 priced runs, and made 407 tool calls for 0 tasks closed.');
    expect(hit?.evidence).toBe('9 of 9 rows carry a cost');
  });

  it('gives two expensive runs that share a number two different cards', () => {
    // The live ledger has 83 rows and 51 distinct tick values: numbering RESTARTS per spec,
    // so two unrelated $60 runs both call themselves 'run 1'. Keying a card on the number
    // alone made the older overspend vanish behind the newer one in a keyed list.
    const runs = [
      ...Array.from({ length: 8 }, (_, i) => ({ tick: i + 1, costUsd: 10, exit: 'clean', startedAt: at(0) })),
      { tick: 1, costUsd: 60, tasksClosed: 0, exit: 'clean', startedAt: at(1) },
      { tick: 1, costUsd: 55, tasksClosed: 0, exit: 'clean', startedAt: at(2) },
    ];
    const ids = detectAnomalies(base(runs))
      .filter((a) => a.kind === 'cost')
      .map((a) => a.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('refuses to compare against a population too small to be a population', () => {
    // Three rows: 2.2x of a three-row median is a coin toss wearing a statistic.
    const runs = [
      { tick: 1, costUsd: 10, exit: 'clean', startedAt: at(1) },
      { tick: 2, costUsd: 10, exit: 'clean', startedAt: at(2) },
      { tick: 3, costUsd: 90, exit: 'clean', startedAt: at(3) },
    ];
    expect(detectAnomalies(base(runs)).filter((a) => a.kind === 'cost')).toEqual([]);
  });

  it('escalates a run of bad exits and names every exit class it saw', () => {
    const runs = [
      { tick: 1, exit: 'clean', startedAt: at(0) },
      { tick: 2, exit: 'stalled', startedAt: at(1) },
      { tick: 3, exit: 'blocked', startedAt: at(2) },
      { tick: 4, exit: 'stalled', startedAt: at(3) },
    ];
    const hit = detectAnomalies(base(runs)).find((a) => a.kind === 'exit');
    expect(hit?.level).toBe('alarm');
    expect(hit?.headline).toBe('The last 3 runs all exited badly (stalled, blocked) — 4 runs are on record.');
  });

  it('outranks every measurement with a supervisor that has gone quiet', () => {
    const runs = [{ tick: 1, exit: 'stalled', startedAt: at(1) }, { tick: 2, exit: 'stalled', startedAt: at(2) }];
    const out = detectAnomalies(base(runs, { supervisor: { reporting: false, lastAt: null, staleAfterMs: 180_000, advice: INSTALL_HINT } }));
    expect(out[0].kind).toBe('supervisor');
    expect(out[0].evidence).toBe(INSTALL_HINT);
  });

  it('calls a WORKING loop with a long-silent ledger what it is, against the median run length', () => {
    const runs = Array.from({ length: 6 }, (_, i) => ({ tick: i + 1, durationMinutes: 20, costUsd: 5, tasksClosed: 1, exit: 'clean', startedAt: at(0) }));
    const now = Date.parse(at(0)) + 200 * 60_000;
    const hit = detectAnomalies(base(runs, { now, ledger: ledgerDigest(runs, now) })).find((a) => a.kind === 'cadence');
    expect(hit?.headline).toContain('No run has settled in 200m — 10× the 20m median across 6 timed runs.');
  });

  it('says all the accounts are cold rather than counting them one at a time', () => {
    const accounts = [
      { id: 'primary', cold: true, coldMinutes: 42, refusedReason: null },
      { id: 'secondary', cold: true, coldMinutes: 12, refusedReason: null },
    ];
    const hit = detectAnomalies(base([], { accounts })).find((a) => a.kind === 'accounts');
    expect(hit?.level).toBe('alarm');
    expect(hit?.headline).toBe('All 2 accounts are cold — the rotation has nothing to run on.');
  });
});

describe('composeDigest', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 7, 24, h, 0, 0)).toISOString();
  const runs = [
    { tick: 1, costUsd: 10, tasksClosed: 2, durationMinutes: 30, exit: 'clean', startedAt: at(1) },
    { tick: 2, costUsd: 20, tasksClosed: 0, durationMinutes: 40, exit: 'stalled', startedAt: at(4) },
    { tick: 3, costUsd: 5, tasksClosed: 1, exit: 'clean', startedAt: at(20) },
    { tick: 4, costUsd: 99, tasksClosed: 9, exit: 'clean' },
  ];
  const digest = () =>
    composeDigest({
      sinceMs: Date.parse(at(0)),
      untilMs: Date.parse(at(8)),
      runs,
      gates: [],
      healthEvents: [],
      accountEvents: [],
      entries: [],
      parked: [],
      commits: [],
      owed: null,
    });

  it('counts only what happened inside the window the founder asked about', () => {
    expect(digest().numbers).toMatchObject({ rows: 2, runs: 2, tasksClosed: 2, costUsd: 30, minutes: 70 });
  });

  it('names the rows that belong to no window rather than sweeping them into this one', () => {
    // Run 4 has no start stamp. Counting it here would inflate the night's spend by $99.
    expect(digest().coverage.excludedLine).toBe('1 of 4 ledger rows carry no start stamp and are not in this window');
    expect(digest().numbers.costUsd).toBe(30);
  });

  it('lists what broke, by exit class, with its own row', () => {
    expect(digest().broke.exits.map((e) => e['tick'])).toEqual([2]);
  });
});

describe('searchCorpus', () => {
  const docs = [
    { kind: 'gate', id: 'g1', title: 'REVISE · spec 007 · terminal · board-qa-critic', body: 'submission branch cov 68.96 and a web coverage tooling gap', at: '2026-08-23T19:09:59Z', source: 'GATES.jsonl' },
    { kind: 'run', id: '44', title: 'Run 44 · stalled · primary', body: 'no commits landed', at: '2026-08-24T02:00:00Z', source: 'ledger' },
  ];

  it('returns nothing for an empty query rather than the whole log', () => {
    expect(searchCorpus(docs, '   ')).toEqual([]);
  });

  it('demands every term — a palette that returns near-misses makes the founder read a list', () => {
    expect(searchCorpus(docs, 'coverage stalled')).toEqual([]);
    expect(searchCorpus(docs, 'coverage tooling').map((h) => h.id)).toEqual(['g1']);
  });

  it('weighs the thing named above the thing merely mentioned', () => {
    expect(searchCorpus(docs, 'stalled')[0].id).toBe('44');
  });

  it('quotes the neighbourhood of the hit, not the head of the row', () => {
    expect(searchCorpus(docs, 'tooling')[0].snippet).toContain('tooling');
  });
});

describe('parseCommitLog', () => {
  it("keeps a subject that contains the separator a naive format would have split on", () => {
    // '%h|%aI|%s' ate every subject containing a pipe — 'fix(room): a | b' became 'a'.
    const line = ['4bfe5b5', '2026-08-25T03:59:00+02:00', 'fix(room): a | b — and a tab\there'].join(COMMIT_SEP);
    expect(parseCommitLog(line)).toEqual([
      { sha: '4bfe5b5', at: '2026-08-25T01:59:00.000Z', subject: 'fix(room): a | b — and a tab\there' },
    ]);
  });

  it('drops a blank line without inventing a commit for it', () => {
    expect(parseCommitLog('\n\n')).toEqual([]);
  });
});

describe('budgetsFor', () => {
  it("takes the health budget from the supervisor's own grace rather than a copied constant", () => {
    // A page that had hardcoded 180000 would go on calling a supervisor healthy for three
    // minutes after that supervisor decided its own limit was thirty seconds.
    expect(budgetsFor(30_000)).toMatchObject({ health: 30_000, state: STATE_PUSH_MS * 3, push: STATE_PUSH_MS });
  });
});

/* --------------------------------------------------------------- deck wiring ---- */

describe('the deck over the wire', () => {
  it('serves a sibling ES module as JavaScript — octet-stream plus nosniff is a refused import', async () => {
    // Every room/*.mjs is imported by <script type="module">. With only .html and .js in the
    // MIME map they arrived as application/octet-stream and the browser refused all of them,
    // silently, behind a page that still rendered.
    const res = await fetch(base + '/agents.mjs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('carries the ledger aggregates, the anomalies, the budgets and the owed age on the state frame', async () => {
    await store.appendRun({ tick: 1, account: 'primary', exit: 'clean', costUsd: 10, tasksClosed: 2, durationMinutes: 20, startedAt: '2026-08-24T09:00:00.000Z' });
    const s = await state();
    expect(s['ledger']).toMatchObject({ rows: 1, runs: 1 });
    expect((s['ledger'] as unknown as { priced: { line: string } }).priced.line).toBe('1 of 1 row carry a cost');
    expect(Array.isArray(s['anomalies'])).toBe(true);
    expect(s['budgets']).toMatchObject({ push: 4000, state: 12000 });
    // The count is memoised; its AGE travels with it so the annunciator can hatch itself.
    expect(s['owed']).toHaveProperty('ageMs');
  });

  it('derives the rate window start from the run that proved the window was open', async () => {
    const ends = Date.parse('2026-08-24T18:00:00.000Z');
    await store.appendRun({ tick: 1, account: 'primary', exit: 'clean', startedAt: '2026-08-24T14:00:00.000Z', rateResetsAt: ends / 1000 });
    const account = ((await state())['accounts'] as unknown as Array<Record<string, unknown>>)[0];
    expect(account).toMatchObject({
      windowEndsAt: ends,
      windowStartedAt: '2026-08-24T14:00:00.000Z',
      windowStartedAtSource: 'first-run-observed-in-this-window',
    });
  });

  it('says nothing about a window start it cannot prove, instead of drawing a marker', async () => {
    await store.appendRun({ tick: 1, account: 'primary', exit: 'clean', startedAt: '2026-08-24T14:00:00.000Z' });
    const account = ((await state())['accounts'] as unknown as Array<Record<string, unknown>>)[0];
    expect(account['windowStartedAt']).toBeNull();
    expect(account['windowStartedAtSource']).toBeNull();
  });

  it('serves the ledger rows the wire and the journal read, with the revision they refetch on', async () => {
    await store.appendRun({ tick: 1, account: 'primary', exit: 'clean', costUsd: 3, startedAt: '2026-08-24T09:00:00.000Z' });
    const body = (await (await fetch(base + '/api/ledger')).json()) as Record<string, never>;
    expect(body['revision']).toBeTruthy();
    expect((body['rows'] as unknown as Array<Record<string, unknown>>)[0]).toMatchObject({ tick: 1, cost: 3, at: '2026-08-24T09:00:00.000Z', source: 'ledger' });
  });

  it('reads the board rulings out of the JSONL the board writes, notes intact', async () => {
    const note = 'both findings closed; api 2004 web 621 submission-branches 89.65 '.repeat(20);
    write(
      join(repo, '.specify', 'board', 'GATES.jsonl'),
      JSON.stringify({ at: '2026-08-23T19:09:59Z', spec: '007', stage: 'closing', gate: 'terminal', verdict: 'APPROVE', confidence: 0.92, seat: 'board-qa-critic', frozen: 'abeddc2', note }) + '\n',
    );
    const full = (await (await fetch(base + '/api/gates')).json()) as Record<string, never>;
    const rows = full['rows'] as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ spec: '007', verdict: 'APPROVE', seat: 'board-qa-critic', frozen: 'abeddc2', source: 'GATES.jsonl' });
    expect(String(rows[0]['note'])).toHaveLength(note.length);

    // The 4s frame previews the note but always states how long the real one is.
    const s = await state();
    const preview = ((s['gates'] as unknown as { rows: Array<Record<string, unknown>> }).rows)[0];
    expect(String(preview['note']).length).toBeLessThan(note.length);
    expect(preview['noteChars']).toBe(note.length);
  });

  it('composes the night the founder slept through, and names what it had to leave out', async () => {
    await store.appendRun({ tick: 1, account: 'primary', exit: 'clean', costUsd: 10, tasksClosed: 2, startedAt: new Date(Date.now() - 3600_000).toISOString() });
    await store.appendRun({ tick: 2, account: 'primary', exit: 'stalled', costUsd: 20, tasksClosed: 0 });
    const since = new Date(Date.now() - 8 * 3600_000).toISOString();
    const d = (await (await fetch(`${base}/api/digest?since=${encodeURIComponent(since)}`)).json()) as Record<string, never>;
    expect(d['numbers']).toMatchObject({ rows: 1, costUsd: 10, tasksClosed: 2 });
    expect((d['coverage'] as unknown as { excludedLine: string }).excludedLine).toBe('1 of 2 ledger rows carry no start stamp and are not in this window');
  });

  it('finds a ruling by a word inside its note, and returns nothing for an empty query', async () => {
    write(
      join(repo, '.specify', 'board', 'GATES.jsonl'),
      JSON.stringify({ at: '2026-08-23T19:09:59Z', spec: '007', gate: 'terminal', verdict: 'REVISE', seat: 'board-qa-critic', note: 'submission branch cov 68.96' }) + '\n',
    );
    const hit = (await (await fetch(base + '/api/search?q=submission')).json()) as Record<string, never>;
    expect((hit['hits'] as unknown as Array<Record<string, unknown>>)[0]).toMatchObject({ kind: 'gate', source: 'GATES.jsonl' });
    const none = (await (await fetch(base + '/api/search?q=')).json()) as Record<string, never>;
    expect(none['hits']).toEqual([]);
  });

  it('tells a page restored from the offline shell that its token is the previous start’s', async () => {
    const res = await fetch(base + '/api/action/resume', { method: 'POST', headers: { 'x-loop-token': 'from-a-cached-shell' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, code: 'stale-token' });
  });
});

/* ------------------------------------------------------- the agents deck ---- */

/**
 * The Agents tab's derivations, sliced out of the vendored page the same way the overview
 * helpers are. They exist as pure functions precisely so they can be tested here: the founder's
 * complaint was that a failed background command rendered as three hundred characters of raw
 * shell, four times over, and the fix is a classifier — which is worth nothing if nobody has
 * ever run it against a command it has not seen.
 */
type AgentRow = {
  id: string; kind: string; description: string; status: string;
  parentId?: string | null; depth?: number; durationMs?: number | null;
  startedAt?: string | null; endedAt?: string | null; tokens?: number; name?: string;
  /** The feed stamps every row with the lane it came from; the parentage repair reads it. */
  lane?: string;
  children?: string[];
};
type CommandIntent = {
  known: boolean; tag: string; text: string; head: string;
  chars: number; steps: number; heredoc: string | null; raw: string;
};
type HistoryRow = {
  key: string; kind: string; status: string; label: string; raw: string;
  count: number; ids: string[]; durationMs: number | null; timed: number;
  intent: CommandIntent | null; tokens: number;
};
type TreeRow = { a: AgentRow; depth: number; trail: boolean[]; childCount: number; liveKids: number; orphan: boolean };
type Series = {
  known: boolean; concurrencyKnown: boolean; dispatchedKnown: boolean; returnedKnown: boolean;
  concurrency: number[]; dispatched: number[]; returned: number[];
  starts: number; ends: number; derivedStarts: number; total: number;
  from: number | null; to: number | null; spanMs: number | null; peak: number | null;
};
type AgentHelpers = {
  commandIntent: (raw: unknown) => CommandIntent;
  looksLikeShell: (text: unknown) => boolean;
  historyRows: (list: AgentRow[]) => HistoryRow[];
  agentTree: (agents: AgentRow[]) => TreeRow[];
  agentSeries: (agents: AgentRow[], now: number, buckets?: number) => Series;
  agentSpan: (a: AgentRow, series: Series, now: number) => { known: boolean; left: number; width: number; derived: boolean };
  namespaceParents: (agents: AgentRow[]) => AgentRow[];
};

function loadAgentHelpers(): AgentHelpers {
  const slice = pageSlicer();
  const src = `${slice('/* ── pure helpers', '/* ── end pure helpers')}
return { commandIntent, looksLikeShell, historyRows, agentTree, agentSeries, agentSpan, namespaceParents };`;
  return new Function(src)() as AgentHelpers;
}

/** The command row and the panel it lives on, rendered with the stub `h` and the page's React. */
type CommandPanels = {
  WherePanel: (props: Record<string, unknown>) => Node;
  CmdGroupRow: (props: Record<string, unknown>) => Node;
  historyRows: (list: AgentRow[]) => HistoryRow[];
};

function loadCommandPanels(): CommandPanels {
  const slice = pageSlicer();
  const src = [
    slice('/* ── pure helpers', '/* ── end pure helpers'),
    slice('const CMD_TAG_LABEL = {', '/* ── THE LIVE TREE'),
    slice('const WherePanel = ({ where, onCopy }) => {', '\nconst pct ='),
    'return { WherePanel, CmdGroupRow, historyRows };',
  ].join('\n');
  // The page's OWN React, not the stub `h`: these panels are walked by `renderTree`, which
  // follows React's rule that children live in props. The stub hangs them off the node, so a
  // stubbed tree renders as its own root element and every assertion below would pass on an
  // empty panel — which is exactly how the first run of this suite "passed" nothing.
  const React = loadVendoredReact();
  return new Function('h', 'React', src)(React.createElement, React) as CommandPanels;
}

describe('command intent', () => {
  const { commandIntent, looksLikeShell } = loadAgentHelpers();

  it('reads a jest shard run out of a chain that starts with cd', () => {
    // `cd` heads 244 of the 948 commands on record, so the head word is never the answer.
    const i = commandIntent('cd /c/repo/apps/api && pnpm exec jest --config jest.integration.config.cts --shard 2/8 --testPathPatterns "audit"');
    expect(i.known).toBe(true);
    expect(i.tag).toBe('test');
    expect(i.text).toContain('run the jest tests');
    expect(i.text).toContain('shard 2 of 8');
  });

  it('names the file an inline python heredoc rewrites, without splitting the script into steps', () => {
    const raw = "python - <<'PY'\nimport io\np='apps/web/src/app/core/api/pilot-api.ts'\ns=io.open(p).read()\nPY";
    const i = commandIntent(raw);
    expect(i.tag).toBe('script');
    expect(i.heredoc).toBe('PY');
    expect(i.text).toContain('inline Python script');
    expect(i.text).toContain('api/pilot-api.ts');
    // The body is DATA. Splitting on its newlines made a one-step command report as five.
    expect(i.steps).toBe(1);
  });

  it('quotes a commit subject rather than the whole message body', () => {
    const i = commandIntent("git add x.ts && git commit -q -F - <<'EOF'\nfix(api): the upload response was typed as the read shape\n\nbody line\nEOF");
    expect(i.tag).toBe('git');
    expect(i.text).toContain('fix(api): the upload response was typed as the read shape');
    expect(i.text).not.toContain('body line');
  });

  it('says it cannot tell, and shows the literal first step, rather than inventing a description', () => {
    // THE RULE. An invented description for an unreadable command is the same class of lie as
    // a chip that is always on, and worse here, because it looks like an answer.
    const i = commandIntent('zzzq --frobnicate');
    expect(i.known).toBe(false);
    expect(i.tag).toBe('unknown');
    expect(i.text).toContain('could not tell');
    expect(i.head).toBe('zzzq --frobnicate');
  });

  it('reports an absent command as absent, not as an empty one', () => {
    expect(commandIntent(null).text).toContain('never recorded');
    expect(commandIntent('').known).toBe(false);
  });

  it('counts the shape off the literal text and never estimates it', () => {
    const raw = 'git status && grep -n foo app.html && wc -l app.html';
    const i = commandIntent(raw);
    expect(i.steps).toBe(3);
    expect(i.chars).toBe(raw.length);
  });

  it('keeps prose out of the command lane — the founder-journey blocker must stay a sentence', () => {
    // The inverse of the bug being fixed: an over-eager shell detector would turn the one line
    // on that panel that needs a human into a command card.
    expect(looksLikeShell('The founder journey is the only exit-bar item the loop cannot perform.')).toBe(false);
    expect(looksLikeShell('Last seen: no progress reported')).toBe(false);
    expect(looksLikeShell('cd apps/api && pnpm exec jest')).toBe(true);
    expect(looksLikeShell('grep -n foo app.html')).toBe(true);
  });
});

describe('history rows', () => {
  const { historyRows } = loadAgentHelpers();
  const cmd = (id: string, description: string, status = 'failed', durationMs: number | null = null): AgentRow =>
    ({ id, kind: 'local_bash', description, status, durationMs });

  it('collapses identical failed commands into one row with a count', () => {
    // The founder's screenshot: four of these stacked, each 300 characters of shell, pushing
    // the only line that needed a human off the panel.
    const rows = historyRows([cmd('1', 'ls -la'), cmd('2', 'ls -la'), cmd('3', 'ls -la'), cmd('4', 'ls -la')]);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(4);
    expect(rows[0].ids).toHaveLength(4);
  });

  it('does not collapse the same command across different outcomes', () => {
    // "it failed four times" and "it failed once and passed three times" are different facts.
    const rows = historyRows([cmd('1', 'ls -la', 'failed'), cmd('2', 'ls -la', 'completed')]);
    expect(rows).toHaveLength(2);
  });

  it('never merges two agents, however alike their descriptions', () => {
    const rows = historyRows([
      { id: 'a1', kind: 'local_agent', name: 'appsec-engineer', description: 'Gate review', status: 'completed' },
      { id: 'a2', kind: 'local_agent', name: 'appsec-engineer', description: 'Gate review', status: 'completed' },
    ]);
    expect(rows).toHaveLength(2);
  });

  it('reports the median duration and how many of the group actually carried one', () => {
    const rows = historyRows([cmd('1', 'ls', 'failed', 1000), cmd('2', 'ls', 'failed', 9000), cmd('3', 'ls', 'failed', null)]);
    expect(rows[0].count).toBe(3);
    expect(rows[0].timed).toBe(2);            // the denominator is stated, never implied
    expect(rows[0].durationMs).toBe(5000);
  });

  it('says nothing rather than zero when no member of the group was timed', () => {
    expect(historyRows([cmd('1', 'ls')])[0].durationMs).toBeNull();
  });
});

describe('agent tree', () => {
  const { agentTree } = loadAgentHelpers();
  const node = (id: string, parentId: string | null, status = 'completed'): AgentRow =>
    ({ id, parentId, kind: id === 'root' ? 'session' : 'local_agent', description: id, status });

  it('puts every descendant directly after its parent, carrying its depth', () => {
    const out = agentTree([node('root', null), node('a', 'root'), node('a1', 'a'), node('b', 'root')]);
    expect(out.map((r) => r.a.id)).toEqual(['root', 'a', 'a1', 'b']);
    expect(out.map((r) => r.depth)).toEqual([0, 1, 2, 1]);
    expect(out[1].childCount).toBe(1);
  });

  it('keeps a row whose parent has not arrived yet, flagged, rather than dropping it', () => {
    // A parent lands in its own SSE frame, so a child can legitimately arrive first. Hiding it
    // would silently delete work from the one view whose claim is that it shows all of it.
    const out = agentTree([node('root', null), node('orphan', 'never-seen')]);
    expect(out.map((r) => r.a.id)).toContain('orphan');
    expect(out.find((r) => r.a.id === 'orphan')?.orphan).toBe(true);
  });

  it('does not hang on a parent cycle', () => {
    const out = agentTree([node('x', 'y'), node('y', 'x')]);
    expect(out).toHaveLength(2);
  });

  it('counts how many of a node children are still out', () => {
    const out = agentTree([node('root', null), node('a', 'root', 'running'), node('b', 'root', 'completed')]);
    expect(out[0].liveKids).toBe(1);
  });
});

describe('fan-out series', () => {
  const { agentSeries, agentSpan } = loadAgentHelpers();
  const T = Date.parse('2026-08-25T04:00:00.000Z');
  const at = (secs: number) => new Date(T + secs * 1000).toISOString();

  it('withholds the in-flight curve unless every row it would describe is stamped', () => {
    // THE BAR. Three starts out of a hundred rows drew an in-flight curve peaking at 2
    // directly above a number reading 3 — a picture contradicting the figure it sat under.
    const rows: AgentRow[] = [{ id: 'a', kind: 'local_bash', description: 'ls', status: 'completed', startedAt: at(0), endedAt: at(10) }];
    for (let i = 0; i < 20; i += 1) rows.push({ id: `x${i}`, kind: 'local_bash', description: 'ls', status: 'completed', endedAt: at(20 + i) });
    const s = agentSeries(rows, T + 60_000, 10);
    expect(s.known).toBe(true);
    expect(s.concurrencyKnown).toBe(false);
    expect(s.peak).toBeNull();
    // The returns curve still draws: every finished row carries an end, so it hides nothing.
    expect(s.returnedKnown).toBe(true);
    expect(s.returned.reduce((n, v) => n + v, 0)).toBe(21);
  });

  it('draws in-flight when every row is stamped, and reports the real peak', () => {
    const s = agentSeries([
      { id: 'a', kind: 'local_bash', description: 'ls', status: 'completed', startedAt: at(0), endedAt: at(60) },
      { id: 'b', kind: 'local_bash', description: 'ls', status: 'completed', startedAt: at(10), endedAt: at(50) },
      { id: 'c', kind: 'local_bash', description: 'ls', status: 'completed', startedAt: at(20), endedAt: at(40) },
    ], T + 60_000, 10);
    expect(s.concurrencyKnown).toBe(true);
    expect(s.peak).toBe(3);
    expect(s.dispatched.reduce((n, v) => n + v, 0)).toBe(3);
  });

  it('derives a missing start from end minus duration, and counts the derivation as one', () => {
    // This runner's task events carry no timestamp, so `startedAt` is null on every row while
    // `end_time` is real. Subtracting the reported duration is arithmetic, not a measurement,
    // and the panel prints how much of its own picture came from it.
    const s = agentSeries([
      { id: 'a', kind: 'local_bash', description: 'ls', status: 'completed', endedAt: at(60), durationMs: 10_000 },
      { id: 'b', kind: 'local_bash', description: 'ls', status: 'completed', endedAt: at(90), durationMs: 30_000 },
    ], T + 120_000, 10);
    expect(s.starts).toBe(2);
    expect(s.derivedStarts).toBe(2);
    expect(s.concurrencyKnown).toBe(true);
  });

  it('says unknown for a row it cannot place, instead of pinning it to the left edge', () => {
    const s = agentSeries([
      { id: 'a', kind: 'local_bash', description: 'ls', status: 'completed', startedAt: at(0), endedAt: at(60) },
      { id: 'b', kind: 'local_bash', description: 'ls', status: 'completed', startedAt: at(10), endedAt: at(50) },
    ], T + 60_000, 10);
    const span = agentSpan({ id: 'z', kind: 'local_bash', description: 'ls', status: 'completed' }, s, T + 60_000);
    expect(span.known).toBe(false);
  });

  it('reports no window at all when fewer than two stamps exist anywhere', () => {
    expect(agentSeries([{ id: 'a', kind: 'local_bash', description: 'ls', status: 'running' }], T, 10).known).toBe(false);
  });
});

describe('what a failed command renders as', () => {
  const { WherePanel, CmdGroupRow, historyRows } = loadCommandPanels();

  it('shows what the command was FOR, and keeps the raw shell behind a disclosure', () => {
    const raw = 'cd /c/XIII/share/Work/airvia/apps/api && PAT=$(sed -n "1p" "$TEMP/int-chunks.txt"); pnpm exec jest --config jest.integration.config.cts --shard 2/8 --testPathPatterns "$PAT" 2>/dev/null | wc -l';
    const rows = historyRows([{ id: '1', kind: 'local_bash', description: raw, status: 'failed', durationMs: 42_000 }]);
    const said = text(renderTree(CmdGroupRow({ row: rows[0], onCopy: () => undefined, onOpen: () => undefined }))).join(' | ');
    expect(said).toContain('run the jest tests');
    expect(said).toContain('shard 2 of 8');
    expect(said).toContain('TEST');
    // The raw text is PRESENT — no information is lost — but it is behind a summary.
    expect(said).toContain(raw);
    expect(said).toContain('copy command');
    expect(said).toMatch(/show the \d+ characters it actually ran/);
  });

  it('collapses four identical failures into one row carrying a count', () => {
    const raw = "python - <<'PY'\nimport io\np='apps/web/src/app/core/api/pilot-api.ts'\nPY";
    const rows = historyRows([1, 2, 3, 4].map((n) => ({
      id: String(n), kind: 'local_bash', description: raw, status: 'failed', durationMs: null,
    })));
    expect(rows).toHaveLength(1);
    const said = text(renderTree(CmdGroupRow({ row: rows[0], onCopy: () => undefined }))).join(' | ');
    expect(said).toContain('×4');
    expect(said).toContain('inline Python script');
    expect(said).toContain('api/pilot-api.ts');
  });

  it('leaves the founder to-do above the failures, in prose, not in a command row', () => {
    // THE COMPLAINT, as a test. Four identical "a background command failed" blocks, each
    // dumping raw shell, buried the one item only a person can clear.
    const said = text(renderTree(WherePanel({
      onCopy: () => undefined,
      where: {
        headline: '1 agent working right now on spec 008',
        phase: 'CONVERGING',
        derivedFrom: 'the tick transcript, the queue and git — no model was asked',
        sentences: ['Tick 3 has been running 20 minutes on spec 008.'],
        blockers: [
          {
            what: '3 specs awaiting your click: 005, 006, 007',
            why: 'The founder journey is the only exit-bar item the loop cannot perform.',
          },
          { what: 'a background command failed', why: 'cd apps/api && pnpm exec jest --shard 1/4' },
          { what: 'a background command failed', why: 'cd apps/api && pnpm exec jest --shard 1/4' },
          { what: 'a background command failed', why: 'grep -rn "FR-111" specs/008' },
        ],
      },
    }))).join(' | ');

    const owed = said.indexOf('3 specs awaiting your click');
    const failures = said.indexOf('background commands failed');
    expect(owed).toBeGreaterThanOrEqual(0);
    expect(failures).toBeGreaterThan(owed);          // the to-do is ABOVE the noise
    expect(said).toContain('3 background commands failed');
    expect(said).toContain('2 distinct');            // two of them were the same command
    expect(said).toContain('run the jest tests');
    expect(said).toContain('search for FR-111');
    // Nothing is lost: every raw character is still on the panel.
    expect(said).toContain('cd apps/api && pnpm exec jest --shard 1/4');
    expect(said).toContain('grep -rn "FR-111" specs/008');
  });

  it('draws no failure block at all when nothing failed', () => {
    const said = text(renderTree(WherePanel({
      onCopy: () => undefined,
      where: { headline: 'idle', phase: null, derivedFrom: 'git', sentences: ['nothing to report'], blockers: [] },
    }))).join(' | ');
    expect(said).not.toContain('background command');
  });
});

describe('agent parentage across the lane namespace', () => {
  const { namespaceParents, agentTree } = loadAgentHelpers();

  it('re-joins a namespaced id to the bare parentId the feed sends', () => {
    // room-server.ts:2303 namespaces `id` per lane and leaves `parentId` as the runtime's bare
    // id, so `byId.get(a.parentId)` missed on every row. The flat grid never noticed because it
    // only looked a parent up below depth 1; a tree noticed at once — 130 commands all drawn at
    // the root. This applies the same rule the server uses when it re-namespaces a detail.
    const fixed = namespaceParents([
      { id: '008·root', lane: '008', parentId: null, kind: 'session', description: 'worker', status: 'running' },
      { id: '008·t1', lane: '008', parentId: 'root', kind: 'local_bash', description: 'ls', status: 'completed' },
    ]);
    expect(fixed[1].parentId).toBe('008·root');
    const tree = agentTree(fixed);
    expect(tree.map((r) => r.depth)).toEqual([0, 1]);
    expect(tree[1].orphan).toBe(false);
  });

  it('leaves an id it cannot resolve exactly as it arrived, so the tree can flag it', () => {
    // Repairing is only legitimate where the namespaced form names a row that is PRESENT.
    // Anything else stays untouched and surfaces as "parent not seen" rather than as a guess.
    const fixed = namespaceParents([
      { id: '008·root', lane: '008', parentId: null, kind: 'session', description: 'worker', status: 'running' },
      { id: '008·t1', lane: '008', parentId: 'nobody', kind: 'local_agent', description: 'x', status: 'running' },
    ]);
    expect(fixed[1].parentId).toBe('nobody');
    expect(agentTree(fixed).find((r) => r.a.id === '008·t1')?.orphan).toBe(true);
  });

  it('does not rewrite an id that already resolves, and never mutates its input', () => {
    const input = [
      { id: 'root', parentId: null, kind: 'session', description: 'worker', status: 'running' },
      { id: 't1', parentId: 'root', kind: 'local_bash', description: 'ls', status: 'completed' },
    ];
    const fixed = namespaceParents(input);
    expect(fixed[1]).toBe(input[1]);       // untouched rows keep their identity
    expect(input[1].parentId).toBe('root');
  });
});

describe('deferred rows do not make a finished spec look stalled', () => {
  it('excludes DEFERRED-TO-<spec> rows from the bar and counts them separately', () => {
    // The runner stopped counting deferred rows as open, the room did not, and a spec with
    // every one of its OWN rows closed read "74 of 100" on the founder's dashboard — looking
    // permanently unfinished. Two surfaces disagreeing about the same file is the defect
    // class this room exists to kill.
    const root = mkdtempSync(join(tmpdir(), 'roomdefer-'));
    const rel = 'specs/008-x';
    mkdirSync(join(root, rel), { recursive: true });
    writeFileSync(
      join(root, rel, 'tasks.md'),
      [
        '- [x] T001 shipped',
        '- [x] T002 shipped',
        '- [ ] T036b **DEFERRED-TO-009** the whole listings surface',
        '- [ ] T042 **DEFERRED-TO-009** admin page',
      ].join('\n'),
      'utf8',
    );
    expect(specProgress(root, rel, '008')).toMatchObject({
      done: 2,
      open: 0,
      deferred: 2,
      total: 2,
      deferredTotal: 4,
    });
  });
});

describe('prose is never a task, from the room side too (B28)', () => {
  it('ignores ids mentioned in sentences and explanatory bullets', () => {
    // These four shapes are verbatim from the live 008 list. They produced three phantom
    // "UNMARKED" rows on the founder's dashboard, and inflated a finished spec's denominator
    // to "73 signed off of 100" while every row of its own work was closed.
    const root = mkdtempSync(join(tmpdir(), 'roomprose-'));
    const rel = 'specs/008-x';
    mkdirSync(join(root, rel), { recursive: true });
    writeFileSync(
      join(root, rel, 'tasks.md'),
      [
        '- [x] T001 real, done',
        '- [ ] T002 real, open',
        'minted ONCE for all SM-RATECHECK ids in W5/**T041a** (unanimous Decision Council)',
        '- **T041** — the service + module + port already EXIST (W2/T015-T017).',
        '- **T041c** — conditionally required, named in T041b.',
        '- T075-T077 are documentation/traceability debt, non-gating.',
      ].join('\n'),
      'utf8',
    );
    // Two real rows, and nothing else counted anywhere: not in the bar, not as held, and not
    // as a phantom warning beside it.
    expect(specProgress(root, rel, '008')).toEqual({
      done: 1,
      open: 1,
      held: 0,
      deferred: 0,
      total: 2,
      deferredTotal: 2,
      waves: 0,
      currentWave: null,
    });
  });
});
