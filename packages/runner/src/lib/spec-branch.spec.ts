/**
 * One branch per spec. The convention held for 001-004 and then drifted: 005, 006, 007 and
 * 008 all committed onto the 004 branch, so four features of history answered to a fifth
 * feature's name and no spec could be reviewed or reverted on its own.
 */
import { describe, expect, it } from 'vitest';
import { ensureSpecBranch, specBranchName, type GitFn } from './spec-branch.js';

const git = (script: Record<string, string>, log: string[][] = []): GitFn =>
  async (_cwd, args) => {
    log.push([...args]);
    const key = args.join(' ');
    for (const [pattern, out] of Object.entries(script)) {
      if (key.startsWith(pattern)) return out;
    }
    return '';
  };

describe('specBranchName', () => {
  it('takes the name from the spec directory so the two can never disagree', () => {
    expect(specBranchName('specs/008-pilot-listing-cost-share-gate', '008')).toBe('008-pilot-listing-cost-share-gate');
    expect(specBranchName(['specs', '009-passenger-search'].join(String.fromCharCode(92)), '009')).toBe('009-passenger-search');
  });

  it('falls back to the bare id when the spec has no directory yet', () => {
    expect(specBranchName(null, '011')).toBe('011');
  });
});

describe('ensureSpecBranch', () => {
  it('is a no-op when already on the spec branch', async () => {
    const calls: string[][] = [];
    const r = await ensureSpecBranch('/repo', '008-x', git({ 'rev-parse --abbrev-ref': '008-x' }, calls));
    expect(r.action).toBe('already');
    expect(calls.some((c) => c[0] === 'checkout')).toBe(false);
  });

  it('switches to an existing spec branch on a clean tree', async () => {
    const calls: string[][] = [];
    const r = await ensureSpecBranch('/repo', '008-x', git({
      'rev-parse --abbrev-ref': '004-old',
      'status --porcelain': '',
      'rev-parse --verify': 'deadbeef',
    }, calls));
    expect(r.action).toBe('switched');
    expect(calls).toContainEqual(['checkout', '008-x']);
  });

  it('creates the branch when it does not exist yet', async () => {
    const calls: string[][] = [];
    const r = await ensureSpecBranch('/repo', '009-y', git({
      'rev-parse --abbrev-ref': '008-x',
      'status --porcelain': '',
      'rev-parse --verify': '',
    }, calls));
    expect(r.action).toBe('created');
    expect(calls).toContainEqual(['checkout', '-b', '009-y']);
  });

  it('REFUSES to switch with modified tracked files — a checkout would carry another spec half-finished work into this history', async () => {
    const calls: string[][] = [];
    const r = await ensureSpecBranch('/repo', '009-y', git({
      'rev-parse --abbrev-ref': '008-x',
      'status --porcelain': ' M apps/api/src/thing.ts\n M apps/web/src/other.ts',
    }, calls));
    expect(r.action).toBe('refused');
    expect(r.detail).toMatch(/2 tracked file/);
    expect(calls.some((c) => c[0] === 'checkout')).toBe(false);
  });

  it('untracked files alone do not block the switch — they belong to nobody yet', async () => {
    const r = await ensureSpecBranch('/repo', '009-y', git({
      'rev-parse --abbrev-ref': '008-x',
      'status --porcelain': '?? notes.md\n?? HANDOFF-PACKAGE.md',
      'rev-parse --verify': '',
    }));
    expect(r.action).toBe('created');
  });
});
