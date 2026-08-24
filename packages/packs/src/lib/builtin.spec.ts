/**
 * Contract suite over the bundled packs — they must all be valid, evidence-bearing, and
 * joinable to the default pipeline. Individual item wording is the pack author's; this
 * enforces the INVARIANTS every pack must hold no matter what it checks.
 */
import { specDrivenPipeline } from '@spicyspec/pipeline';
import { describe, expect, it } from 'vitest';
import { applyPacks, parsePack } from './pack.js';
import { a11yPack } from './a11y-pack.js';
import { backendPack } from './backend-pack.js';
import { frontendPack } from './frontend-pack.js';
import { securityPack } from './security-pack.js';

const ALL = [frontendPack, a11yPack, backendPack, securityPack];

describe('bundled packs — invariants', () => {
  it('every bundled pack re-validates through parsePack', () => {
    for (const pack of ALL) expect(() => parsePack(pack)).not.toThrow();
  });

  it('every item carries non-trivial, concrete evidence — never "review manually"', () => {
    for (const pack of ALL) {
      for (const item of pack.items) {
        expect(item.evidence.length).toBeGreaterThan(15);
        expect(item.evidence.toLowerCase()).not.toMatch(/review (the )?code|check manually|manually verify|eyeball/);
      }
    }
  });

  it('every pack names only stages that exist in the default pipeline', () => {
    const stageIds = new Set(specDrivenPipeline.stages.map((s) => s.id));
    for (const pack of ALL) {
      for (const stage of pack.stages) expect(stageIds.has(stage)).toBe(true);
    }
  });

  it('all four install cleanly with nothing ignored', () => {
    const { ignored, pipeline } = applyPacks(specDrivenPipeline, ALL);
    expect(ignored).toEqual([]);
    // execute gate carries the three execute-stage reviewers on top of the base seats
    const execute = pipeline.stages.find((s) => s.id === 'execute')!;
    const execSeats = execute.gate!.seats.map((s) => s.seat);
    expect(execSeats).toContain('frontend-reviewer');
    expect(execSeats).toContain('backend-reviewer');
    expect(execSeats).toContain('a11y-reviewer');
    // security joins plan + converge, not execute
    const plan = pipeline.stages.find((s) => s.id === 'plan')!;
    expect(plan.gate!.seats.map((s) => s.seat)).toContain('security-reviewer');
    expect(execSeats).not.toContain('security-reviewer');
  });

  it('the security pack carries at least one critical item (it maps OWASP)', () => {
    expect(securityPack.items.some((i) => i.severity === 'critical')).toBe(true);
  });

  it('pack ids are unique across the bundle', () => {
    const ids = ALL.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
