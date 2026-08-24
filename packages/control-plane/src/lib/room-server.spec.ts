/**
 * Control-room suite — real localhost socket, real store, real vendored room modules.
 *
 * Every test here is named after a founder-visible break the port shipped with: numbers that
 * only moved on the 15s poll, a Management tab starved of roles, an agent sheet that opened
 * empty, a "built" bar that was always zero because held tasks were counted as nothing, a
 * Kill button whose armed state never displayed.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '@spicyspec/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KILL_KEY, specProgress, startControlRoom, STOP_KEY, type RunningRoom } from './room-server.js';

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
    '- **T004** left unmarked — the gate has open findings',
    '- **T005** nothing said about it at all',
    '- [ ] **T006** last one',
    'Prose that merely mentions **T003** again must not count twice.',
    'A paragraph naming T009 is not a task line.',
  ].join('\n');

  it('classifies done, open, held and unmarked separately — held:0 made the built bar always empty', () => {
    write(join(repo, 'specs', '002-x', 'tasks.md'), TASKS);
    const p = specProgress(repo, 'specs/002-x', '002');
    // T001+T002 done, T003+T006 open, T004 held with a stated reason, T005 silently blank.
    // The repeated **T003** in prose is the same id, and T009 in a paragraph is not a task.
    // The wave label stops at the '·' exactly as the terminal view's did.
    expect(p).toEqual({ done: 2, open: 2, held: 1, unmarked: 1, total: 6, waves: 2, currentWave: 'Wave 1' });
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
    const page = await (await fetch(base + '/')).text();
    expect(page).toContain("s.running ? 'killing' : 'kill armed'");
    expect(page).toContain("s.running ? 'stopping after tick' : 'stop armed'");
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
