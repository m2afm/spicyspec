/**
 * Compat-view suite — the Loop Control Room projections. The store is the truth; these
 * files are read-only views, and the mapping must hold in both directions.
 */
import { openStore } from '@spicyspec/store';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendLedgerView, exportAccountsView, exportQueueView } from './compat-view.js';

const scratch = async () => {
  const repoCwd = await mkdtemp(join(tmpdir(), 'spicyspec-compat-'));
  await mkdir(join(repoCwd, '.specify', 'loop'), { recursive: true });
  return { repoCwd, options: { repoCwd, loopDir: '.specify/loop' } };
};

describe('exportQueueView', () => {
  it('maps awaiting-review back to awaiting-founder and preserves original slugs', async () => {
    const { repoCwd, options } = await scratch();
    await writeFile(
      join(repoCwd, '.specify', 'loop', 'QUEUE.json'),
      JSON.stringify({ entries: [{ id: '006', slug: 'aircraft-subscription-autopause', status: 'x' }] }),
      'utf8',
    );
    const store = openStore(':memory:');
    await store.saveQueue({ entries: [{ id: '006', status: 'awaiting-review', stage: 'handoff' }] });
    await exportQueueView(store, options);
    const out = JSON.parse(await readFile(join(repoCwd, '.specify', 'loop', 'QUEUE.json'), 'utf8'));
    expect(out.projectedBy).toBe('spicyspec');
    expect(out.entries[0]).toMatchObject({
      id: '006',
      slug: 'aircraft-subscription-autopause', // preserved from the original
      status: 'awaiting-founder', // mapped back for the control room
      stage: 'handoff',
    });
    await store.close();
  });
});

describe('appendLedgerView', () => {
  it('continues the prototype tick numbering', async () => {
    const { repoCwd, options } = await scratch();
    await writeFile(join(repoCwd, '.specify', 'loop', 'LEDGER.jsonl'), JSON.stringify({ tick: 51, exit: 'clean' }) + '\n', 'utf8');
    const store = openStore(':memory:');
    const row = { exit: 'clean', costUsd: 1, tasksClosed: 2, account: 'primary', specId: '008', stage: 'execute', durationMinutes: 5 };
    await appendLedgerView(store, options, row);
    await appendLedgerView(store, options, row);
    const lines = (await readFile(join(repoCwd, '.specify', 'loop', 'LEDGER.jsonl'), 'utf8')).trim().split('\n');
    const ticks = lines.map((l) => JSON.parse(l).tick);
    expect(ticks).toEqual([51, 52, 53]); // prototype history untouched, numbering continues
    await store.close();
  });
});

describe('exportAccountsView', () => {
  it('projects pool state into the prototype ACCOUNTS.json shape', async () => {
    const { repoCwd, options } = await scratch();
    const store = openStore(':memory:');
    await store.savePoolState({ primary: { coldUntilMs: 9, uses: 3, limitType: 'five_hour' } });
    await exportAccountsView(store, options);
    const out = JSON.parse(await readFile(join(repoCwd, '.specify', 'loop', 'ACCOUNTS.json'), 'utf8'));
    expect(out.accounts.primary).toMatchObject({ coldUntilMs: 9, ticks: 3, limitType: 'five_hour' });
    await store.close();
  });
});
