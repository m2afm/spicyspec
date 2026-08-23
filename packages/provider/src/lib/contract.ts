/**
 * The provider contract — RFC-001 layer 1.
 *
 * One adapter per AI vendor. Adding a new AI to Spicyspec = implementing this interface in
 * a new package; the orchestrator, evidence layer, and account pool never know which vendor
 * is underneath. Events are normalized here so the evidence layer (core `harvest`) and the
 * classifier (core `classify`) work identically across vendors.
 *
 * Design constraints carried from the prototype:
 * - Every event keeps `parentToolUseId` — only TOP-LEVEL assistant turns speak for a worker;
 *   a subagent's text once retired a whole spec (defect B11).
 * - Rate-limit and result envelopes are first-class events, not parsed prose.
 * - `interrupt()` must exist: an orchestrator that cannot kill its worker orphans it (B12).
 */
import type { RateLimitInfo, ResultEnvelope } from '@spicyspec/core';

export interface ProviderAccountRef {
  id: string;
  /** extra environment for the session process (tokens etc. — injected by the runner) */
  env: Record<string, string>;
  /** vendor-specific config directory (e.g. CLAUDE_CONFIG_DIR), when the vendor has one */
  configDir: string | null;
}

export interface SessionOptions {
  /** the work packet — the full prompt the worker session starts from */
  prompt: string;
  /** repository the session works in */
  cwd: string;
  account: ProviderAccountRef;
  model?: string;
  effort?: string;
  /** tool patterns the session must not use (enforced by the vendor runtime where possible) */
  disallowedTools?: string[];
  /**
   * Paths the session must never write. ENFORCED via the vendor's permission hook — an
   * advertised-but-unenforced guardrail is a defect (prototype B25, RFC-001 §7.6).
   */
  protectedPaths?: string[];
  /**
   * Exceptions inside protected paths (e.g. the parked-items file the packet tells the
   * worker to append to). A promise in the prompt that the hook then denies is the same
   * defect class as B25, mirrored.
   */
  protectedPathExceptions?: string[];
  /** free-form vendor extras; adapters validate what they understand */
  vendorOptions?: Record<string, unknown>;
}

/* ------------------------------------------------------------ normalized events ---- */

export interface ToolUseEvent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  parentToolUseId: string | null;
}

export interface ToolResultEvent {
  type: 'tool_result';
  toolUseId: string;
  isError: boolean;
  text: string;
}

export interface AssistantTextEvent {
  type: 'assistant_text';
  text: string;
  /** true only when this text is a top-level worker turn — subagent text is data, not voice */
  topLevel: boolean;
}

export interface RateLimitEvent {
  type: 'rate_limit';
  info: RateLimitInfo;
}

export interface ResultEvent {
  type: 'result';
  envelope: ResultEnvelope;
}

/** Anything the adapter saw but does not understand; kept for the evidence log, never acted on. */
export interface OpaqueEvent {
  type: 'opaque';
  raw: unknown;
}

export type WorkerEvent =
  | ToolUseEvent
  | ToolResultEvent
  | AssistantTextEvent
  | RateLimitEvent
  | ResultEvent
  | OpaqueEvent;

/* ------------------------------------------------------------------- the adapter ---- */

export interface WorkerSession {
  /** normalized event stream; ends when the session ends */
  events(): AsyncIterable<WorkerEvent>;
  /** best-effort immediate stop; must never leave an orphaned process (B12) */
  interrupt(): Promise<void>;
}

export interface ProviderAdapter {
  /** stable vendor id: 'claude', 'kimi', 'glm', … */
  readonly id: string;
  createSession(options: SessionOptions): WorkerSession;
}

/* ---------------------------------------------------------------- session summary ---- */

export interface SessionOutcome {
  envelope: ResultEnvelope | null;
  rateLimit: RateLimitInfo | null;
  /** concatenated TOP-LEVEL assistant text — the worker's own voice only (B11) */
  text: string;
  toolCalls: number;
}

/**
 * Drain a session into the summary the classifier consumes. The orchestrator's activity
 * uses this; anything needing raw events (the evidence log) taps the stream instead.
 */
export async function collectSession(session: WorkerSession): Promise<SessionOutcome> {
  let envelope: ResultEnvelope | null = null;
  let rateLimit: RateLimitInfo | null = null;
  const text: string[] = [];
  let toolCalls = 0;

  for await (const event of session.events()) {
    switch (event.type) {
      case 'result':
        envelope = event.envelope;
        break;
      case 'rate_limit':
        rateLimit = event.info;
        break;
      case 'assistant_text':
        if (event.topLevel) text.push(event.text);
        break;
      case 'tool_use':
        toolCalls += 1;
        break;
      default:
        break;
    }
  }

  return { envelope, rateLimit, text: text.join('\n'), toolCalls };
}
