/**
 * PARKED.md writer suite — the shape is a CONTRACT with the control room's parser, so the
 * regexes asserted below are the ones room/founder-brief.mjs:158-176 actually applies.
 * GAP 15: no writer existed at all, so every park was a notification with no record.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendParked, diagnoseParkedSpec, lastRunDirs, parkBlock, writeParkDiagnosis } from './parked-writer.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'spicyspec-parked-'));

/** The room's parser, applied verbatim to a block this module wrote. */
function parseLikeTheRoom(text: string): Array<Record<string, string | null>> {
  const items: Array<Record<string, string | null>> = [];
  let cur: Record<string, string | null> | null = null;
  for (const line of text.split(/\r?\n/)) {
    const head = line.match(/^##\s+(.+)$/);
    if (head) {
      const raw = head[1].replace(/\s+/g, ' ').trim();
      const dm = raw.match(/^(\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?)\s*[·\-—]\s*([\s\S]*)$/);
      cur = { date: dm ? dm[1].slice(0, 10) : null, reason: dm ? dm[2] : raw, spec: null, why: null, unblocks: null };
      items.push(cur);
      continue;
    }
    if (!cur) continue;
    const f = line.match(/^-\s+\*\*(.+?)\*\*:\s*(.*)$/);
    if (!f) continue;
    const name = f[1].toLowerCase();
    if (name === 'spec') cur['spec'] = f[2];
    else if (name.startsWith('why')) cur['why'] = f[2];
    else if (name.startsWith('what unblocks')) cur['unblocks'] = f[2];
  }
  return items;
}

describe('parkBlock — the room must be able to parse what the runner writes', () => {
  it('heading and all three fields survive the room parser', () => {
    const text = parkBlock(
      { title: 'Spec 006 parked after repeated stalls', spec: '006', why: 'no progress twice running', unblocks: 'diagnose, then re-queue' },
      '2026-08-24T09:15:00.000Z',
    );
    const [item] = parseLikeTheRoom(text);
    expect(item).toEqual({
      date: '2026-08-24',
      reason: 'Spec 006 parked after repeated stalls',
      spec: '006',
      why: 'no progress twice running',
      unblocks: 'diagnose, then re-queue',
    });
  });

  it('two parks in a row parse as two items — the leading blank line is load-bearing', () => {
    const path = join(tmp(), 'PARKED.md');
    appendParked(path, { title: 'first', spec: '001', why: 'a', unblocks: 'b' }, '2026-08-24T09:00:00.000Z');
    appendParked(path, { title: 'second', spec: '002', why: 'c', unblocks: 'd' }, '2026-08-24T10:00:00.000Z');
    const items = parseLikeTheRoom(readFileSync(path, 'utf8'));
    expect(items.map((i) => i['reason'])).toEqual(['first', 'second']);
  });

  it('every diagnosis records a "what unblocks it" — the parser reports a missing one as a problem', () => {
    for (const parkedFor of ['stalls', 'review-rejected', 'blocked', 'infra-retry-cap', null] as const) {
      const item = diagnoseParkedSpec({ specId: '006', parkedFor, status: 'parked' });
      expect(item.unblocks.length).toBeGreaterThan(0);
      expect(item.spec).toBe('006');
    }
  });
});

describe('diagnoseParkedSpec — a park with no forensics is one nobody can clear', () => {
  it('a stall park names the exit class, the stall count and the last two run dirs', () => {
    const item = diagnoseParkedSpec({
      specId: '006',
      parkedFor: 'stalls',
      status: 'parked',
      lastExit: 'no-progress',
      stalls: 2,
      runs: 4,
      runDirs: ['006-r4-2000', '006-r3-1000'],
    });
    expect(item.title).toContain('006');
    expect(item.why).toContain('2 consecutive non-progressing runs');
    expect(item.why).toContain('`no-progress`');
    expect(item.why).toContain('4 run(s)');
    expect(item.why).toContain('.spicyspec/runs/006-r4-2000/');
    expect(item.why).toContain('.spicyspec/runs/006-r3-1000/');
  });

  it('an unrecorded exit says so rather than implying zero', () => {
    const item = diagnoseParkedSpec({ specId: '006', parkedFor: 'stalls', status: 'parked' });
    expect(item.why).toContain('`unrecorded`');
    expect(item.why).toContain('No run directory was recorded');
  });

  it('exhausted is the run backstop, never a retirement', () => {
    const item = diagnoseParkedSpec({ specId: '007', parkedFor: null, status: 'exhausted', runs: 12 });
    expect(item.title).toContain('run backstop');
    expect(item.why).toContain('never retires it');
  });

  it('each cause gets its own action — collapsing them made the prototype parks unreadable', () => {
    const unblocks = (['stalls', 'review-rejected', 'blocked', 'infra-retry-cap'] as const).map(
      (parkedFor) => diagnoseParkedSpec({ specId: '006', parkedFor, status: 'parked' }).unblocks,
    );
    expect(new Set(unblocks).size).toBe(4);
  });
});

describe('lastRunDirs — run 10 must not sort before run 9', () => {
  it('orders by the trailing start instant, newest first, and ignores other specs', async () => {
    const root = tmp();
    for (const name of ['006-r9-900', '006-r10-1000', '006-r8-800', '007-r1-1100', 'stray']) {
      await mkdir(join(root, name), { recursive: true });
    }
    expect(lastRunDirs(root, '006')).toEqual(['006-r10-1000', '006-r9-900']);
  });

  it('a missing runs root is an empty list, never a throw', () => {
    expect(lastRunDirs(join(tmp(), 'nope'), '006')).toEqual([]);
  });

  it('a file that happens to match the prefix is still a pointer, not a crash', async () => {
    const root = tmp();
    await writeFile(join(root, '006-r1-100'), '', 'utf8');
    expect(lastRunDirs(root, '006')).toEqual(['006-r1-100']);
  });
});

describe('writeParkDiagnosis', () => {
  it('resolves the run dirs itself and appends a parseable block', async () => {
    const root = tmp();
    await mkdir(join(root, '.spicyspec', 'runs', '006-r2-2000'), { recursive: true });
    const parkedPath = join(root, '.spicyspec', 'PARKED.md');
    writeParkDiagnosis(parkedPath, join(root, '.spicyspec', 'runs'), {
      specId: '006',
      parkedFor: 'stalls',
      status: 'parked',
      lastExit: 'stalled',
      stalls: 2,
      runs: 3,
    });
    const [item] = parseLikeTheRoom(readFileSync(parkedPath, 'utf8'));
    expect(item['spec']).toBe('006');
    expect(item['why']).toContain('.spicyspec/runs/006-r2-2000/');
  });
});
