/**
 * Control-room suite — real localhost socket, real store, real vendored room modules.
 *
 * Every test here is named after a founder-visible break the port shipped with: numbers that
 * only moved on the 15s poll, a Management tab starved of roles, an agent sheet that opened
 * empty, a "built" bar that was always zero because held tasks were counted as nothing, a
 * Kill button whose armed state never displayed.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** A run directory the pump will tail: fresh mtime, a meta.json, one assistant turn. */
function seedRun(spec: string, lines: unknown[]): void {
  const dir = join(repo, '.spicyspec', 'runs', '1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({ number: 1, spec, stage: 'build', account: 'primary', startedAt: new Date().toISOString() }),
    'utf8',
  );
  writeFileSync(join(dir, 'stream.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

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
    await new Promise((r) => setTimeout(r, 1400)); // one pump tick
    const lanes = (await state())['lanes'] as unknown as Array<Record<string, unknown>>;
    expect(lanes[0]).toMatchObject({ tools: 3, verification: 2 });
  }, 10_000);
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
    await new Promise((r) => setTimeout(r, 1400));
    const hello = (await (await fetch(base + '/api/agents')).json()) as { agents: Array<{ id: string }> };
    const child = hello.agents.find((a) => a.id.endsWith('t1'));
    expect(child, 'the pump must register a task_started agent').toBeTruthy();
    const detail = (await (await fetch(base + '/api/agent?id=' + encodeURIComponent(child!.id))).json()) as Record<string, unknown>;
    expect(detail['prompt']).toContain('Read the diff');
    expect(detail['id']).toBe(child!.id);
    expect((await fetch(base + '/api/agent?id=002%C2%B7nope')).status).toBe(404);
  }, 10_000);
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
