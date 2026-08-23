/**
 * Regression suite for the evidence layer. Defect ids reference the prototype register.
 */
import { describe, expect, it } from 'vitest';
import {
  harvestStream,
  isProductionSource,
  outcomeOf,
  redFirstResidue,
  summariseHarvest,
} from './harvest.js';

/** Build one stream line carrying content blocks. */
const line = (...content: unknown[]) => JSON.stringify({ message: { content } });

const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const result = (toolUseId: string, text: string, isError = false) => ({
  type: 'tool_result',
  tool_use_id: toolUseId,
  content: text,
  is_error: isError,
});

describe('outcomeOf — judged from output, never from narration', () => {
  it('failure counts beat FAIL-free prose', () => {
    expect(outcomeOf('Tests: 3 failed, 51 passed', false)).toBe('failed');
    expect(outcomeOf('0 failed, 54 passed', false)).toBe('passed');
  });
  it('tool error is failed regardless of output', () => {
    expect(outcomeOf('all good', true)).toBe('failed');
  });
  it('unclear output is unknown, never passed', () => {
    expect(outcomeOf('compiling…', false)).toBe('unknown');
  });
  it('nx success line passes', () => {
    expect(outcomeOf('Successfully ran target test for project core', false)).toBe('passed');
  });
});

describe('harvestStream — B8: claims must pair with executed commands', () => {
  it('pairs tool_use with tool_result and classifies verification commands', () => {
    const stream = [
      line(use('1', 'Bash', { command: 'pnpm nx test core' })),
      line(result('1', '53 passed')),
      line(use('2', 'Bash', { command: 'ls -la' })),
      line(result('2', 'files')),
    ].join('\n');
    const h = harvestStream(stream);
    expect(h.toolCalls).toBe(2);
    expect(h.verification).toHaveLength(1);
    expect(h.verification[0].outcome).toBe('passed');
  });

  it('B5: counts tool calls from the WHOLE stream, not a tail window', () => {
    const lines = Array.from({ length: 131 }, (_, i) => line(use(`u${i}`, 'Bash', { command: `echo ${i}` })));
    expect(harvestStream(lines.join('\n')).toolCalls).toBe(131);
  });

  it('a dispatched subagent with no result is visible (fabricated-gate detection)', () => {
    const stream = line(use('9', 'Agent', { subagent_type: 'qa-critic', description: 'closing gate' }));
    const h = harvestStream(stream);
    expect(h.subagents).toHaveLength(1);
    expect(h.subagents[0].returned).toBe(false);
  });

  it('record-file writes are tracked with applied status', () => {
    const stream = [
      line(use('w1', 'Write', { file_path: 'C:/repo/.specify/board/REVIEWS.md', content: 'verdict' })),
      line(result('w1', 'ok')),
      line(use('w2', 'Edit', { file_path: 'C:/repo/board/GATES.jsonl', new_string: '{}' })),
    ].join('\n');
    const h = harvestStream(stream);
    expect(h.recordWrites).toHaveLength(2);
    expect(h.recordWrites[0].applied).toBe(true);
    expect(h.recordWrites[1].applied).toBe(false);
  });

  it('malformed stream lines are skipped, not fatal', () => {
    const stream = ['garbage {', line(use('1', 'Bash', { command: 'vitest run' })), ''].join('\n');
    expect(harvestStream(stream).toolCalls).toBe(1);
  });

  it('custom verification patterns extend the defaults', () => {
    const stream = [line(use('1', 'Bash', { command: 'bash verify-specs.sh' })), line(result('1', 'exit 0'))].join('\n');
    expect(harvestStream(stream).verification).toHaveLength(0);
    expect(
      harvestStream(stream, { extraVerificationPatterns: [/verify-specs\.sh/] }).verification,
    ).toHaveLength(1);
  });
});

describe('redFirstResidue — B30: committed disabled guards must be visible', () => {
  it('flags a production file whose LAST write carries a marker', () => {
    const stream = line(use('1', 'Edit', { file_path: 'apps/api/src/auth/guard.ts', new_string: 'if (false && holdsRole) {' }));
    const residue = redFirstResidue(stream);
    expect(residue).toHaveLength(1);
    expect(residue[0].file).toContain('guard.ts');
  });

  it('last write wins: a later restore clears an earlier break', () => {
    const stream = [
      line(use('1', 'Edit', { file_path: 'apps/api/src/auth/guard.ts', new_string: 'if (false && holdsRole) {' })),
      line(use('2', 'Edit', { file_path: 'apps/api/src/auth/guard.ts', new_string: 'if (holdsRole) {' })),
    ].join('\n');
    expect(redFirstResidue(stream)).toHaveLength(0);
  });

  it('B30 second lesson: prose and tests may DESCRIBE red-first without flagging', () => {
    const stream = [
      line(use('1', 'Write', { file_path: 'specs/006/tasks.md', content: 'RED-FIRST: prove it can fail' })),
      line(use('2', 'Write', { file_path: 'apps/api/src/x/y.spec.ts', content: 'RED-FIRST assertion' })),
      line(use('3', 'Write', { file_path: '.specify/HANDOFF.md', content: 'guard disabled note' })),
    ].join('\n');
    expect(redFirstResidue(stream)).toHaveLength(0);
  });

  it('isProductionSource scopes correctly', () => {
    expect(isProductionSource('apps/api/src/thing.ts')).toBe(true);
    expect(isProductionSource('apps/api/src/thing.spec.ts')).toBe(false);
    expect(isProductionSource('notes.md')).toBe(false);
    expect(isProductionSource('node_modules/x/index.js')).toBe(false);
  });
});

describe('summariseHarvest', () => {
  it('aggregates outcomes and surfaces failing tails', () => {
    const stream = [
      line(use('1', 'Bash', { command: 'pnpm nx test a' })),
      line(result('1', '10 passed')),
      line(use('2', 'Bash', { command: 'pnpm nx test b' })),
      line(result('2', '2 failed, 8 passed')),
    ].join('\n');
    const s = summariseHarvest(harvestStream(stream));
    expect(s.verificationOutcomes).toEqual({ passed: 1, failed: 1 });
    expect(s.failingCommands).toHaveLength(1);
    expect(s.failingCommands[0].command).toContain('test b');
  });
});
