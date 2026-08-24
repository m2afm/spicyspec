/**
 * Claude provider adapter — @anthropic-ai/claude-agent-sdk behind the Spicyspec contract.
 *
 * Replaces the prototype's `spawn('claude', ['-p', '--output-format', 'stream-json'])` and
 * its hand parsing, which produced five recorded defects (B4, B5, B11, B14, B28). The SDK
 * gives typed messages, a real `interrupt()`, and — decisively — `canUseTool`, which turns
 * `protectedPaths` from an advertised prohibition into an ENFORCED one (defect B25,
 * RFC-001 §7.6).
 *
 * The SDK entrypoint is injectable so every mapping below is unit-testable with synthetic
 * messages; the default lazily imports the real SDK.
 */
import type { RateLimitInfo, ResultEnvelope } from '@spicyspec/core';
import type {
  ProviderAdapter,
  SessionOptions,
  TaskLifecycleEvent,
  WorkerEvent,
  WorkerSession,
} from '@spicyspec/provider';

/* ------------------------------------------------------- SDK-facing structural types ---- */
/** Structural subset of the SDK's Query — what the adapter actually uses. */
export interface QueryLike extends AsyncIterable<unknown> {
  interrupt?(): Promise<unknown>;
  close?(): void;
}

export type QueryFn = (params: { prompt: string; options?: Record<string, unknown> }) => QueryLike;

interface ContentBlockLike {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface MessageLike {
  type?: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: unknown };
  // system task-lifecycle fields (native subagent events, when the runtime emits them)
  task_id?: string;
  tool_use_id?: string;
  task_type?: string;
  subagent_type?: string;
  description?: string;
  prompt?: unknown;
  status?: string;
  summary?: unknown;
  output_file?: string;
  last_tool_name?: string;
  patch?: { status?: string; end_time?: string };
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
  timestamp?: string;
  rate_limit_info?: {
    status?: string;
    resetsAt?: number;
    rateLimitType?: string;
    utilization?: number;
    overageStatus?: string;
    isUsingOverage?: boolean;
  };
  // result-message fields
  total_cost_usd?: number;
  num_turns?: number;
  session_id?: string;
  api_error_status?: number | null;
  is_error?: boolean;
  result?: string;
}

/* -------------------------------------------------------------------- event mapping ---- */

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c as ContentBlockLike)?.text ?? '').join('');
  return '';
}

/* ----------------------------------------------------------- task-lifecycle synthesis ---- */

/** Task/Agent dispatch subagents; Bash/PowerShell are commands. Both were visible in the
 * prototype's grid + History, and BOTH shells must be watched — a Bash-only list on Windows
 * hides every command the worker actually ran (same doctrine as mirrorShellPatterns). */
const AGENT_TOOLS = new Set(['Task', 'Agent']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/**
 * Cross-message memory for task synthesis — one per session, threaded through mapMessage.
 *
 * The runtime does not reliably emit subagent lifecycle through the SDK, so the adapter
 * SYNTHESIZES it: a Task/Bash tool_use opens a task (id = the tool_use id), its matching
 * tool_result closes it. A tool_result carries only the tool_use_id, so closing needs to
 * remember which ids were task-opening calls — that memory is this state. When the runtime
 * DOES emit native task events, they win: `nativeToolUse` suppresses synthesis for ids the
 * runtime claimed (a double registration would show every subagent twice), and `nativeIds`
 * remaps native task_ids onto the synthesized id so both streams describe ONE agent.
 */
export interface TaskSynthesisState {
  /** toolUseId -> taskType, for synthesized tasks still awaiting their tool_result close */
  open: Map<string, string>;
  /** native task_id -> canonical taskId (the synthesized tool_use id, when both exist) */
  nativeIds: Map<string, string>;
  /** tool_use ids the runtime claimed with a native task_started — never synthesize these */
  nativeToolUse: Set<string>;
}

export function createTaskSynthesisState(): TaskSynthesisState {
  return { open: new Map(), nativeIds: new Map(), nativeToolUse: new Set() };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A Task/Agent or shell tool_use opens a task the registry can show. Null for other tools. */
function synthesizeTaskStart(block: ContentBlockLike, tasks: TaskSynthesisState): TaskLifecycleEvent | null {
  if (!block.id || !block.name) return null;
  if (tasks.nativeToolUse.has(block.id)) return null;
  const input = block.input ?? {};
  if (AGENT_TOOLS.has(block.name)) {
    tasks.open.set(block.id, 'local_agent');
    return {
      type: 'task_lifecycle',
      subtype: 'task_started',
      taskId: block.id,
      toolUseId: block.id,
      taskType: 'local_agent',
      subagentType: asString(input['subagent_type']),
      description: asString(input['description']),
      prompt: asString(input['prompt']),
    };
  }
  if (SHELL_TOOLS.has(block.name)) {
    tasks.open.set(block.id, 'local_bash');
    return {
      type: 'task_lifecycle',
      subtype: 'task_started',
      taskId: block.id,
      toolUseId: block.id,
      taskType: 'local_bash',
      subagentType: null,
      // the command IS the description — that is what the History row shows
      description: asString(input['command'])?.slice(0, 500) ?? '(command)',
      prompt: null,
    };
  }
  return null;
}

/** The tool_result close for a synthesized task: status from is_error, summary for agents. */
function synthesizeTaskClose(block: ContentBlockLike, tasks: TaskSynthesisState): TaskLifecycleEvent[] {
  const id = block.tool_use_id;
  if (!id) return [];
  const taskType = tasks.open.get(id);
  if (!taskType) return [];
  tasks.open.delete(id);
  const status = block.is_error === true ? 'failed' : 'completed';
  const events: TaskLifecycleEvent[] = [
    { type: 'task_lifecycle', subtype: 'task_updated', taskId: id, status, endTime: new Date().toISOString() },
  ];
  // What an agent returned is its summary — the detail sheet's "what it came back with".
  // Commands skip this: their result text is transcript noise, not a conclusion.
  const summary = taskType === 'local_agent' ? resultText(block.content).trim() : '';
  if (summary) {
    events.push({ type: 'task_lifecycle', subtype: 'task_notification', taskId: id, status, summary: summary.slice(0, 2000) });
  }
  return events;
}

function mapNativeTaskEvent(msg: MessageLike, tasks: TaskSynthesisState): WorkerEvent[] {
  const rawId = msg.task_id;
  if (!rawId) return [{ type: 'opaque', raw: msg }];
  const usage = msg.usage
    ? { totalTokens: msg.usage.total_tokens ?? null, toolUses: msg.usage.tool_uses ?? null, durationMs: msg.usage.duration_ms ?? null }
    : null;

  if (msg.subtype === 'task_started') {
    const toolUseId = msg.tool_use_id ?? null;
    let canonical = rawId;
    if (toolUseId) {
      tasks.nativeToolUse.add(toolUseId);
      // If we already synthesized this task from the tool_use, the native stream is
      // describing the SAME agent — adopt the synthesized id and hand the close to the
      // native task_notification (drop the pending tool_result close).
      if (tasks.open.has(toolUseId)) {
        canonical = toolUseId;
        tasks.open.delete(toolUseId);
      }
    }
    tasks.nativeIds.set(rawId, canonical);
    return [{
      type: 'task_lifecycle',
      subtype: 'task_started',
      taskId: canonical,
      toolUseId,
      taskType: msg.task_type ?? 'local_agent',
      subagentType: msg.subagent_type ?? null,
      description: msg.description ?? null,
      prompt: asString(msg.prompt),
      timestamp: msg.timestamp ?? null,
    }];
  }

  const taskId = tasks.nativeIds.get(rawId) ?? rawId;
  if (msg.subtype === 'task_progress') {
    return [{
      type: 'task_lifecycle',
      subtype: 'task_progress',
      taskId,
      description: msg.description ?? null,
      lastToolName: msg.last_tool_name ?? null,
      usage,
      timestamp: msg.timestamp ?? null,
    }];
  }
  if (msg.subtype === 'task_updated') {
    return [{
      type: 'task_lifecycle',
      subtype: 'task_updated',
      taskId,
      status: msg.patch?.status ?? null,
      endTime: msg.patch?.end_time ?? null,
      timestamp: msg.timestamp ?? null,
    }];
  }
  // task_notification
  return [{
    type: 'task_lifecycle',
    subtype: 'task_notification',
    taskId,
    status: msg.status ?? null,
    summary: typeof msg.summary === 'string' ? msg.summary : null,
    outputFile: msg.output_file ?? null,
    usage,
    timestamp: msg.timestamp ?? null,
  }];
}

const NATIVE_TASK_SUBTYPES = new Set(['task_started', 'task_progress', 'task_updated', 'task_notification']);

/**
 * Map one SDK message to zero or more normalized events. Exported for direct testing.
 *
 * `tasks` carries the cross-message memory task synthesis needs (see TaskSynthesisState);
 * the adapter threads one instance through a session's whole stream. The default keeps
 * single-message callers working — they just never see a synthesized close.
 */
export function mapMessage(raw: unknown, tasks: TaskSynthesisState = createTaskSynthesisState()): WorkerEvent[] {
  const msg = raw as MessageLike;
  const events: WorkerEvent[] = [];

  switch (msg?.type) {
    case 'assistant': {
      const parent = msg.parent_tool_use_id ?? null;
      const blocks = Array.isArray(msg.message?.content) ? (msg.message?.content as ContentBlockLike[]) : [];
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          // Only TOP-LEVEL turns speak for the worker — subagent text once retired a
          // whole spec in the prototype (B11).
          events.push({ type: 'assistant_text', text: block.text, topLevel: parent === null });
        }
        if (block.type === 'tool_use' && block.id && block.name) {
          events.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input ?? {},
            parentToolUseId: parent,
          });
          const started = synthesizeTaskStart(block, tasks);
          if (started) events.push(started);
        }
      }
      return events;
    }

    case 'user': {
      const blocks = Array.isArray(msg.message?.content) ? (msg.message?.content as ContentBlockLike[]) : [];
      for (const block of blocks) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          events.push({
            type: 'tool_result',
            toolUseId: block.tool_use_id,
            isError: block.is_error === true,
            text: resultText(block.content),
          });
          events.push(...synthesizeTaskClose(block, tasks));
        }
      }
      return events;
    }

    case 'system': {
      if (msg.subtype && NATIVE_TASK_SUBTYPES.has(msg.subtype)) return mapNativeTaskEvent(msg, tasks);
      return [{ type: 'opaque', raw }];
    }

    case 'rate_limit_event': {
      const info = msg.rate_limit_info ?? {};
      const mapped: RateLimitInfo = {
        status: info.status ?? null,
        resetsAt: info.resetsAt ?? null,
        utilization: info.utilization ?? null,
        rateLimitType: info.rateLimitType ?? null,
        overageStatus: info.overageStatus ?? null,
        isUsingOverage: info.isUsingOverage ?? null,
      };
      return [{ type: 'rate_limit', info: mapped }];
    }

    case 'result': {
      const envelope: ResultEnvelope = {
        total_cost_usd: msg.total_cost_usd,
        num_turns: msg.num_turns,
        session_id: msg.session_id ?? null,
        api_error_status: msg.api_error_status ?? null,
        is_error: msg.is_error ?? null,
        result: msg.result ?? null,
      };
      return [{ type: 'result', envelope }];
    }

    default:
      return [{ type: 'opaque', raw }];
  }
}

/* ------------------------------------------------------------ protected-path denial ---- */

const WRITING_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

function normalize(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

/** Does this tool call write inside a protected path? Exported for direct testing. */
export function violatesProtectedPaths(
  toolName: string,
  input: Record<string, unknown>,
  protectedPaths: readonly string[],
  exceptions: readonly string[] = [],
): string | null {
  if (!WRITING_TOOLS.has(toolName)) return null;
  const target = input['file_path'] ?? input['notebook_path'];
  if (!target) return null;
  const p = normalize(String(target));
  // The packet may promise one file inside a protected dir (the parked-items append).
  // A promise the hook then denies is B25 mirrored — the exception must be enforced too.
  if (exceptions.some((e) => p.includes(normalize(e)))) return null;
  for (const protectedPath of protectedPaths) {
    const needle = normalize(protectedPath);
    if (p.includes(needle)) return protectedPath;
  }
  return null;
}

/**
 * The PreToolUse hook that actually enforces protectedPaths.
 *
 * Proven necessary by the first live smoke: under `permissionMode: 'bypassPermissions'`
 * the SDK warns `canUseTool will not be invoked … auto-approves every tool call … use a
 * PreToolUse hook instead`. So an adapter relying on canUseTool alone was ADVERTISING the
 * guardrail, not enforcing it — the exact B25 defect class this layer exists to kill.
 * The hook path fires in every permission mode; canUseTool stays as the belt for
 * prompting modes.
 */
export function protectedPathsHook(protectedPaths: readonly string[], exceptions: readonly string[] = []) {
  return async (input: unknown): Promise<Record<string, unknown>> => {
    const hook = input as { hook_event_name?: string; tool_name?: string; tool_input?: unknown };
    if (hook?.hook_event_name !== 'PreToolUse') return {};
    const violation = violatesProtectedPaths(
      String(hook.tool_name ?? ''),
      (hook.tool_input ?? {}) as Record<string, unknown>,
      protectedPaths,
      exceptions,
    );
    if (!violation) {
      // EXPLICIT allow, not a silent fall-through. A fall-through re-enters the host's
      // permission machinery, where an unattended session has no one to answer a prompt:
      // live run 011 had gate seats' in-worktree reads and subagent Bash answered with
      // "The user doesn't want to take this action right now" (a founder-side sentinel
      // hook armed on this machine), classified blocked, and the spec parked. The policy
      // IS bypass-except-protected — say so where every permission mode listens.
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'Spicyspec: unattended worker — allowed by policy (guardrails are the denylist and protected paths).',
        },
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Spicyspec: "${violation}" is a protected path — orchestrator state is never worker-writable (RFC-001 §7.6).`,
      },
    };
  };
}

/**
 * Mirror every `Bash(...)` disallow pattern with a `PowerShell(...)` twin. On Windows the
 * CLI, seeing Bash-targeting rules with no PowerShell counterpart, appends a BARE
 * PowerShell deny — silently disabling the entire PowerShell tool for the session. The
 * guardrail's intent is the command pattern, not the shell it arrives through.
 */
export function mirrorShellPatterns(disallowed: readonly string[] | undefined): string[] | undefined {
  if (!disallowed) return undefined;
  const out = [...disallowed];
  for (const rule of disallowed) {
    const m = /^Bash\((.+)\)$/.exec(rule);
    if (m) {
      const twin = `PowerShell(${m[1]})`;
      if (!out.includes(twin)) out.push(twin);
    }
  }
  return out;
}

/* -------------------------------------------------------------------- the adapter ---- */

export interface ClaudeAdapterOptions {
  /** injectable SDK entrypoint; defaults to the real @anthropic-ai/claude-agent-sdk */
  queryFn?: QueryFn;
}

async function defaultQueryFn(): Promise<QueryFn> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return sdk.query as unknown as QueryFn;
}

export function createClaudeAdapter(adapterOptions: ClaudeAdapterOptions = {}): ProviderAdapter {
  return {
    id: 'claude',

    createSession(options: SessionOptions): WorkerSession {
      let live: QueryLike | null = null;
      let interrupted = false;

      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ...options.account.env,
        // Headless Task subagents otherwise default to DETACHED background agents
        // (CLI 2.1.241: run_in_background defaults on for non-teammate spawns), which get
        // shouldAvoidPermissionPrompts and tombstone their in-flight tool calls with
        // "The user doesn't want to take this action right now" when the turn ends —
        // live gate seats died on exactly that and parked healthy specs (009/011/013).
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      };
      if (options.account.configDir) env['CLAUDE_CONFIG_DIR'] = options.account.configDir;

      const protectedPaths = options.protectedPaths ?? [];
      const exceptions = options.protectedPathExceptions ?? [];

      const sdkOptions: Record<string, unknown> = {
        cwd: options.cwd,
        env,
        model: options.model,
        effort: options.effort,
        // The worker runs unattended; guardrails are the denylist + the PreToolUse hook
        // below, both ENFORCED by the runtime rather than advertised in a prompt (B25).
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        disallowedTools: mirrorShellPatterns(options.disallowedTools),
        // PreToolUse fires in EVERY permission mode — bypassPermissions skips canUseTool
        // entirely (SDK CLAUDE_SDK_CAN_USE_TOOL_SHADOWED warning, caught by live smoke).
        hooks: { PreToolUse: [{ hooks: [protectedPathsHook(protectedPaths, exceptions)] }] },
        // Project-scope settings only: the prototype burned a full session replying to a
        // user-tier chat hook (tick 27 / B31) — a headless worker loads repo config, never
        // the operator's personal tier.
        settingSources: ['project', 'local'],
        // NO canUseTool here — deliberately. bypassPermissions never consults it in the
        // main loop, but merely PASSING it arms the CLI's requireCanUseTool path, which
        // runs the full permission pipeline for SUBAGENT tool calls even when the
        // PreToolUse hook answers allow. The hook (above) is the single enforcement
        // point; it fires in every permission mode and inside subagents.
        ...(options.vendorOptions ?? {}),
      };

      async function* stream(): AsyncGenerator<WorkerEvent> {
        const queryFn = adapterOptions.queryFn ?? (await defaultQueryFn());
        live = queryFn({ prompt: options.prompt, options: sdkOptions });
        // One synthesis state per session — task opens and closes pair across messages.
        const tasks = createTaskSynthesisState();
        try {
          for await (const raw of live) {
            if (interrupted) break;
            yield* mapMessage(raw, tasks);
          }
        } finally {
          live = null;
        }
      }

      return {
        events: () => stream(),
        // Best-effort immediate stop; must never orphan the underlying process (B12).
        async interrupt() {
          interrupted = true;
          try {
            await live?.interrupt?.();
          } finally {
            live?.close?.();
          }
        },
      };
    },
  };
}
