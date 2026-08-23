/**
 * Adapter suite — synthetic SDK messages through an injected queryFn, so every mapping is
 * proven without a live session. Defect ids reference the prototype register.
 */
import { collectSession } from '@spicyspec/provider';
import { describe, expect, it } from 'vitest';
import { createClaudeAdapter, mapMessage, violatesProtectedPaths, type QueryFn } from './claude-adapter.js';

const assistant = (parent: string | null, ...content: unknown[]) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { content },
});

const fakeQuery =
  (messages: unknown[], hooks: { onInterrupt?: () => void } = {}): QueryFn =>
  () => ({
    async *[Symbol.asyncIterator]() {
      yield* messages;
    },
    async interrupt() {
      hooks.onInterrupt?.();
    },
  });

const session = (messages: unknown[], opts: Partial<Parameters<ReturnType<typeof createClaudeAdapter>['createSession']>[0]> = {}) =>
  createClaudeAdapter({ queryFn: fakeQuery(messages) }).createSession({
    prompt: 'do the work',
    cwd: 'C:/repo',
    account: { id: 'primary', env: {}, configDir: null },
    ...opts,
  });

describe('mapMessage', () => {
  it('B11: subagent text is NOT top-level — only the worker speaks for the worker', () => {
    const top = mapMessage(assistant(null, { type: 'text', text: 'my verdict' }));
    const sub = mapMessage(assistant('tool_123', { type: 'text', text: 'the spec is complete' }));
    expect(top[0]).toMatchObject({ type: 'assistant_text', topLevel: true });
    expect(sub[0]).toMatchObject({ type: 'assistant_text', topLevel: false });
  });

  it('maps tool_use with parent attribution', () => {
    const [e] = mapMessage(assistant('agent_1', { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }));
    expect(e).toMatchObject({ type: 'tool_use', id: 't1', name: 'Bash', parentToolUseId: 'agent_1' });
  });

  it('maps tool_result with error flag and flattened content', () => {
    const [e] = mapMessage({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'boom' }] }] },
    });
    expect(e).toMatchObject({ type: 'tool_result', toolUseId: 't1', isError: true, text: 'boom' });
  });

  it('maps rate_limit_event to normalized RateLimitInfo (B10 fields intact)', () => {
    const [e] = mapMessage({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning', utilization: 95, rateLimitType: 'seven_day', overageStatus: 'rejected' },
    });
    expect(e).toMatchObject({
      type: 'rate_limit',
      info: { status: 'allowed_warning', utilization: 95, rateLimitType: 'seven_day', overageStatus: 'rejected' },
    });
  });

  it('maps result to the envelope the classifier consumes', () => {
    const [e] = mapMessage({ type: 'result', total_cost_usd: 3.2, num_turns: 12, session_id: 's1', is_error: false, result: 'done' });
    expect(e).toMatchObject({ type: 'result', envelope: { total_cost_usd: 3.2, num_turns: 12, session_id: 's1' } });
  });

  it('B28-class: unknown message types become opaque, never guessed at', () => {
    const [e] = mapMessage({ type: 'hook_started', whatever: 1 });
    expect(e.type).toBe('opaque');
  });
});

describe('collectSession over the adapter', () => {
  it('collects top-level text, tool count, rate limit, and envelope', async () => {
    const outcome = await collectSession(
      session([
        assistant(null, { type: 'text', text: 'starting' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }),
        assistant('sub_1', { type: 'text', text: 'subagent noise' }, { type: 'tool_use', id: 't2', name: 'Read', input: {} }),
        { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', utilization: 40 } },
        { type: 'result', total_cost_usd: 1.5, num_turns: 4, is_error: false, result: 'ok' },
      ]),
    );
    expect(outcome.text).toBe('starting'); // subagent text excluded (B11)
    expect(outcome.toolCalls).toBe(2); // whole stream, both levels (B5)
    expect(outcome.rateLimit?.status).toBe('allowed');
    expect(outcome.envelope?.total_cost_usd).toBe(1.5);
  });

  it('interrupt stops the stream without orphaning (B12)', async () => {
    let interrupted = false;
    const s = createClaudeAdapter({
      queryFn: fakeQuery([assistant(null, { type: 'text', text: 'x' })], { onInterrupt: () => (interrupted = true) }),
    }).createSession({ prompt: 'p', cwd: '.', account: { id: 'a', env: {}, configDir: null } });
    // start consuming, then interrupt
    const iterator = s.events()[Symbol.asyncIterator]();
    await iterator.next();
    await s.interrupt();
    expect(interrupted).toBe(true);
  });
});

describe('B25: protectedPaths is ENFORCED, not advertised', () => {
  it('denies Write/Edit into a protected path, case- and slash-insensitively', () => {
    const paths = ['.spicyspec/', 'orchestrator-state/'];
    expect(violatesProtectedPaths('Write', { file_path: 'C:\\repo\\.SPICYSPEC\\queue.json' }, paths)).toBe('.spicyspec/');
    expect(violatesProtectedPaths('Edit', { file_path: '/repo/orchestrator-state/ledger.jsonl' }, paths)).toBe('orchestrator-state/');
  });

  it('allows writes elsewhere and non-writing tools anywhere', () => {
    expect(violatesProtectedPaths('Write', { file_path: '/repo/src/app.ts' }, ['.spicyspec/'])).toBeNull();
    expect(violatesProtectedPaths('Read', { file_path: '/repo/.spicyspec/queue.json' }, ['.spicyspec/'])).toBeNull();
    expect(violatesProtectedPaths('Bash', { command: 'cat .spicyspec/queue.json' }, ['.spicyspec/'])).toBeNull();
  });
});
