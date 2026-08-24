import { specDrivenPipeline } from '@spicyspec/pipeline';
import { describe, expect, it } from 'vitest';
import { applyPacks, packSectionsFor, parsePack, type GatePack } from './pack.js';

const pack = (over: Partial<GatePack> = {}): GatePack =>
  parsePack({
    id: 'test-pack',
    name: 'Test pack',
    stages: ['execute'],
    seat: 'test-reviewer',
    execute: true,
    items: [{ id: 'T-001', requirement: 'a thing is true', severity: 'high', evidence: 'run the probe' }],
    ...over,
  });

describe('parsePack', () => {
  it('accepts a well-formed pack', () => {
    expect(pack().id).toBe('test-pack');
  });

  it('rejects a bad item id, a bad severity, and an empty item list', () => {
    expect(() => parsePack({ ...pack(), items: [{ id: 'bad', requirement: 'x', severity: 'high', evidence: 'y' }] })).toThrow(
      /PREFIX-nnn/,
    );
    expect(() =>
      parsePack({ ...pack(), items: [{ id: 'T-001', requirement: 'x', severity: 'urgent', evidence: 'y' }] }),
    ).toThrow();
    expect(() => parsePack({ ...pack(), items: [] })).toThrow();
  });

  it('every item must carry evidence — a checklist without proof is narration', () => {
    expect(() =>
      parsePack({ ...pack(), items: [{ id: 'T-001', requirement: 'x', severity: 'high', evidence: '' }] }),
    ).toThrow();
  });

  it('duplicate item ids are rejected', () => {
    expect(() =>
      parsePack({
        ...pack(),
        items: [
          { id: 'T-001', requirement: 'a', severity: 'high', evidence: 'e' },
          { id: 'T-001', requirement: 'b', severity: 'low', evidence: 'e' },
        ],
      }),
    ).toThrow(/duplicate item id/);
  });
});

describe('applyPacks', () => {
  it('adds the pack seat to the gate of every stage it names', () => {
    const { pipeline } = applyPacks(specDrivenPipeline, [pack({ stages: ['execute'], seat: 'frontend-reviewer' })]);
    const execute = pipeline.stages.find((s) => s.id === 'execute')!;
    expect(execute.gate?.seats.some((s) => s.seat === 'frontend-reviewer')).toBe(true);
    // the base seats survive
    expect(execute.gate?.seats.some((s) => s.seat === 'qa-critic')).toBe(true);
  });

  it('creates a gate on a stage that had none', () => {
    const { pipeline } = applyPacks(specDrivenPipeline, [pack({ stages: ['clarify'], seat: 'x-reviewer' })]);
    const clarify = pipeline.stages.find((s) => s.id === 'clarify')!;
    expect(clarify.gate?.seats.map((s) => s.seat)).toEqual(['x-reviewer']);
  });

  it('is immutable — the source pipeline is untouched', () => {
    const before = JSON.stringify(specDrivenPipeline);
    applyPacks(specDrivenPipeline, [pack()]);
    expect(JSON.stringify(specDrivenPipeline)).toBe(before);
  });

  it('a pack naming an unknown stage is REPORTED, never silently dropped', () => {
    const { ignored } = applyPacks(specDrivenPipeline, [pack({ id: 'p', stages: ['nope'] })]);
    expect(ignored).toEqual([{ packId: 'p', stage: 'nope' }]);
  });

  it('does not double-seat a seat already present', () => {
    const { pipeline } = applyPacks(specDrivenPipeline, [pack({ stages: ['execute'], seat: 'qa-critic' })]);
    const execute = pipeline.stages.find((s) => s.id === 'execute')!;
    expect(execute.gate?.seats.filter((s) => s.seat === 'qa-critic')).toHaveLength(1);
  });
});

describe('packSectionsFor', () => {
  it('renders the joining packs checklist as evidence-demanding packet sections', () => {
    const execute = specDrivenPipeline.stages.find((s) => s.id === 'execute')!;
    const sections = packSectionsFor(execute, [pack({ stages: ['execute'], name: 'Frontend checklist' })]);
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toContain('Frontend checklist');
    expect(sections[0].body).toContain('checked against EVIDENCE');
    expect(sections[0].body).toContain('T-001');
    expect(sections[0].body).toContain('run the probe');
  });

  it('a stage no pack names gets no sections', () => {
    const intake = specDrivenPipeline.stages.find((s) => s.id === 'intake')!;
    expect(packSectionsFor(intake, [pack({ stages: ['execute'] })])).toHaveLength(0);
  });
});
