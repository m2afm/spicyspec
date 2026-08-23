/**
 * Queue-activity suite — guard/repair/rotation rules against an in-memory store.
 */
import { openStore } from '@spicyspec/store';
import type { ProviderAdapter } from '@spicyspec/provider';
import { describe, expect, it } from 'vitest';
import { parseRunnerConfig } from './config.js';
import { createQueueActivities, type QueueEvidenceFns } from './queue-activities.js';
import type { RunnerDeps } from './wiring.js';

const healthyEvidence = (over: Partial<QueueEvidenceFns> = {}): QueueEvidenceFns => ({
  specDirExists: () => true,
  commitsFor: () => 5,
  signedOff: () => true,
  ...over,
});

function makeRunnerDeps(): RunnerDeps {
  return {
    config: parseRunnerConfig({ projectName: 'Acme', repoCwd: '/repo', accounts: [{ id: 'a' }] }),
    store: openStore(':memory:'),
    provider: { id: 'fake', createSession: () => ({ events: async function* () {}, interrupt: async () => undefined }) } as unknown as ProviderAdapter,
  };
}

const acts = (runner: RunnerDeps, evidence: QueueEvidenceFns = healthyEvidence(), cap = 3) =>
  createQueueActivities({ runner, evidenceFn: async () => evidence, maxAwaitingReview: cap });

describe('openNextSpec', () => {
  it('continues the ACTIVE entry at its recorded stage', async () => {
    const deps = makeRunnerDeps();
    deps.store.saveQueue({ entries: [{ id: '001', status: 'active', stage: 'plan' }] });
    const r = await acts(deps).openNextSpec();
    expect(r).toEqual({ kind: 'next', next: { specId: '001', stage: 'plan' } });
  });

  it('promotes the first pending to active at the first pipeline stage', async () => {
    const deps = makeRunnerDeps();
    deps.store.saveQueue({ entries: [{ id: '001', status: 'done' }, { id: '002', status: 'pending' }] });
    const r = await acts(deps).openNextSpec();
    expect(r).toEqual({ kind: 'next', next: { specId: '002', stage: 'intake' } });
    expect(deps.store.loadQueue().entries[1]).toMatchObject({ status: 'active', stage: 'intake' });
  });

  it('Q3: two active entries HALT the rotation with the violation named', async () => {
    const deps = makeRunnerDeps();
    deps.store.saveQueue({
      entries: [{ id: '001', status: 'active', stage: 'a' }, { id: '002', status: 'active', stage: 'a' }],
    });
    const r = await acts(deps).openNextSpec();
    expect(r.kind).toBe('halt');
    expect((r as { violations: string[] }).violations[0]).toContain('Q3');
  });

  it('Q4 (B45): awaiting-review with no spec dir is REPAIRED to pending, then opened', async () => {
    const deps = makeRunnerDeps();
    deps.store.saveQueue({ entries: [{ id: '006', status: 'awaiting-review' }] });
    const r = await acts(deps, healthyEvidence({ specDirExists: () => false })).openNextSpec();
    expect(r).toEqual({ kind: 'next', next: { specId: '006', stage: 'intake' } });
  });

  it('the review cap idles the loop instead of opening more work', async () => {
    const deps = makeRunnerDeps();
    deps.store.saveQueue({
      entries: [
        { id: '001', status: 'awaiting-review' },
        { id: '002', status: 'awaiting-review' },
        { id: '003', status: 'pending' },
      ],
    });
    const r = await acts(deps, healthyEvidence(), 2).openNextSpec();
    expect(r.kind).toBe('idle');
    expect((r as { reason: string }).reason).toContain('cap');
    expect(deps.store.loadQueue().entries[2].status).toBe('pending'); // untouched
  });

  it('drained catalog reports idle', async () => {
    const deps = makeRunnerDeps();
    deps.store.saveQueue({ entries: [{ id: '001', status: 'done' }] });
    const r = await acts(deps).openNextSpec();
    expect(r.kind).toBe('idle');
  });
});

describe('settleSpecOutcome — stage progression', () => {
  it('complete advances the stage and keeps the spec active', async () => {
    const deps = makeRunnerDeps();
    deps.store.saveQueue({ entries: [{ id: '001', status: 'active', stage: 'specify' }] });
    const r = await acts(deps).settleSpecOutcome({ specId: '001', status: 'complete' });
    expect(r).toEqual({ queueStatus: 'active', nextStage: 'clarify' });
    expect(deps.store.loadQueue().entries[0].stage).toBe('clarify');
  });

  it('complete past the LAST stage goes to awaiting-review — the platform never marks its own work done', async () => {
    const deps = makeRunnerDeps();
    deps.store.saveQueue({ entries: [{ id: '001', status: 'active', stage: 'handoff' }] });
    const r = await acts(deps).settleSpecOutcome({ specId: '001', status: 'complete' });
    expect(r.queueStatus).toBe('awaiting-review');
    expect(r.nextStage).toBeNull();
  });

  it('exhausted parks — a runaway backstop must not consume the catalog', async () => {
    const deps = makeRunnerDeps();
    deps.store.saveQueue({ entries: [{ id: '001', status: 'active', stage: 'execute' }] });
    const r = await acts(deps).settleSpecOutcome({ specId: '001', status: 'exhausted' });
    expect(r.queueStatus).toBe('parked');
  });

  it('an unknown spec throws instead of silently settling nothing', async () => {
    const deps = makeRunnerDeps();
    deps.store.saveQueue({ entries: [] });
    await expect(acts(deps).settleSpecOutcome({ specId: '999', status: 'complete' })).rejects.toThrow(/unknown spec/);
  });
});
