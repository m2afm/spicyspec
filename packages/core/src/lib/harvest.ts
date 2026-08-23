/**
 * Harvest independently-verifiable facts from a worker session's event stream — the
 * evidence layer (RFC-001 §7.1), and the platform's moat.
 *
 * Exists because of a hole the prototype's second-vendor tracker found on its first run:
 * every quality claim — tests green, gate approved, coverage met — reached the record only
 * as the worker's narration of itself. A worker that fabricated an APPROVE, or claimed a
 * suite passed that it never ran, was undetectable.
 *
 * But the stream contains `tool_use` and matching `tool_result` blocks, so the real
 * commands and their real output are on disk. This module pairs them and reports what
 * ACTUALLY happened: which verification commands ran, what they returned, which subagents
 * were dispatched, whether record files were genuinely written. A judge then weighs the
 * worker's story against machine facts rather than against the story itself.
 *
 * Pure: operates on stream TEXT. No filesystem, no worker text trusted.
 */

const OUTPUT_TAIL = 600;
const MAX_COMMANDS = 40;

/** Commands that constitute verification. Extend per project via `extraPatterns`. */
export const DEFAULT_VERIFICATION_PATTERNS: RegExp[] = [
  /\bnx\s+(run-many|run|test|e2e|build|lint|affected|typecheck)/,
  /\bjest\b/,
  /\bvitest\b/,
  /\bplaywright\b/,
  /\btsc\b|typecheck/,
  /\bcargo\s+(test|check|clippy)\b/,
  /\bpytest\b/,
  /\bgo\s+(test|vet)\b/,
];

/** Files whose modification is the difference between a recorded gate and a claimed one. */
export const DEFAULT_RECORD_FILES: RegExp[] = [/REVIEWS\.md$/i, /DECISIONS\.md$/i, /HANDOFF\.md$/i, /tasks\.md$/i, /gates\.jsonl$/i];

interface ContentBlock {
  type?: string;
  id?: string;
  tool_use_id?: string;
  name?: string;
  input?: Record<string, unknown>;
  is_error?: boolean;
  content?: unknown;
  text?: string;
}

function textOf(block: ContentBlock | undefined): string {
  if (!block) return '';
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c as ContentBlock)?.text ?? '').join('');
  return '';
}

export type CommandOutcome = 'passed' | 'failed' | 'unknown';

/**
 * A command's outcome, judged from its own output rather than from anyone's summary.
 * Deliberately conservative: `unknown` when the output does not clearly say.
 */
export function outcomeOf(output: string, isError: boolean): CommandOutcome {
  if (isError) return 'failed';
  if (/\b(\d+)\s+failed\b/i.test(output) && !/\b0\s+failed\b/i.test(output)) return 'failed';
  if (/\bFAIL\b/.test(output)) return 'failed';
  if (/error TS\d+|ERROR in |Command failed|exit code [1-9]/i.test(output)) return 'failed';
  if (/\b(\d+)\s+pass(ed|ing)\b/i.test(output) || /Tests:.*\bpassed\b/i.test(output)) return 'passed';
  if (/Successfully ran target/i.test(output)) return 'passed';
  if (/\bexit 0\b/.test(output)) return 'passed';
  return 'unknown';
}

export interface VerificationFact {
  command: string;
  outcome: CommandOutcome;
  returned: boolean;
  tail: string;
}

export interface SubagentFact {
  subagent: string;
  description: string;
  returned: boolean;
  verdictTail: string;
}

export interface RecordWriteFact {
  file: string;
  tool: string;
  applied: boolean;
}

export interface ResidueFact {
  file: string;
  marker: string;
}

export interface Harvest {
  verification: VerificationFact[];
  subagents: SubagentFact[];
  recordWrites: RecordWriteFact[];
  redFirstResidue: ResidueFact[];
  toolCalls: number;
  errors: number;
}

export interface HarvestOptions {
  extraVerificationPatterns?: RegExp[];
  recordFilePatterns?: RegExp[];
}

export interface ToolUseLike {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultLike {
  isError: boolean;
  text: string;
}

/**
 * Structural event shape shared with the provider layer's normalized WorkerEvent — core
 * cannot import the provider package (dependency direction), so the contract is
 * structural: anything carrying these fields harvests identically.
 */
export type HarvestableEvent =
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; isError: boolean; text: string }
  | { type: string };

/** Harvest directly from normalized events — the live activity path (no JSONL round-trip). */
export function harvestEvents(events: Iterable<HarvestableEvent>, options: HarvestOptions = {}): Harvest {
  const uses = new Map<string, ToolUseLike>();
  const results = new Map<string, ToolResultLike>();
  for (const event of events) {
    if (event.type === 'tool_use') {
      const e = event as Extract<HarvestableEvent, { type: 'tool_use' }>;
      uses.set(e.id, { id: e.id, name: e.name, input: e.input });
    } else if (event.type === 'tool_result') {
      const e = event as Extract<HarvestableEvent, { type: 'tool_result' }>;
      results.set(e.toolUseId, { isError: e.isError, text: e.text });
    }
  }
  return buildHarvest(uses, results, options);
}

/** Pair tool_use↔tool_result across a stream-JSONL transcript and extract machine facts. */
export function harvestStream(streamText: string, options: HarvestOptions = {}): Harvest {
  const uses = new Map<string, ToolUseLike>();
  const results = new Map<string, ToolResultLike>();

  for (const line of streamText.split('\n')) {
    if (!line.trim()) continue;
    let event: { message?: { content?: ContentBlock[] } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use' && block.id && block.name) {
        uses.set(block.id, { id: block.id, name: block.name, input: block.input ?? {} });
      }
      if (block.type === 'tool_result' && block.tool_use_id) {
        results.set(block.tool_use_id, { isError: block.is_error === true, text: textOf(block) });
      }
    }
  }
  return buildHarvest(uses, results, options);
}

function buildHarvest(
  uses: ReadonlyMap<string, ToolUseLike>,
  results: ReadonlyMap<string, ToolResultLike>,
  options: HarvestOptions,
): Harvest {
  const verificationPatterns = [...DEFAULT_VERIFICATION_PATTERNS, ...(options.extraVerificationPatterns ?? [])];
  const recordFiles = options.recordFilePatterns ?? DEFAULT_RECORD_FILES;

  const verification: VerificationFact[] = [];
  const subagents: SubagentFact[] = [];
  const recordWrites: RecordWriteFact[] = [];
  let errors = 0;

  for (const [id, use] of uses) {
    const result = results.get(id);
    const output = result?.text ?? '';
    const isError = result?.isError === true;
    if (isError) errors += 1;

    if (use.name === 'Bash' && use.input?.['command']) {
      const command = String(use.input['command']).replace(/\s+/g, ' ').trim();
      if (verificationPatterns.some((re) => re.test(command))) {
        verification.push({
          command: command.slice(0, 220),
          outcome: outcomeOf(output, isError),
          returned: Boolean(result),
          tail: output.slice(-OUTPUT_TAIL),
        });
      }
    }

    if (use.name === 'Agent' || use.name === 'Task') {
      subagents.push({
        subagent: String(use.input?.['subagent_type'] ?? use.input?.['agentType'] ?? 'unspecified'),
        description: String(use.input?.['description'] ?? '').slice(0, 120),
        returned: Boolean(result),
        verdictTail: output.slice(-OUTPUT_TAIL),
      });
    }

    if ((use.name === 'Write' || use.name === 'Edit') && use.input?.['file_path']) {
      const path = String(use.input['file_path']).replace(/\\/g, '/');
      if (recordFiles.some((re) => re.test(path))) {
        recordWrites.push({
          file: path.split('/').slice(-2).join('/'),
          tool: String(use.name),
          applied: Boolean(result) && !isError,
        });
      }
    }
  }

  return {
    verification: verification.slice(-MAX_COMMANDS),
    subagents,
    recordWrites,
    redFirstResidue: residueFromWrites(writesOf(uses)),
    toolCalls: uses.size,
    errors,
  };
}

/** Ordered Write/Edit calls — map insertion order is stream order, so last write wins. */
function writesOf(uses: ReadonlyMap<string, ToolUseLike>): Array<{ path: string; body: string }> {
  const writes: Array<{ path: string; body: string }> = [];
  for (const use of uses.values()) {
    if (use.name !== 'Write' && use.name !== 'Edit') continue;
    const path = use.input?.['file_path'];
    if (!path) continue;
    writes.push({
      path: String(path),
      body: String(use.input?.['content'] ?? use.input?.['new_string'] ?? ''),
    });
  }
  return writes;
}

/**
 * Red-first leaves the tree deliberately broken for minutes at a time — a guard commented
 * out, a condition short-circuited with `false &&` — to prove a test actually fails
 * without it. That is the discipline working. Its one failure mode: a session that dies
 * between "break it" and "restore it" leaves the disabled guard for the next worker.
 *
 * So: scan the session's own edits for the markers and report which files still carried
 * one when the session ended. Tree state is the arbiter of whether it matters — a marker
 * in an uncommitted file the next run reconciles is fine; in a COMMITTED file it is a
 * live defect (prototype defect B30).
 */
const RED_FIRST_MARKERS: RegExp[] = [
  /RED[- ]FIRST/i,
  /\bif\s*\(\s*false\s*&&/,
  /predicate dropped/i,
  /guard (?:disabled|removed|dropped)/i,
  /precondition disabled/i,
];

/**
 * Only production source can carry a disabled guard. Prose that *describes* red-first is
 * not a defect: the prototype's first detector flagged six files per session — task lists,
 * the baton, notes, and the test files themselves — of which exactly one mattered. A
 * detector with a 6:1 false-positive rate is worse than no detector (B30's second lesson).
 */
export function isProductionSource(path: string): boolean {
  const p = path.replace(/\\/g, '/').toLowerCase();
  if (!/\.(ts|tsx|js|mjs|cjs)$/.test(p)) return false;
  if (/\.(spec|test|int\.spec|e2e)\.[jt]sx?$/.test(p)) return false;
  if (/(^|\/)(scratchpad|node_modules|dist|\.specify)\//.test(p)) return false;
  return true;
}

export function residueFromWrites(writes: ReadonlyArray<{ path: string; body: string }>): ResidueFact[] {
  const touched = new Map<string, string | null>();
  for (const { path, body } of writes) {
    if (!isProductionSource(path)) continue;
    const hit = RED_FIRST_MARKERS.find((re) => re.test(body));
    // Last write wins: a later restore clears an earlier break.
    touched.set(path, hit ? hit.source : null);
  }
  return [...touched.entries()]
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([path, marker]) => ({
      file: path.replace(/\\/g, '/').split('/').slice(-3).join('/'),
      marker,
    }));
}

/** Stream-text convenience wrapper — same rules, JSONL in. */
export function redFirstResidue(streamText: string): ResidueFact[] {
  const writes: Array<{ path: string; body: string }> = [];
  for (const line of streamText.split('\n')) {
    if (!line.trim()) continue;
    let event: { message?: { content?: ContentBlock[] } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    for (const block of event.message?.content ?? []) {
      if (block.type !== 'tool_use') continue;
      if (block.name !== 'Write' && block.name !== 'Edit') continue;
      const path = block.input?.['file_path'];
      if (!path) continue;
      writes.push({ path: String(path), body: String(block.input?.['content'] ?? block.input?.['new_string'] ?? '') });
    }
  }
  return residueFromWrites(writes);
}

export interface HarvestSummary {
  toolCalls: number;
  toolErrors: number;
  verificationCommandsRun: number;
  verificationOutcomes: Partial<Record<CommandOutcome, number>>;
  verificationCommands: Array<{ command: string; outcome: CommandOutcome }>;
  failingCommands: Array<{ command: string; tail: string }>;
  subagentsDispatched: Array<{ subagent: string; description: string; returned: boolean }>;
  subagentVerdictTails: string[];
  recordFilesWritten: RecordWriteFact[];
  redFirstResidue: ResidueFact[];
}

/** A compact, judge-facing summary. Keeps the prompt small and the claims checkable. */
export function summariseHarvest(h: Harvest): HarvestSummary {
  const byOutcome: Partial<Record<CommandOutcome, number>> = {};
  for (const v of h.verification) byOutcome[v.outcome] = (byOutcome[v.outcome] ?? 0) + 1;
  return {
    toolCalls: h.toolCalls,
    toolErrors: h.errors,
    verificationCommandsRun: h.verification.length,
    verificationOutcomes: byOutcome,
    verificationCommands: h.verification.map((v) => ({ command: v.command, outcome: v.outcome })),
    failingCommands: h.verification.filter((v) => v.outcome === 'failed').map((v) => ({ command: v.command, tail: v.tail })),
    subagentsDispatched: h.subagents.map((s) => ({ subagent: s.subagent, description: s.description, returned: s.returned })),
    subagentVerdictTails: h.subagents.map((s) => s.verdictTail).filter(Boolean),
    recordFilesWritten: h.recordWrites,
    redFirstResidue: h.redFirstResidue,
  };
}
