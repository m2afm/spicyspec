/**
 * What a finished run hands to `onClassified`. The activity is the ONLY holder of the
 * after-snapshot and of the session clock, so a run row could not state a HEAD or a start
 * time until both crossed this boundary — every tick rendered with no commit pointer and no
 * start time no matter what it did.
 */
import type { ProviderAdapter, WorkerEvent } from '@spicyspec/provider';
import { describe, expect, it } from 'vitest';
import { createActivities, type ActivityDeps, type RunEvidence } from './activities.js';

const STARTED_MS = Date.parse('2026-08-24T04:05:06.000Z');

const finishingSession = (): ProviderAdapter =>
  ({
    id: 'fake',
    createSession: () => ({
      events: async function* (): AsyncGenerator<WorkerEvent> {
        yield { type: 'tool_use', id: '1', name: 'Bash', input: {}, parentToolUseId: null };
        yield { type: 'result', envelope: { total_cost_usd: 1, num_turns: 3, result: 'RUN_STATUS: continuing' } };
      },
      interrupt: async () => undefined,
    }),
  }) as ProviderAdapter;

function depsWithMovingHead(captured: RunEvidence[]): ActivityDeps {
  let calls = 0;
  return {
    provider: finishingSession(),
    nowMs: () => STARTED_MS,
    buildPacket: async () => ({
      prompt: 'p',
      cwd: '/repo',
      account: { id: 'primary', env: {}, configDir: null },
      disallowedTools: [],
      protectedPaths: [],
    }),
    snapshot: async () => ({
      git: { head: calls++ === 0 ? 'before-head' : 'after-head', dirty: false },
      tasks: { exists: true, done: 1, open: 2 },
      handoff: { mtimeMs: 1 },
    }),
    onClassified: async (_cls: unknown, _accountId: string, evidence: RunEvidence) => {
      captured.push(evidence);
    },
  } as unknown as ActivityDeps;
}

describe('run evidence — the facts only the activity holds', () => {
  it('carries the AFTER head, not the before head', async () => {
    const captured: RunEvidence[] = [];
    await createActivities(depsWithMovingHead(captured)).runWorkerSession({ specId: '006', run: 1 });
    expect(captured).toHaveLength(1);
    expect(captured[0].head).toBe('after-head');
  });

  it('carries the session start instant, from the same clock the watchdog uses', async () => {
    const captured: RunEvidence[] = [];
    await createActivities(depsWithMovingHead(captured)).runWorkerSession({ specId: '006', run: 1 });
    expect(captured[0].startedAt).toBe('2026-08-24T04:05:06.000Z');
  });

  it('still carries the harvest and the worker story the judge weighs', async () => {
    const captured: RunEvidence[] = [];
    await createActivities(depsWithMovingHead(captured)).runWorkerSession({ specId: '006', run: 1 });
    expect(captured[0].harvest.toolCalls).toBe(1);
    expect(captured[0].harvest.redFirstResidue).toEqual([]);
  });
});
