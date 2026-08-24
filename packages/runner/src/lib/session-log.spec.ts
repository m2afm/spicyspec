/**
 * Session-log suite — proves the stream.jsonl wire format against its one real consumer:
 * the vendored agents registry (packages/control-plane/room/agents.mjs), imported directly
 * so a serialization drift fails HERE, not as an empty History tab in a live run.
 */
import { describe, expect, it } from 'vitest';
import type { TaskLifecycleEvent, WorkerEvent } from '@spicyspec/provider';
import { toStreamLine } from './session-log.js';

interface AgentsModule {
  createRegistry(meta?: Record<string, unknown>): { agents: Map<string, Record<string, unknown>>; counts: Record<string, number> };
  ingest(reg: unknown, event: unknown): string[];
  ROOT_ID: string;
}

const agentsMjs = (await import(
  new URL('../../../control-plane/room/agents.mjs', import.meta.url).href
)) as unknown as AgentsModule;

const parse = (event: WorkerEvent): Record<string, unknown> => {
  const line = toStreamLine(event);
  expect(line).toBeTypeOf('string');
  return JSON.parse(line as string) as Record<string, unknown>;
};

const started = (over: Partial<TaskLifecycleEvent> = {}): TaskLifecycleEvent => ({
  type: 'task_lifecycle',
  subtype: 'task_started',
  taskId: 'tu_1',
  toolUseId: 'tu_1',
  taskType: 'local_agent',
  subagentType: 'qa-critic',
  description: 'gate review',
  prompt: 'review the diff',
  ...over,
});

describe('toStreamLine task_lifecycle serialization', () => {
  it('task_started serializes as the system line the registry ingests, field for field', () => {
    expect(parse(started())).toEqual({
      type: 'system',
      subtype: 'task_started',
      task_id: 'tu_1',
      tool_use_id: 'tu_1',
      task_type: 'local_agent',
      subagent_type: 'qa-critic',
      description: 'gate review',
      prompt: 'review the diff',
    });
  });

  it('task_updated wraps status/end_time in patch — the shape patchAgent reads', () => {
    const line = parse({ type: 'task_lifecycle', subtype: 'task_updated', taskId: 'tu_1', status: 'completed', endTime: '2026-08-24T00:00:00.000Z' });
    expect(line).toEqual({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'tu_1',
      patch: { status: 'completed', end_time: '2026-08-24T00:00:00.000Z' },
    });
  });

  it('task_progress and task_notification carry snake_case usage, absent fields dropped', () => {
    const progress = parse({
      type: 'task_lifecycle', subtype: 'task_progress', taskId: 'tu_1',
      description: 'reading', lastToolName: 'Read',
      usage: { totalTokens: 900, toolUses: 3, durationMs: 1200 },
    });
    expect(progress).toEqual({
      type: 'system', subtype: 'task_progress', task_id: 'tu_1',
      description: 'reading', last_tool_name: 'Read',
      usage: { total_tokens: 900, tool_uses: 3, duration_ms: 1200 },
    });
    const note = parse({ type: 'task_lifecycle', subtype: 'task_notification', taskId: 'tu_1', status: 'completed', summary: 'done' });
    expect(note).toEqual({ type: 'system', subtype: 'task_notification', task_id: 'tu_1', status: 'completed', summary: 'done', output_file: null });
    expect(note).not.toHaveProperty('usage');
  });
});

describe('the serialized stream through the REAL registry (History-tab regression)', () => {
  const feed = (reg: unknown, ...events: WorkerEvent[]) => {
    for (const event of events) {
      const line = toStreamLine(event);
      if (line) agentsMjs.ingest(reg, JSON.parse(line));
    }
  };

  it('a synthesized agent appears in the tree, then completes — History is no longer empty', () => {
    const reg = agentsMjs.createRegistry();
    feed(
      reg,
      // the dispatching tool_use first, so the registry can attribute the parent
      { type: 'tool_use', id: 'tu_1', name: 'Task', input: { subagent_type: 'qa-critic', description: 'gate review' }, parentToolUseId: null },
      started(),
    );
    const agent = reg.agents.get('tu_1');
    expect(agent).toMatchObject({ kind: 'local_agent', name: 'qa-critic', status: 'running', parentId: agentsMjs.ROOT_ID });
    expect(reg.counts.spawned).toBe(1);

    feed(
      reg,
      { type: 'task_lifecycle', subtype: 'task_updated', taskId: 'tu_1', status: 'completed', endTime: '2026-08-24T01:02:03.000Z' },
      { type: 'task_lifecycle', subtype: 'task_notification', taskId: 'tu_1', status: 'completed', summary: 'APPROVE 0.9' },
    );
    expect(reg.agents.get('tu_1')).toMatchObject({ status: 'completed', summary: 'APPROVE 0.9' });
    expect(reg.counts.completed).toBe(1);
    // exactly what the History tab filters on: status !== 'running'
    const past = [...reg.agents.values()].filter((a) => a['status'] !== 'running' && a['id'] !== agentsMjs.ROOT_ID);
    expect(past).toHaveLength(1);
  });

  it('a failed close paints the agent failed, not completed', () => {
    const reg = agentsMjs.createRegistry();
    feed(reg, started({ taskId: 'tu_2', toolUseId: 'tu_2' }), {
      type: 'task_lifecycle', subtype: 'task_updated', taskId: 'tu_2', status: 'failed', endTime: '2026-08-24T01:02:03.000Z',
    });
    expect(reg.agents.get('tu_2')).toMatchObject({ status: 'failed' });
    expect(reg.counts.failed).toBe(1);
  });

  it('commands appear as local_bash agents with the command as description', () => {
    const reg = agentsMjs.createRegistry();
    feed(reg, started({ taskId: 'tu_3', toolUseId: 'tu_3', taskType: 'local_bash', subagentType: null, description: 'pnpm nx test runner', prompt: null }));
    expect(reg.agents.get('tu_3')).toMatchObject({ kind: 'local_bash', description: 'pnpm nx test runner' });
  });

  it('the result envelope closes the ROOT, so the session itself reaches History', () => {
    const reg = agentsMjs.createRegistry();
    feed(reg, { type: 'result', envelope: { is_error: false, result: 'tick done', total_cost_usd: 1.2 } });
    expect(reg.agents.get(agentsMjs.ROOT_ID)).toMatchObject({ status: 'completed', summary: 'tick done' });
    const regFailed = agentsMjs.createRegistry();
    feed(regFailed, { type: 'result', envelope: { is_error: true, result: 'refused' } });
    expect(regFailed.agents.get(agentsMjs.ROOT_ID)).toMatchObject({ status: 'failed' });
  });
});
