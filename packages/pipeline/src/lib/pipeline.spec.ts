import { describe, expect, it } from 'vitest';
import { parsePipeline, specDrivenPipeline, stageAfter } from './definition.js';
import { buildPacket, STATUS_TOKENS, type PacketContext } from './packet.js';

describe('parsePipeline', () => {
  it('the default spec-driven pipeline is valid and ordered', () => {
    expect(specDrivenPipeline.stages.map((s) => s.id)).toEqual([
      'intake',
      'specify',
      'clarify',
      'plan',
      'tasks',
      'execute',
      'converge',
      'handoff',
    ]);
  });

  it('a typo is a load error, not a silent misbehavior', () => {
    expect(() => parsePipeline({ id: 'x', name: 'X', stages: [{ id: 'BadCase', title: 't', instructions: 'i' }] })).toThrow(
      /kebab-case/,
    );
    expect(() => parsePipeline({ id: 'x', name: 'X', stages: [] })).toThrow();
  });

  it('duplicate stage ids are rejected', () => {
    expect(() =>
      parsePipeline({
        id: 'x',
        name: 'X',
        stages: [
          { id: 'a', title: 'A', instructions: 'i' },
          { id: 'a', title: 'A again', instructions: 'i' },
        ],
      }),
    ).toThrow(/duplicate stage id/);
  });

  it('gate verdicts bind to the core gate kinds', () => {
    expect(() =>
      parsePipeline({
        id: 'x',
        name: 'X',
        stages: [{ id: 'a', title: 'A', instructions: 'i', gate: { kind: 'vibes', seats: [{ seat: 's' }] } }],
      }),
    ).toThrow();
  });

  it('stageAfter walks the order and ends with null', () => {
    expect(stageAfter(specDrivenPipeline, 'intake')?.id).toBe('specify');
    expect(stageAfter(specDrivenPipeline, 'handoff')).toBeNull();
    expect(() => stageAfter(specDrivenPipeline, 'nope')).toThrow(/unknown stage/);
  });
});

const ctx = (over: Partial<PacketContext> = {}): PacketContext => ({
  projectName: 'Acme',
  runNumber: 7,
  specId: '006',
  stage: specDrivenPipeline.stages.find((s) => s.id === 'execute')!,
  position: {
    branch: 'main',
    head: 'abc1234',
    headSubject: 'feat: x',
    dirty: false,
    dirtyPaths: [],
    tasksDone: 5,
    tasksOpen: 3,
    nextTaskIds: ['T006', 'T007'],
  },
  readFirst: [{ what: '`HANDOFF.md`', why: 'the baton' }],
  protectedPaths: ['.spicyspec/'],
  gateRecordPath: '.spicyspec/gates.jsonl',
  parkedPath: '.spicyspec/PARKED.md',
  ...over,
});

describe('buildPacket', () => {
  it('carries stage instructions, position, and every status token', () => {
    const p = buildPacket(ctx());
    expect(p).toContain('stage execute');
    expect(p).toContain('Red-first on every guard');
    expect(p).toContain('HEAD `abc1234`');
    expect(p).toContain('next open ids: T006, T007');
    for (const t of STATUS_TOKENS) expect(p).toContain(`RUN_STATUS: ${t}`);
  });

  it('a dirty tree gets the reconcile-first warning; a clean one does not', () => {
    expect(buildPacket(ctx())).not.toContain('ended mid-unit');
    const dirty = buildPacket(
      ctx({ position: { ...ctx().position, dirty: true, dirtyPaths: ['a.ts', 'b.ts'] } }),
    );
    expect(dirty).toContain('**DIRTY** — 2 path(s): a.ts, b.ts');
    expect(dirty).toContain('ended mid-unit');
  });

  it('protected paths are named in the authority block', () => {
    const p = buildPacket(ctx({ protectedPaths: ['.spicyspec/', 'secrets/'] }));
    expect(p).toContain('- `.spicyspec/`');
    expect(p).toContain('- `secrets/`');
    expect(p).toContain('runtime DENIES writes');
  });

  it('a direct note outranks the work list and appears verbatim', () => {
    const p = buildPacket(ctx({ directNote: 'Skip T006; hotfix the webhook first.' }));
    expect(p).toContain('A DIRECT INSTRUCTION FOR THIS RUN');
    expect(p).toContain('hotfix the webhook first.');
  });

  it('no note, no note section', () => {
    expect(buildPacket(ctx({ directNote: '  ' }))).not.toContain('DIRECT INSTRUCTION');
  });

  it('predecessor verdict is included and truncated at the cap', () => {
    const p = buildPacket(
      ctx({
        predecessorVerdict: {
          assessment: 'x'.repeat(5000),
          claimsUnverified: ['the suite passed'],
        },
      }),
    );
    expect(p).toContain('reviewed your predecessor');
    // 2400-char cap holds
    const block = p.split('reviewed your predecessor')[1];
    expect(block.indexOf('x'.repeat(2401))).toBe(-1);
  });

  it('extra sections append verbatim', () => {
    const p = buildPacket(ctx({ extraSections: [{ title: 'Verification tiers', body: 'pnpm nx affected -t test' }] }));
    expect(p).toContain('## Verification tiers');
    expect(p).toContain('pnpm nx affected -t test');
  });
});
