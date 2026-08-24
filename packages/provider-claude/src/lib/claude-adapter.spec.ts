/**
 * Adapter suite — synthetic SDK messages through an injected queryFn, so every mapping is
 * proven without a live session. Defect ids reference the prototype register.
 */
import { collectSession } from '@spicyspec/provider';
import { describe, expect, it } from 'vitest';
import { createClaudeAdapter, createTaskSynthesisState, mapMessage, mirrorShellPatterns, protectedPathsHook, violatesProtectedPaths, type QueryFn } from './claude-adapter.js';

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

describe('task-lifecycle synthesis (History-tab / agents-grid gap)', () => {
  const user = (...content: unknown[]) => ({ type: 'user', message: { content } });
  const lifecycle = (events: ReturnType<typeof mapMessage>) => events.filter((e) => e.type === 'task_lifecycle');

  it('a Task tool_use opens a local_agent task — the grid shows more than the worker', () => {
    const tasks = createTaskSynthesisState();
    const events = mapMessage(
      assistant(null, {
        type: 'tool_use',
        id: 'tu_agent',
        name: 'Task',
        input: { subagent_type: 'qa-critic', description: 'gate review', prompt: 'review the diff' },
      }),
      tasks,
    );
    expect(lifecycle(events)).toEqual([
      expect.objectContaining({
        subtype: 'task_started',
        taskId: 'tu_agent',
        toolUseId: 'tu_agent',
        taskType: 'local_agent',
        subagentType: 'qa-critic',
        description: 'gate review',
        prompt: 'review the diff',
      }),
    ]);
  });

  it('Bash AND PowerShell tool_use open local_bash tasks with the command as description', () => {
    const tasks = createTaskSynthesisState();
    const bash = mapMessage(assistant(null, { type: 'tool_use', id: 'tu_sh', name: 'Bash', input: { command: 'pnpm nx test runner' } }), tasks);
    const pwsh = mapMessage(assistant(null, { type: 'tool_use', id: 'tu_ps', name: 'PowerShell', input: { command: 'git status' } }), tasks);
    expect(lifecycle(bash)[0]).toMatchObject({ subtype: 'task_started', taskId: 'tu_sh', taskType: 'local_bash', description: 'pnpm nx test runner' });
    expect(lifecycle(pwsh)[0]).toMatchObject({ subtype: 'task_started', taskId: 'tu_ps', taskType: 'local_bash', description: 'git status' });
  });

  it('a matching tool_result closes the task completed; is_error closes it failed', () => {
    const tasks = createTaskSynthesisState();
    mapMessage(assistant(null, { type: 'tool_use', id: 'tu_ok', name: 'Bash', input: { command: 'ls' } }), tasks);
    mapMessage(assistant(null, { type: 'tool_use', id: 'tu_bad', name: 'Bash', input: { command: 'false' } }), tasks);

    const ok = lifecycle(mapMessage(user({ type: 'tool_result', tool_use_id: 'tu_ok', is_error: false, content: 'fine' }), tasks));
    expect(ok).toEqual([expect.objectContaining({ subtype: 'task_updated', taskId: 'tu_ok', status: 'completed' })]);
    expect(typeof (ok[0] as { endTime?: string }).endTime).toBe('string');

    const bad = lifecycle(mapMessage(user({ type: 'tool_result', tool_use_id: 'tu_bad', is_error: true, content: 'boom' }), tasks));
    expect(bad).toEqual([expect.objectContaining({ subtype: 'task_updated', taskId: 'tu_bad', status: 'failed' })]);
  });

  it('an agent close carries what it returned as a task_notification summary', () => {
    const tasks = createTaskSynthesisState();
    mapMessage(assistant(null, { type: 'tool_use', id: 'tu_a', name: 'Task', input: { subagent_type: 'planner', description: 'plan' } }), tasks);
    const events = lifecycle(
      mapMessage(user({ type: 'tool_result', tool_use_id: 'tu_a', is_error: false, content: [{ type: 'text', text: 'plan is three waves' }] }), tasks),
    );
    expect(events).toEqual([
      expect.objectContaining({ subtype: 'task_updated', taskId: 'tu_a', status: 'completed' }),
      expect.objectContaining({ subtype: 'task_notification', taskId: 'tu_a', status: 'completed', summary: 'plan is three waves' }),
    ]);
  });

  it('a tool_result for a non-task tool synthesizes nothing — Reads are not agents', () => {
    const tasks = createTaskSynthesisState();
    mapMessage(assistant(null, { type: 'tool_use', id: 'tu_r', name: 'Read', input: { file_path: 'a.ts' } }), tasks);
    const events = mapMessage(user({ type: 'tool_result', tool_use_id: 'tu_r', is_error: false, content: 'text' }), tasks);
    expect(lifecycle(events)).toEqual([]);
  });

  it('one close per task: a second tool_result for the same id synthesizes nothing more', () => {
    const tasks = createTaskSynthesisState();
    mapMessage(assistant(null, { type: 'tool_use', id: 'tu_once', name: 'Bash', input: { command: 'ls' } }), tasks);
    mapMessage(user({ type: 'tool_result', tool_use_id: 'tu_once', is_error: false, content: 'x' }), tasks);
    const again = mapMessage(user({ type: 'tool_result', tool_use_id: 'tu_once', is_error: false, content: 'x' }), tasks);
    expect(lifecycle(again)).toEqual([]);
  });

  it('native lifecycle wins: task_started claims the id, remaps native ids, suppresses the synthetic close', () => {
    const tasks = createTaskSynthesisState();
    mapMessage(assistant(null, { type: 'tool_use', id: 'tu_n', name: 'Task', input: { subagent_type: 'explorer', description: 'scan' } }), tasks);

    // native started quoting our tool_use — must adopt the synthesized id, not mint a twin
    const started = lifecycle(mapMessage({ type: 'system', subtype: 'task_started', task_id: 'native_1', tool_use_id: 'tu_n', task_type: 'local_agent', subagent_type: 'explorer' }, tasks));
    expect(started).toEqual([expect.objectContaining({ subtype: 'task_started', taskId: 'tu_n', toolUseId: 'tu_n' })]);

    // the tool_result close is now the native stream job — no synthetic task_updated
    const close = mapMessage(user({ type: 'tool_result', tool_use_id: 'tu_n', is_error: false, content: 'done' }), tasks);
    expect(lifecycle(close)).toEqual([]);

    // native progress/notification remap onto the canonical id
    const progress = lifecycle(mapMessage({ type: 'system', subtype: 'task_progress', task_id: 'native_1', description: 'reading', last_tool_name: 'Read', usage: { total_tokens: 900, tool_uses: 3, duration_ms: 1200 } }, tasks));
    expect(progress).toEqual([expect.objectContaining({ subtype: 'task_progress', taskId: 'tu_n', lastToolName: 'Read', usage: { totalTokens: 900, toolUses: 3, durationMs: 1200 } })]);
    const done = lifecycle(mapMessage({ type: 'system', subtype: 'task_notification', task_id: 'native_1', status: 'completed', summary: 'scanned' }, tasks));
    expect(done).toEqual([expect.objectContaining({ subtype: 'task_notification', taskId: 'tu_n', status: 'completed', summary: 'scanned' })]);
  });

  it('a native task_started seen first suppresses later synthesis for its tool_use', () => {
    const tasks = createTaskSynthesisState();
    mapMessage({ type: 'system', subtype: 'task_started', task_id: 'native_2', tool_use_id: 'tu_pre', task_type: 'local_agent' }, tasks);
    const events = mapMessage(assistant(null, { type: 'tool_use', id: 'tu_pre', name: 'Task', input: { description: 'dup' } }), tasks);
    expect(lifecycle(events)).toEqual([]);
  });

  it('non-task system messages stay opaque, never guessed at', () => {
    const [e] = mapMessage({ type: 'system', subtype: 'init', session_id: 's' });
    expect(e.type).toBe('opaque');
  });
});
