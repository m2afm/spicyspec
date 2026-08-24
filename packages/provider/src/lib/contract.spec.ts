import { describe, expect, it } from 'vitest';
import { collectSession, type WorkerEvent, type WorkerSession } from './contract.js';

const sessionOf = (...events: WorkerEvent[]): WorkerSession => ({
  async *events() {
    yield* events;
  },
  async interrupt() {
    /* no-op */
  },
});

describe('collectSession', () => {
  it('keeps only top-level text as the worker voice (B11)', async () => {
    const outcome = await collectSession(
      sessionOf(
        { type: 'assistant_text', text: 'worker says', topLevel: true },
        { type: 'assistant_text', text: 'subagent says', topLevel: false },
      ),
    );
    expect(outcome.text).toBe('worker says');
  });

  it('counts every tool_use and keeps the LAST envelope and rate limit', async () => {
    const outcome = await collectSession(
      sessionOf(
        { type: 'tool_use', id: '1', name: 'Bash', input: {}, parentToolUseId: null },
        { type: 'tool_use', id: '2', name: 'Read', input: {}, parentToolUseId: 'sub' },
        { type: 'rate_limit', info: { status: 'allowed' } },
        { type: 'rate_limit', info: { status: 'allowed_warning', utilization: 92 } },
        { type: 'result', envelope: { total_cost_usd: 1 } },
        { type: 'result', envelope: { total_cost_usd: 2.5 } },
      ),
    );
    expect(outcome.toolCalls).toBe(2);
    expect(outcome.rateLimit?.status).toBe('allowed_warning');
    expect(outcome.envelope?.total_cost_usd).toBe(2.5);
  });

  it('task_lifecycle events pass through without inflating toolCalls — lifecycle is telemetry, not work', async () => {
    const outcome = await collectSession(
      sessionOf(
        { type: 'tool_use', id: '1', name: 'Task', input: {}, parentToolUseId: null },
        { type: 'task_lifecycle', subtype: 'task_started', taskId: '1', toolUseId: '1', taskType: 'local_agent' },
        { type: 'task_lifecycle', subtype: 'task_updated', taskId: '1', status: 'completed' },
      ),
    );
    expect(outcome.toolCalls).toBe(1);
  });

  it('an empty session yields an empty outcome, never a throw', async () => {
    const outcome = await collectSession(sessionOf());
    expect(outcome).toEqual({ envelope: null, rateLimit: null, text: '', toolCalls: 0 });
  });
});
