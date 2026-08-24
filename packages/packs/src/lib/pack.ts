/**
 * Gate packs — RFC-001 layer 4, the marketplace surface.
 *
 * A pack is a declarative checklist that hangs off pipeline-stage gates: it adds a
 * reviewing seat and gives that seat a concrete, evidence-demanding checklist. Installing
 * a pack extends the pipeline; it never edits engine code.
 *
 * Every checklist item carries an `evidence` field — WHAT PROVES IT. A checklist whose
 * items can be ticked without proof is narration, and narration is the exact failure the
 * evidence layer exists to kill (RFC-001 §7.1).
 */
import { z } from 'zod';
import type { PacketContext, PipelineDefinition, StageDefinition } from '@spicyspec/pipeline';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CHECK_ITEM = z.object({
  id: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/, 'item ids are PREFIX-nnn (e.g. FE-001, A11Y-003)'),
  requirement: z.string().min(1),
  severity: z.enum(SEVERITIES),
  /** what PROVES it — a command to run, an artifact to open, a header to read */
  evidence: z.string().min(1),
});

export const GATE_PACK = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  /** pipeline stage ids whose gates this pack joins */
  stages: z.array(z.string()).min(1),
  /** the reviewing seat this pack seats at those gates */
  seat: z.string().min(1),
  /** may the seat run commands to verify, or is it read-only */
  execute: z.boolean().default(true),
  items: z.array(CHECK_ITEM).min(1),
});

export type CheckItem = z.infer<typeof CHECK_ITEM>;
export type GatePack = z.infer<typeof GATE_PACK>;

export function parsePack(raw: unknown): GatePack {
  const result = GATE_PACK.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid gate pack — ${detail}`);
  }
  const ids = new Set<string>();
  for (const item of result.data.items) {
    if (ids.has(item.id)) throw new Error(`invalid gate pack — duplicate item id "${item.id}"`);
    ids.add(item.id);
  }
  return result.data;
}

/**
 * Install packs into a pipeline: each pack's seat joins the gate of every stage it names.
 * Returns a NEW pipeline (immutability rule) plus what was ignored — a pack naming a
 * stage the pipeline lacks is reported, never silently dropped.
 */
export function applyPacks(
  pipeline: PipelineDefinition,
  packs: readonly GatePack[],
): { pipeline: PipelineDefinition; ignored: Array<{ packId: string; stage: string }> } {
  const ignored: Array<{ packId: string; stage: string }> = [];
  const stageIds = new Set(pipeline.stages.map((s) => s.id));
  for (const pack of packs) {
    for (const stage of pack.stages) {
      if (!stageIds.has(stage)) ignored.push({ packId: pack.id, stage });
    }
  }

  const stages = pipeline.stages.map((stage): StageDefinition => {
    const joining = packs.filter((p) => p.stages.includes(stage.id));
    if (!joining.length) return stage;
    const gate = stage.gate ?? { kind: 'wave' as const, seats: [] };
    const existing = new Set(gate.seats.map((s) => s.seat));
    const added = joining
      .filter((p) => !existing.has(p.seat))
      .map((p) => ({ seat: p.seat, execute: p.execute }));
    return { ...stage, gate: { ...gate, seats: [...gate.seats, ...added] } };
  });

  return { pipeline: { ...pipeline, stages }, ignored };
}

/**
 * The packet sections a gated stage carries: each joining pack's checklist, rendered so
 * the reviewing seat is told to demand the evidence, not tick the box.
 */
export function packSectionsFor(
  stage: StageDefinition,
  packs: readonly GatePack[],
): NonNullable<PacketContext['extraSections']> {
  return packs
    .filter((p) => p.stages.includes(stage.id))
    .map((pack) => ({
      title: `Gate checklist — ${pack.name} (seat: ${pack.seat})`,
      body: [
        'Every item below is checked against EVIDENCE, never against narration. The seat',
        'records each item as pass / fail / not-applicable WITH the evidence it opened.',
        '',
        '| Id | Sev | Requirement | Evidence that proves it |',
        '|---|---|---|---|',
        ...pack.items.map((i) => `| ${i.id} | ${i.severity} | ${i.requirement} | ${i.evidence} |`),
      ].join('\n'),
    }));
}
