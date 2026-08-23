/**
 * Regression suite for gate records. The reason this module exists at all: prose parsing of
 * review journals was tested in the prototype and was wrong in both directions on the first
 * three specs tried (RFC-001 §7.1 — absence means UNKNOWN, never PASS).
 */
import { describe, expect, it } from 'vitest';
import { closingGate, parseGateRecords, serializeGateRecord, type GateRecord } from './gates.js';

const line = (over: Partial<GateRecord> = {}) =>
  JSON.stringify({
    at: '2026-08-23T20:08:48Z',
    spec: '006',
    stage: 'plan',
    gate: 'design',
    verdict: 'APPROVE',
    confidence: 0.9,
    seat: 'qa-critic',
    frozen: '0ef6e8f',
    ...over,
  });

describe('parseGateRecords', () => {
  it('parses well-formed JSONL and keeps line numbers', () => {
    const { records, problems } = parseGateRecords([line(), line({ verdict: 'REVISE' })].join('\n'));
    expect(problems).toHaveLength(0);
    expect(records).toHaveLength(2);
    expect(records[0].line).toBe(1);
    expect(records[1].verdict).toBe('REVISE');
  });

  it('malformed lines become problems, never silent drops', () => {
    const { records, problems } = parseGateRecords(['not json', line(), '{"spec":"006"}'].join('\n'));
    expect(records).toHaveLength(1);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain(':1');
    expect(problems[1]).toContain(':3');
  });

  it('blank lines are skipped', () => {
    const { records, problems } = parseGateRecords(`\n${line()}\n\n`);
    expect(records).toHaveLength(1);
    expect(problems).toHaveLength(0);
  });

  it('a numeric spec id normalizes to string', () => {
    const { records } = parseGateRecords(line({ spec: 6 as unknown as string }));
    expect(records[0].spec).toBe('6');
  });

  it('an unknown verdict is rejected', () => {
    const { records, problems } = parseGateRecords(line({ verdict: 'LGTM' as never }));
    expect(records).toHaveLength(0);
    expect(problems).toHaveLength(1);
  });
});

describe('closingGate — absence means UNKNOWN, never PASS', () => {
  const recordsOf = (text: string) => parseGateRecords(text).records;

  it('no records at all → unknown', () => {
    const g = closingGate([], '005');
    expect(g.state).toBe('unknown');
    expect(g.record).toBeNull();
  });

  it('records for other specs or non-closing gates → unknown', () => {
    const recs = recordsOf([line(), line({ gate: 'specify' })].join('\n'));
    expect(closingGate(recs, '006').state).toBe('unknown'); // design/specify are not closing
    expect(closingGate(recs, '005').state).toBe('unknown');
  });

  it('last write wins: REVISE then APPROVE → approved', () => {
    const recs = recordsOf(
      [line({ gate: 'closing', verdict: 'REVISE' }), line({ gate: 'closing', verdict: 'APPROVE' })].join('\n'),
    );
    const g = closingGate(recs, '006');
    expect(g.state).toBe('approved');
    expect(g.count).toBe(2);
  });

  it('APPROVE then REVISE → open (a re-review after fixes is the current verdict)', () => {
    const recs = recordsOf(
      [line({ gate: 'closing', verdict: 'APPROVE' }), line({ gate: 'closing', verdict: 'BLOCK' })].join('\n'),
    );
    expect(closingGate(recs, '006').state).toBe('open');
  });

  it('terminal counts as closing (the 007 prototype shape)', () => {
    const recs = recordsOf(
      [
        line({ spec: '007', gate: 'terminal', verdict: 'REVISE', confidence: 0.9 }),
        line({ spec: '007', gate: 'terminal', verdict: 'APPROVE', confidence: 0.92 }),
      ].join('\n'),
    );
    const g = closingGate(recs, '007');
    expect(g.state).toBe('approved');
    expect(g.record?.confidence).toBe(0.92);
  });
});

describe('serializeGateRecord', () => {
  it('round-trips through the parser', () => {
    const text = serializeGateRecord({
      at: '2026-08-24T00:00:00Z',
      spec: '001',
      gate: 'closing',
      verdict: 'APPROVE',
      confidence: 0.95,
      seat: 'qa-critic',
      frozen: 'abc1234',
    });
    const { records, problems } = parseGateRecords(text);
    expect(problems).toHaveLength(0);
    expect(records[0].verdict).toBe('APPROVE');
  });

  it('throws on a malformed record instead of appending garbage', () => {
    expect(() => serializeGateRecord({ spec: '001', verdict: 'MAYBE' })).toThrow();
  });

  it('defaults gate to wave', () => {
    const text = serializeGateRecord({ at: 'x', spec: '001', verdict: 'REVISE' });
    expect(JSON.parse(text).gate).toBe('wave');
  });
});
