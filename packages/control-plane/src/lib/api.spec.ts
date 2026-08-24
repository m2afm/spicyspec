import { openStore, type Store } from '@spicyspec/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleApi, type ApiDeps } from './api.js';
import { readReviewDecision, type OverviewView } from './views.js';

let store: Store;
const deps = (): ApiDeps => ({ store, projectName: 'Acme', csrfToken: 'secret-token', now: () => '2026-08-24T00:00:00Z' });

beforeEach(async () => {
  store = openStore(':memory:');
  await store.saveQueue({
    entries: [
      { id: '001', status: 'done' },
      { id: '002', status: 'awaiting-review', stage: 'handoff' },
      { id: '003', status: 'active', stage: 'execute' },
    ],
  });
  await store.appendRun({ tick: 1, exit: 'clean', costUsd: 2, tasksClosed: 3, account: 'primary', judgedBy: 'kimi', judgeHonest: true });
  await store.appendGate({ at: 'x', spec: '002', gate: 'closing', verdict: 'APPROVE', confidence: 0.9, seat: 'qa-critic', frozen: 'abc' });
});

afterEach(() => store.close());

const GET = (path: string, query: Record<string, string> = {}) =>
  handleApi({ method: 'GET', path, query, body: null }, deps());

describe('read surface (GET, no token)', () => {
  it('overview reports counts, specs with gate state, totals, and the awaiting-review queue', async () => {
    const r = await GET('/api/overview');
    expect(r.status).toBe(200);
    const body = r.json as OverviewView;
    expect(body.counts).toMatchObject({ done: 1, 'awaiting-review': 1, active: 1 });
    expect(body.specs.find((s) => s.id === '002')?.closingGate).toBe('approved');
    expect(body.specs.find((s) => s.id === '001')?.closingGate).toBe('unknown');
    expect(body.totals.runs).toBe(1);
    expect(body.awaitingReview).toEqual(['002']);
  });

  it('runs history reflects the ledger with judge fields', async () => {
    const r = await GET('/api/runs');
    expect((r.json as unknown[]).length).toBe(1);
    expect((r.json as Array<{ judgedBy: string }>)[0].judgedBy).toBe('kimi');
  });

  it('runs limit is clamped', async () => {
    expect((await GET('/api/runs', { limit: '99999' })).status).toBe(200);
    expect((await GET('/api/runs', { limit: '-5' })).status).toBe(200);
  });

  it('gate trail filters by spec', async () => {
    expect(((await GET('/api/gates', { spec: '002' })).json as unknown[]).length).toBe(1);
    expect(((await GET('/api/gates', { spec: '999' })).json as unknown[]).length).toBe(0);
  });

  it('unknown GET path is 404', async () => {
    expect((await GET('/api/nope')).status).toBe(404);
  });
});

describe('mutation surface (POST, CSRF-guarded — B32)', () => {
  const POST = (path: string, body: unknown, csrfToken?: string) =>
    handleApi({ method: 'POST', path, query: {}, body, csrfToken }, deps());

  it('records a review decision with a valid token', async () => {
    const r = await POST('/api/specs/002/review', { approved: true, note: 'journey walked', by: 'founder' }, 'secret-token');
    expect(r.status).toBe(200);
    const decision = await readReviewDecision(store, '002');
    expect(decision).toMatchObject({ specId: '002', approved: true, note: 'journey walked', by: 'founder' });
  });

  it('refuses a mutation with a missing or wrong token BEFORE touching the store', async () => {
    expect((await POST('/api/specs/002/review', { approved: true })).status).toBe(403);
    expect((await POST('/api/specs/002/review', { approved: true }, 'wrong')).status).toBe(403);
    expect(await readReviewDecision(store, '002')).toBeNull();
  });

  it('validates the body: approved must be a boolean', async () => {
    expect((await POST('/api/specs/002/review', { approved: 'yes' }, 'secret-token')).status).toBe(400);
  });

  it('a decision for an unknown spec is 404', async () => {
    expect((await POST('/api/specs/999/review', { approved: true }, 'secret-token')).status).toBe(404);
  });

  it('the decision is then readable via GET', async () => {
    await POST('/api/specs/002/review', { approved: false, note: 'not yet' }, 'secret-token');
    const r = await GET('/api/specs/002/review');
    expect((r.json as { decision: { approved: boolean } }).decision.approved).toBe(false);
  });
});

describe('method discipline', () => {
  it('a non-GET/POST verb is 405', async () => {
    expect((await handleApi({ method: 'DELETE', path: '/api/overview', query: {}, body: null }, deps())).status).toBe(405);
  });
});

describe('runners endpoint — federation visibility', () => {
  it('lists registered runners with staleness computed at request time', async () => {
    const { registerRunner } = await import('@spicyspec/store');
    await registerRunner(store, {
      id: 'box-1', host: 'box', pid: 1, taskQueue: 'spicyspec',
      startedAt: '2026-08-23T23:00:00Z', heartbeatAt: '2026-08-23T23:59:45Z', accounts: ['primary'],
    });
    await registerRunner(store, {
      id: 'box-2', host: 'laptop', pid: 2, taskQueue: 'spicyspec',
      startedAt: '2026-08-23T20:00:00Z', heartbeatAt: '2026-08-23T20:05:00Z', accounts: ['secondary'],
    });
    const r = await GET('/api/runners');
    const runners = r.json as Array<{ id: string; stale: boolean }>;
    expect(runners.find((x) => x.id === 'box-1')?.stale).toBe(false);
    expect(runners.find((x) => x.id === 'box-2')?.stale).toBe(true);
  });
});
