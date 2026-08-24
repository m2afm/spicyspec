/**
 * Server suite — real localhost socket, real fetch. Proves the http shell routes to the
 * pure handler, serves the token-bearing page, and enforces CSRF over the wire.
 */
import { openStore, type Store } from '@spicyspec/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startControlPlane, type RunningControlPlane } from './server.js';

let store: Store;
let cp: RunningControlPlane;
let base: string;

beforeEach(async () => {
  store = openStore(':memory:');
  store.saveQueue({ entries: [{ id: '002', status: 'awaiting-review', stage: 'handoff' }] });
  store.appendRun({ tick: 1, exit: 'clean', costUsd: 1.25, tasksClosed: 2, account: 'primary' });
  cp = await startControlPlane({ store, projectName: 'Acme' });
  base = `http://127.0.0.1:${cp.port}`;
});

afterEach(async () => {
  await cp.close();
  store.close();
});

describe('control-plane server', () => {
  it('serves the dashboard page with the CSRF token embedded and no-store', async () => {
    const r = await fetch(base + '/');
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const html = await r.text();
    expect(html).toContain('Acme');
    expect(html).toContain(cp.csrfToken);
  });

  it('GET /api/overview returns live JSON', async () => {
    const body = (await (await fetch(base + '/api/overview')).json()) as {
      counts: Record<string, number>;
      totals: { runs: number };
    };
    expect(body.counts['awaiting-review']).toBe(1);
    expect(body.totals.runs).toBe(1);
  });

  it('a POST without the token is refused over the wire (B32)', async () => {
    const r = await fetch(base + '/api/specs/002/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    expect(r.status).toBe(403);
  });

  it('a POST with the token records the decision', async () => {
    const r = await fetch(base + '/api/specs/002/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': cp.csrfToken },
      body: JSON.stringify({ approved: true, note: 'walked', by: 'test' }),
    });
    expect(r.status).toBe(200);
    const check = (await (await fetch(base + '/api/specs/002/review')).json()) as {
      decision: { approved: boolean; note: string };
    };
    expect(check.decision).toMatchObject({ approved: true, note: 'walked' });
  });

  it('an invalid JSON body is a 400, not a crash', async () => {
    const r = await fetch(base + '/api/specs/002/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': cp.csrfToken },
      body: '{not json',
    });
    expect(r.status).toBe(400);
  });

  it('a non-api, non-root path is 404', async () => {
    expect((await fetch(base + '/secret')).status).toBe(404);
  });
});
