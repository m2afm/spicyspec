/**
 * Adapter suite — synthetic SDK messages through an injected queryFn, so every mapping is
 * proven without a live session. Defect ids reference the prototype register.
 */
import { collectSession } from '@spicyspec/provider';
import { describe, expect, it } from 'vitest';
import { createClaudeAdapter, mapMessage, mirrorShellPatterns, protectedPathsHook, violatesProtectedPaths, type QueryFn } from './claude-adapter.js';

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

describe('B25 round 2 (live-smoke catch): the PreToolUse hook is the real enforcement', () => {
  // bypassPermissions never consults canUseTool (SDK CLAUDE_SDK_CAN_USE_TOOL_SHADOWED);
  // the hook path fires in every permission mode.
  const hook = protectedPathsHook(['.spicyspec/']);

  it('denies a protected write with a deny decision and a reason', async () => {
    const out = await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: 'C:/repo/.spicyspec/queue.json' },
      tool_use_id: 't1',
    });
    expect(out).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
  });

  it('EXPLICITLY allows permitted calls (a fall-through re-enters host permission prompts an unattended run cannot answer)', async () => {
    const allowed = (await hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } })) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    expect(allowed.hookSpecificOutput?.permissionDecision).toBe('allow');
    // Non-PreToolUse events are not this hook's business — still silent.
    expect(await hook({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: {} })).toEqual({});
  });

  it('the adapter registers the hook when protectedPaths is set', () => {
    let captured: Record<string, unknown> | undefined;
    const q: QueryFn = (params) => {
      captured = params.options;
      return { async *[Symbol.asyncIterator]() { /* empty */ } };
    };
    const s = createClaudeAdapter({ queryFn: q }).createSession({
      prompt: 'p',
      cwd: '.',
      account: { id: 'a', env: {}, configDir: null },
      protectedPaths: ['.spicyspec/'],
    });
    // start the stream so the query is created
    void s.events()[Symbol.asyncIterator]().next();
    return new Promise((r) => setTimeout(r, 10)).then(() => {
      const hooks = captured?.['hooks'] as Record<string, unknown> | undefined;
      expect(hooks?.['PreToolUse']).toBeDefined();
    });
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

describe('B25 mirrored: a promised exception inside a protected path is HONORED', () => {
  it('the parked file is writable while the rest of the dir stays denied', () => {
    const paths = ['.spicyspec/'];
    const exceptions = ['.spicyspec/PARKED.md'];
    expect(violatesProtectedPaths('Edit', { file_path: 'C:/repo/.spicyspec/PARKED.md' }, paths, exceptions)).toBeNull();
    expect(violatesProtectedPaths('Write', { file_path: 'C:/repo/.spicyspec/queue.json' }, paths, exceptions)).toBe('.spicyspec/');
  });

  it('the hook honors the exception too', async () => {
    const hook = protectedPathsHook(['.spicyspec/'], ['.spicyspec/PARKED.md']);
    const allowed = await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/repo/.spicyspec/PARKED.md' },
    });
    expect((allowed as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision).toBe('allow');
    const denied = await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/repo/.spicyspec/gates.jsonl' },
    });
    expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });
});

describe('the detached-subagent tombstone class (live 009/011/013 parks)', () => {
  it('worker env forces synchronous subagents', async () => {
    let captured: Record<string, unknown> | undefined;
    const q: QueryFn = (params) => {
      captured = params.options;
      return (async function* () {})() as ReturnType<QueryFn>;
    };
    const adapter = createClaudeAdapter({ queryFn: q });
    const s = adapter.createSession({ prompt: 'x', cwd: '.', account: { id: 'a', env: {} } } as never);
    for await (const _e of s.events()) void _e;
    const env = (captured?.['env'] ?? {}) as Record<string, string>;
    expect(env['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']).toBe('1');
    // canUseTool must NOT be passed: it arms requireCanUseTool, which defeats the
    // PreToolUse allow hook for subagent calls.
    expect(captured && 'canUseTool' in captured ? captured['canUseTool'] : undefined).toBeUndefined();
  });

  it('Bash disallow patterns gain PowerShell twins; bare names and non-Bash pass through', () => {
    expect(mirrorShellPatterns(['Bash(git push --force*)', 'WebFetch'])).toEqual([
      'Bash(git push --force*)',
      'WebFetch',
      'PowerShell(git push --force*)',
    ]);
    expect(mirrorShellPatterns(undefined)).toBeUndefined();
  });
});
