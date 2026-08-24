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
  parent_tool_use_id?: string | null;
  message?: { content?: unknown };
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

/** Map one SDK message to zero or more normalized events. Exported for direct testing. */
export function mapMessage(raw: unknown): WorkerEvent[] {
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
        }
      }
      return events;
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
        disallowedTools: options.disallowedTools,
        // PreToolUse fires in EVERY permission mode — bypassPermissions skips canUseTool
        // entirely (SDK CLAUDE_SDK_CAN_USE_TOOL_SHADOWED warning, caught by live smoke).
        hooks: { PreToolUse: [{ hooks: [protectedPathsHook(protectedPaths, exceptions)] }] },
        // Project-scope settings only: the prototype burned a full session replying to a
        // user-tier chat hook (tick 27 / B31) — a headless worker loads repo config, never
        // the operator's personal tier.
        settingSources: ['project', 'local'],
        canUseTool: (toolName: string, input: Record<string, unknown>) => {
          const hit = violatesProtectedPaths(toolName, input, protectedPaths, exceptions);
          if (hit) {
            return Promise.resolve({
              behavior: 'deny' as const,
              message: `Spicyspec: "${hit}" is a protected path — orchestrator state is never worker-writable (RFC-001 §7.6).`,
            });
          }
          return Promise.resolve({ behavior: 'allow' as const, updatedInput: input });
        },
        ...(options.vendorOptions ?? {}),
      };

      async function* stream(): AsyncGenerator<WorkerEvent> {
        const queryFn = adapterOptions.queryFn ?? (await defaultQueryFn());
        live = queryFn({ prompt: options.prompt, options: sdkOptions });
        try {
          for await (const raw of live) {
            if (interrupted) break;
            yield* mapMessage(raw);
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
