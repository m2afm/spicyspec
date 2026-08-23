/**
 * Pipeline definitions — RFC-001 layer 5.
 *
 * A pipeline is the declarative spine of a delivery run: ordered stages, each with its own
 * instructions and an optional gate. A simple app declares a short pipeline; an enterprise
 * app declares the full one plus compliance packs. Same engine, declared depth.
 *
 * Validated with zod at the boundary: a typo in a pipeline file must be a load error, not
 * a silent misbehavior three stages later.
 */
import { z } from 'zod';

export const GATE_SEAT = z.object({
  /** agent-manifest id of the reviewing seat (e.g. 'qa-critic', 'backend-owner') */
  seat: z.string().min(1),
  /** may this seat run commands to verify claims, or is it read-only? */
  execute: z.boolean().default(false),
});

export const STAGE_GATE = z.object({
  /** recorded gate kind — must match core gates.GATE_KINDS */
  kind: z.enum(['specify', 'design', 'wave', 'closing', 'terminal']),
  /**
   * Two seats by default: path owner + adversarial critic. The prototype measured wider
   * councils as rubber stamps (9 of 18 rulings) — widen only on conflict or low confidence.
   */
  seats: z.array(GATE_SEAT).min(1),
});

export const STAGE_DEFINITION = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'stage ids are kebab-case'),
  title: z.string().min(1),
  /** the stage prompt body — what the worker is told to do in this stage */
  instructions: z.string().min(1),
  gate: STAGE_GATE.optional(),
  /** artifact paths this stage produces, templated with {specDir} */
  produces: z.array(z.string()).default([]),
});

export const PIPELINE_DEFINITION = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  stages: z.array(STAGE_DEFINITION).min(1),
});

export type GateSeat = z.infer<typeof GATE_SEAT>;
export type StageGate = z.infer<typeof STAGE_GATE>;
export type StageDefinition = z.infer<typeof STAGE_DEFINITION>;
export type PipelineDefinition = z.infer<typeof PIPELINE_DEFINITION>;

/** Parse + validate a pipeline definition. Throws with a readable message on a bad file. */
export function parsePipeline(raw: unknown): PipelineDefinition {
  const result = PIPELINE_DEFINITION.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid pipeline definition — ${detail}`);
  }
  const ids = new Set<string>();
  for (const stage of result.data.stages) {
    if (ids.has(stage.id)) throw new Error(`invalid pipeline definition — duplicate stage id "${stage.id}"`);
    ids.add(stage.id);
  }
  return result.data;
}

export function stageAfter(pipeline: PipelineDefinition, stageId: string): StageDefinition | null {
  const idx = pipeline.stages.findIndex((s) => s.id === stageId);
  if (idx < 0) throw new Error(`unknown stage "${stageId}" in pipeline "${pipeline.id}"`);
  return pipeline.stages[idx + 1] ?? null;
}

/**
 * The default spec-driven pipeline — the generalized shape of the prototype's stage map:
 * intake → specify → clarify → plan → tasks → execute → converge → handoff.
 * Instructions here are the generic spine; projects extend or replace stages, and skill
 * packs hang extra gate checks off `gate.seats`.
 */
export const specDrivenPipeline: PipelineDefinition = parsePipeline({
  id: 'spec-driven',
  name: 'Spec-driven delivery',
  stages: [
    {
      id: 'intake',
      title: 'Intake',
      instructions:
        'Turn the input (idea, documentation set, or competition brief) into a feature description: ' +
        'goals, constraints, references, and explicit non-goals. Cite every source document you used.',
      produces: ['{specDir}/intake.md'],
    },
    {
      id: 'specify',
      title: 'Specify',
      instructions:
        'Write the feature specification: functional requirements with stable ids, success criteria, ' +
        'and a traceability table mapping every requirement to its source. Self-answer clarifications ' +
        'inline where the evidence permits, citing the source for each answer.',
      gate: { kind: 'specify', seats: [{ seat: 'product-owner', execute: false }, { seat: 'qa-critic', execute: true }] },
      produces: ['{specDir}/spec.md'],
    },
    {
      id: 'clarify',
      title: 'Clarify',
      instructions:
        'Resolve the remaining underspecified points. Anything answerable from code or documents is ' +
        'answered and cited; anything genuinely owner-only is parked as a review question, and every ' +
        'part of the work that does not depend on it continues.',
      produces: ['{specDir}/spec.md'],
    },
    {
      id: 'plan',
      title: 'Plan',
      instructions:
        'Write the implementation plan: architecture slice, every server-side enforcement point named, ' +
        'wave decomposition with file ownership per wave, and the verification tiers each wave runs.',
      gate: { kind: 'design', seats: [{ seat: 'tech-owner', execute: false }, { seat: 'qa-critic', execute: true }] },
      produces: ['{specDir}/plan.md'],
    },
    {
      id: 'tasks',
      title: 'Tasks',
      instructions:
        'Decompose the plan into an ordered task list. Every task traces to a requirement id; ' +
        'gate-enforcement tasks are test-first; each task names the paths it owns.',
      gate: { kind: 'design', seats: [{ seat: 'tech-owner', execute: false }, { seat: 'qa-critic', execute: true }] },
      produces: ['{specDir}/tasks.md'],
    },
    {
      id: 'execute',
      title: 'Execute',
      instructions:
        'Work the task list wave by wave. Red-first on every guard: prove the test fails before making ' +
        'it pass. Fix per finding, re-review the diff — never batch findings into one commit. ' +
        'After every wave touching money, auth, or a public surface: convene the wave gate.',
      gate: { kind: 'wave', seats: [{ seat: 'path-owner', execute: false }, { seat: 'qa-critic', execute: true }] },
    },
    {
      id: 'converge',
      title: 'Converge',
      instructions:
        'Assess the tree against spec, plan, and tasks. Append any unbuilt remainder as new tasks. ' +
        'Run the full uncached verification sweep once, at this stage, from a clean cache.',
      gate: { kind: 'closing', seats: [{ seat: 'qa-critic', execute: true }] },
    },
    {
      id: 'handoff',
      title: 'Handoff',
      instructions:
        'Assemble the handoff package: repo at a frozen commit, the spec kit, gate records, test ' +
        'evidence, checklist-pack reports, runbook, and production-adjustment notes. Write the ' +
        'human review journey as a numbered click path with the exact start URL and expected outcome, ' +
        'then set status awaiting-review.',
      gate: { kind: 'terminal', seats: [{ seat: 'qa-critic', execute: true }] },
    },
  ],
});
