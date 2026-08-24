/**
 * Per-run session logs — the Current-tick live feed's source.
 *
 * Each run writes `.spicyspec/runs/<specId>-r<run>-<startedMs>/`:
 *   meta.json      { number, spec, stage, account, startedAt, complete: true }
 *   stream.jsonl   the session's events, re-serialized into the prototype's stream-json
 *                  shape — the vendored agents registry ingests that shape unchanged.
 *
 * Grew out of the third "it says starting up but nothing is done" report: a session an
 * hour deep in real work looked dead because the panel had no source. A liveness view
 * that cannot show liveness is worse than none (the prototype's B40 in reverse).
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskLifecycleEvent, TaskLifecycleUsage, WorkerEvent } from '@spicyspec/provider';

export interface SessionLogMeta {
  number: number;
  spec: string;
  stage: string;
  account: string;
  startedAt: string;
}

export interface SessionLog {
  dir: string;
  write(event: unknown): void;
  close(): void;
}

/** snake_case usage in the registry's shape, absent fields dropped rather than nulled. */
function usageLine(usage: TaskLifecycleUsage | null | undefined): Record<string, number> | undefined {
  if (!usage) return undefined;
  const out: Record<string, number> = {};
  if (typeof usage.totalTokens === 'number') out['total_tokens'] = usage.totalTokens;
  if (typeof usage.toolUses === 'number') out['tool_uses'] = usage.toolUses;
  if (typeof usage.durationMs === 'number') out['duration_ms'] = usage.durationMs;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Task lifecycle → the prototype's `{type:'system', subtype:'task_*'}` lines, field for
 * field what agents.mjs ingest() reads. This is the wire the History tab and the agents
 * grid hang off: before it existed, stream.jsonl carried no task_started lines, so the
 * only agent ever registered was the root session and History was permanently empty.
 */
function taskLifecycleLine(event: TaskLifecycleEvent): string {
  const base: Record<string, unknown> = { type: 'system', subtype: event.subtype, task_id: event.taskId };
  if (event.timestamp) base['timestamp'] = event.timestamp;
  switch (event.subtype) {
    case 'task_started':
      return JSON.stringify({
        ...base,
        tool_use_id: event.toolUseId ?? null,
        task_type: event.taskType ?? 'local_agent',
        subagent_type: event.subagentType ?? null,
        description: event.description ?? null,
        prompt: event.prompt ?? null,
      });
    case 'task_progress':
      return JSON.stringify({
        ...base,
        description: event.description ?? null,
        last_tool_name: event.lastToolName ?? null,
        usage: usageLine(event.usage),
      });
    case 'task_updated':
      // patchAgent only acts on truthy patch fields — null end_time is "no close time",
      // never an Invalid Date.
      return JSON.stringify({ ...base, patch: { status: event.status ?? null, end_time: event.endTime ?? null } });
    case 'task_notification':
      return JSON.stringify({
        ...base,
        status: event.status ?? null,
        summary: event.summary ?? null,
        output_file: event.outputFile ?? null,
        usage: usageLine(event.usage),
      });
  }
}

/** One session event → the prototype stream-json line the agents registry understands. */
export function toStreamLine(event: WorkerEvent): string | null {
  switch (event.type) {
    case 'task_lifecycle':
      return taskLifecycleLine(event);
    case 'result':
      // Closes the ROOT agent. Without this line the worker session itself stayed
      // 'running' forever, so History's `status !== 'running'` filter never matched it.
      return JSON.stringify({
        type: 'result',
        is_error: event.envelope.is_error === true,
        result: typeof event.envelope.result === 'string' ? event.envelope.result.slice(0, 2000) : null,
      });
    case 'tool_use':
      return JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: event.parentToolUseId,
        message: { content: [{ type: 'tool_use', id: event.id, name: event.name, input: event.input }] },
      });
    case 'tool_result':
      return JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: event.toolUseId, is_error: event.isError, content: event.text.slice(0, 2000) }] },
      });
    case 'assistant_text':
      // Only the worker's own voice reaches the feed root; subagent text is grouped by the
      // tool_use ids above, and unattributed text would smear across agents.
      return event.topLevel
        ? JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: event.text.slice(0, 2000) }] } })
        : null;
    default:
      return null;
  }
}

export function openSessionLogDir(runsRoot: string, meta: SessionLogMeta): SessionLog {
  const dir = join(runsRoot, `${meta.spec}-r${meta.number}-${Date.parse(meta.startedAt)}`);
  mkdirSync(dir, { recursive: true });
  // complete:true from the first write — our meta never has the prototype's 555ms
  // identity race (B39): the writer IS the identity source.
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...meta, complete: true }), 'utf8');
  const streamPath = join(dir, 'stream.jsonl');
  writeFileSync(streamPath, '', 'utf8');
  return {
    dir,
    write(event: unknown): void {
      try {
        const line = toStreamLine(event as WorkerEvent);
        if (line) appendFileSync(streamPath, line + '\n', 'utf8');
      } catch {
        /* the feed must never break the session it describes */
      }
    },
    close(): void {
      try {
        appendFileSync(streamPath, JSON.stringify({ type: 'session_end' }) + '\n', 'utf8');
      } catch {
        /* best effort */
      }
    },
  };
}
