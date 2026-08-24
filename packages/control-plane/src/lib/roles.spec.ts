/**
 * The three roles' own suite — the vendored room/roles.mjs, driven with an injected spawn.
 *
 * Every case is a founder-visible failure of the Management tab: a chat that spends a turn
 * and loses the reply, a second message that silently corrupts a resumed session, a cost
 * that reads 0 because the result envelope was never parsed, a mandate any role could
 * rewrite. A real `claude` on PATH is not required — that is the point of spawnFn.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

interface RoleMessage {
  at: string;
  from: string;
  text: string;
  costUsd?: number;
  activity?: Array<{ tool: string; detail: string }>;
  error?: string | null;
}

interface Roles {
  ROLE_IDS: string[];
  ROLE_DEFS: Record<string, { id: string; name: string; permissionMode: string }>;
  rolesSnapshot(stateDir: string): Array<Record<string, unknown>>;
  loadSession(stateDir: string, id: string): { sessionId: string | null; turns?: number; costUsd?: number };
  readMessages(stateDir: string, id: string, limit?: number): RoleMessage[];
  readTasks(stateDir: string, id: string): Array<Record<string, unknown>>;
  addTask(stateDir: string, id: string, task: { text: unknown; scheduledFor?: unknown }): Record<string, unknown>;
  updateTask(stateDir: string, id: string, taskId: string, patch: Record<string, unknown>): Record<string, unknown> | null;
  readMandate(stateDir: string, id: string): string | null;
  writeMandate(stateDir: string, id: string, text: unknown): void;
  isBusy(id: string): boolean;
  say(args: {
    stateDir: string;
    root: string;
    id: string;
    text: string;
    config: Record<string, unknown>;
    onEvent?: (e: Record<string, unknown>) => void;
    spawnFn?: (bin: string, args: string[], opts: unknown) => FakeChild;
  }): Promise<RoleMessage>;
}

let roles: Roles;
let stateDir: string;

/** One spawn, one recorded invocation, one scripted stream. */
function scripted(lines: unknown[]): { child: FakeChild; spawnFn: (bin: string, args: string[]) => FakeChild; calls: Array<{ bin: string; args: string[] }> } {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const spawnFn = (bin: string, args: string[]): FakeChild => {
    calls.push({ bin, args });
    setImmediate(() => {
      for (const l of lines) child.stdout.emit('data', Buffer.from(JSON.stringify(l) + '\n', 'utf8'));
      child.emit('close', 0);
    });
    return child;
  };
  return { child, spawnFn, calls };
}

const REPLY = [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: 'specs/002/tasks.md' } }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Run 12 is on spec 002, wave 2.' }] } },
  { type: 'result', total_cost_usd: 0.0731, is_error: false },
];

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'roles-'));
  roles = (await import(new URL('../../room/roles.mjs', import.meta.url).href)) as unknown as Roles;
});

afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe('role storage', () => {
  it('keeps each role under its own directory so one crash cannot take the others', async () => {
    const { spawnFn } = scripted(REPLY);
    await roles.say({ stateDir, root: process.cwd(), id: 'manager', text: 'audit the ledger', config: {}, spawnFn });
    expect(existsSync(join(stateDir, 'roles', 'manager', 'session.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'roles', 'manager', 'messages.jsonl'))).toBe(true);
    expect(existsSync(join(stateDir, 'roles', 'supervisor', 'session.json'))).toBe(false);
  });

  it('appends the transcript rather than rewriting it — a reply that crashes mid-write must not erase history', async () => {
    const a = scripted(REPLY);
    await roles.say({ stateDir, root: process.cwd(), id: 'manager', text: 'first', config: {}, spawnFn: a.spawnFn });
    const b = scripted(REPLY);
    await roles.say({ stateDir, root: process.cwd(), id: 'manager', text: 'second', config: {}, spawnFn: b.spawnFn });
    const lines = readFileSync(join(stateDir, 'roles', 'manager', 'messages.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4); // founder, manager, founder, manager
    expect(roles.readMessages(stateDir, 'manager', 2).map((m) => m.from)).toEqual(['founder', 'manager']);
  });

  it('caps the mandate at 20k and refuses one for any role but the special agent', () => {
    expect(() => roles.writeMandate(stateDir, 'supervisor', 'x')).toThrow(/only the special agent/);
    expect(roles.readMandate(stateDir, 'supervisor')).toBeNull();
    roles.writeMandate(stateDir, 'special', 'y'.repeat(25_000));
    expect(roles.readMandate(stateDir, 'special')).toHaveLength(20_000);
  });

  it('round-trips tasks and reports the open count on the card', () => {
    const t = roles.addTask(stateDir, 'special', { text: 'watch the burn rate' });
    expect(roles.rolesSnapshot(stateDir).find((r) => r['id'] === 'special')?.['openTasks']).toBe(1);
    expect(roles.updateTask(stateDir, 'special', String(t['id']), { status: 'done' })).toMatchObject({ status: 'done' });
    expect(roles.rolesSnapshot(stateDir).find((r) => r['id'] === 'special')?.['openTasks']).toBe(0);
    expect(roles.updateTask(stateDir, 'special', 'no-such-task', { status: 'done' })).toBeNull();
  });
});

describe('role turns', () => {
  it('starts a fresh session with --session-id and resumes the SAME id afterwards', async () => {
    const a = scripted(REPLY);
    await roles.say({ stateDir, root: process.cwd(), id: 'supervisor', text: 'status?', config: { bin: 'claude-x' }, spawnFn: a.spawnFn });
    const first = a.calls[0];
    expect(first.bin).toBe('claude-x');
    expect(first.args).toContain('--session-id');
    expect(first.args).not.toContain('--resume');
    expect(first.args).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', '--setting-sources', 'project,local']));
    const sessionId = first.args[first.args.indexOf('--session-id') + 1];

    const b = scripted(REPLY);
    await roles.say({ stateDir, root: process.cwd(), id: 'supervisor', text: 'and now?', config: {}, spawnFn: b.spawnFn });
    expect(b.calls[0].args).toContain('--resume');
    expect(b.calls[0].args[b.calls[0].args.indexOf('--resume') + 1]).toBe(sessionId);
    expect(roles.loadSession(stateDir, 'supervisor')).toMatchObject({ sessionId, turns: 2 });
  });

  it('sends the mandate as the system prompt, pointing at the spicyspec truth files', async () => {
    const { spawnFn, calls } = scripted(REPLY);
    await roles.say({ stateDir, root: process.cwd(), id: 'supervisor', text: 'hi', config: {}, spawnFn });
    const mandate = calls[0].args[calls[0].args.indexOf('--append-system-prompt') + 1];
    expect(mandate).toContain('.spicyspec/runs/');
    expect(mandate).toContain('SUPERVISOR');
    expect(mandate).not.toContain('.specify/loop');
  });

  it('appends the founder-edited mandate file to the special agent\'s brief', async () => {
    roles.writeMandate(stateDir, 'special', 'Only ever talk about money.');
    const { spawnFn, calls } = scripted(REPLY);
    await roles.say({ stateDir, root: process.cwd(), id: 'special', text: 'hi', config: {}, spawnFn });
    expect(calls[0].args[calls[0].args.indexOf('--append-system-prompt') + 1]).toContain('Only ever talk about money.');
  });

  it('reads cost from the result envelope and accumulates it on the session', async () => {
    const a = scripted(REPLY);
    const msg = await roles.say({ stateDir, root: process.cwd(), id: 'manager', text: 'x', config: {}, spawnFn: a.spawnFn });
    expect(msg.costUsd).toBeCloseTo(0.0731, 4);
    expect(msg.text).toBe('Run 12 is on spec 002, wave 2.');
    expect(msg.error).toBeNull();
    const b = scripted(REPLY);
    await roles.say({ stateDir, root: process.cwd(), id: 'manager', text: 'y', config: {}, spawnFn: b.spawnFn });
    expect(roles.loadSession(stateDir, 'manager').costUsd).toBeCloseTo(0.1462, 4);
  });

  it('streams doing/partial/done so the panel shows work rather than a spinner', async () => {
    const { spawnFn } = scripted(REPLY);
    const kinds: string[] = [];
    await roles.say({ stateDir, root: process.cwd(), id: 'manager', text: 'x', config: {}, spawnFn, onEvent: (e) => kinds.push(String(e['kind'])) });
    expect(kinds).toEqual(['doing', 'partial', 'done']);
  });

  it('refuses a second concurrent turn instead of resuming one session twice', async () => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const pending = roles.say({ stateDir, root: process.cwd(), id: 'manager', text: 'slow one', config: {}, spawnFn: () => child });
    expect(roles.isBusy('manager')).toBe(true);
    const { spawnFn } = scripted(REPLY);
    // Thrown synchronously, before the promise exists: the caller must be able to answer 409
    // without first owning a rejected promise it has to remember not to await.
    expect(() => roles.say({ stateDir, root: process.cwd(), id: 'manager', text: 'me too', config: {}, spawnFn })).toThrow(/still answering/);
    child.stdout.emit('data', Buffer.from(JSON.stringify(REPLY[2]) + '\n', 'utf8'));
    child.emit('close', 0);
    await pending;
    expect(roles.isBusy('manager')).toBe(false);
  });

  it('records a non-zero exit as a failure message rather than hanging on an empty reply', async () => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const spawnFn = () => {
      setImmediate(() => {
        child.stderr.emit('data', Buffer.from('Credit balance is too low\n', 'utf8'));
        child.emit('close', 1);
      });
      return child;
    };
    const msg = await roles.say({ stateDir, root: process.cwd(), id: 'special', text: 'x', config: {}, spawnFn });
    expect(msg.error).toContain('claude exited 1');
    expect(msg.error).toContain('Credit balance');
  });

  it('rejects an unknown role before it spends anything', () => {
    expect(() => roles.say({ stateDir, root: process.cwd(), id: 'ceo', text: 'x', config: {} })).toThrow(/unknown role/);
  });
});
