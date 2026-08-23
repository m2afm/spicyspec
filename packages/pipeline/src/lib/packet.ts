/**
 * The work packet — the entire prompt a worker session receives.
 *
 * Generalized from the prototype's packet builder, where every block existed because a
 * measurement said the pipeline lost hours without it:
 *   - subagents pre-approved: the unstated ban cost ~4.3h/spec of back-loaded review
 *   - wave gates, not end gates: one deferred review returned 23 findings on a green tree
 *   - never wait for a human: in an unattended loop every wait clause is a dead session
 *   - the human journey is parked, never simulated: the only detector that ever caught
 *     the unreachable-screen class — twice
 *   - bounded read-first: 137k tokens of mandated reading, re-paid at every session
 *     boundary, cost ~4h/spec
 *
 * Everything project-specific arrives via PacketContext; nothing here names a repo.
 */
import type { StageDefinition } from './definition.js';

const MAX_VERDICT_CHARS = 2400;

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}\n`;
}

export interface PositionInfo {
  branch: string;
  head: string;
  headSubject: string;
  dirty: boolean;
  dirtyPaths: string[];
  tasksDone: number;
  tasksOpen: number;
  nextTaskIds: string[];
}

export interface ReadFirstRow {
  what: string;
  why: string;
}

export interface PredecessorVerdict {
  assessment?: string;
  claimsUnverified?: string[];
  correction?: string;
  nextAction?: string;
}

export interface PacketContext {
  projectName: string;
  runNumber: number;
  specId: string;
  stage: StageDefinition;
  position: PositionInfo;
  /** bounded read-first list — everything else is opened only when a task points at it */
  readFirst: ReadFirstRow[];
  /** orchestrator-owned paths the worker must never write (also ENFORCED via canUseTool) */
  protectedPaths: string[];
  /** where gate verdicts are recorded (JSONL, one object per line) */
  gateRecordPath: string;
  /** where owner-only blockers are parked */
  parkedPath: string;
  /** judge verdict on the predecessor run, when one exists */
  predecessorVerdict?: PredecessorVerdict | null;
  /** a one-shot operator instruction — outranks the work list, steers exactly one run */
  directNote?: string | null;
  /** project extras appended verbatim (e.g. verification-tier commands, catalog entries) */
  extraSections?: Array<{ title: string; body: string }>;
}

/** The status tokens a worker ends with — the classifier reads these. */
export const STATUS_TOKENS = ['continuing', 'spec-complete', 'awaiting-review', 'blocked'] as const;

function authorityBlock(ctx: PacketContext): string {
  return [
    `You are the **worker** of the ${ctx.projectName} delivery run. An orchestrator started`,
    'you and will start your successor the moment you exit. Act accordingly:',
    '',
    '1. **You are the only writer on this tree.** The orchestrator holds the lock. Do not',
    '   coordinate with anyone; do not wait.',
    '2. **Subagents and review councils are PRE-APPROVED.** Use them; they are the',
    "   pipeline's highest-yield mechanism.",
    '3. **Never stop to ask.** No confirmations, no progress reports, no waiting. Resolve',
    '   forks yourself with a two-seat council and log the ruling. If something is',
    `   genuinely owner-only, append it to \`${ctx.parkedPath}\`, say \`PARKED: <one line>\``,
    '   in your final message, and keep building everything that does not depend on it.',
    '4. **Never mark work done that you did not execute.** No claimed test results, ever.',
    "5. **Do not write to the orchestrator's own state.** These paths are the machinery",
    '   running you — the runtime DENIES writes to them, and every attempt is recorded:',
    ...ctx.protectedPaths.map((p) => `   - \`${p}\``),
    `   The single exception is \`${ctx.parkedPath}\` (append-only), for owner-only blockers.`,
  ].join('\n');
}

function positionBlock(p: PositionInfo): string {
  const lines = [
    `- branch **${p.branch}**, HEAD \`${p.head}\` — ${p.headSubject}`,
    `- tree: ${p.dirty ? `**DIRTY** — ${p.dirtyPaths.length} path(s): ${p.dirtyPaths.slice(0, 12).join(', ')}` : 'clean'}`,
    `- tasks: **${p.tasksDone} done / ${p.tasksOpen} open**` +
      (p.nextTaskIds.length ? `; next open ids: ${p.nextTaskIds.join(', ')}` : ''),
  ];
  if (p.dirty) {
    lines.push(
      '- **A dirty tree means the previous run ended mid-unit.** Reconcile it before opening' +
        ' new work: read the diff, finish or revert it deliberately, commit. Never build on' +
        ' top of an unexplained diff.',
    );
  }
  return lines.join('\n');
}

function readFirstBlock(rows: ReadFirstRow[]): string {
  return [
    'Read these, in this order, and **nothing else up front**. Unbounded read-first was',
    'measured at hours per spec across session boundaries; open anything further only when',
    'a task points you at it.',
    '',
    '| What | Why |',
    '|---|---|',
    ...rows.map((r) => `| ${r.what} | ${r.why} |`),
  ].join('\n');
}

function qualityBlock(ctx: PacketContext): string {
  return [
    'These are not ceremony. Each one has a recorded live-defect catch behind it.',
    '',
    `- **Record every gate verdict as one machine-readable JSON line** appended to`,
    `  \`${ctx.gateRecordPath}\` — \`{"at","spec","stage","gate","verdict","confidence",`,
    '  `"seat","frozen"}` — gate ∈ specify|design|wave|closing|terminal, verdict ∈',
    '  APPROVE|REVISE|BLOCK. The last line for a spec is its current state. Machines read',
    '  this line, humans read your prose — a verdict only in prose will be misread.',
    '- **A gate verdict is written by the seat that reached it, not relayed by you.** Your',
    '  summary of a review is not the review. The orchestrator harvests your transcript for',
    '  the dispatch and the record write; an APPROVE it cannot corroborate is treated as',
    '  fabricated and the unit is re-dispatched.',
    '- **Gate at the wave, not at the end.** After every wave touching money, auth, or a',
    '  public surface: a two-seat review (path owner + adversarial critic), one round, told',
    '  to OPEN THE FILES, not weigh options. More than 12 findings means the wave was too big.',
    '- **Fix per finding, re-review the diff.** Batching findings into one commit injected',
    '  ~1 live defect per 6–9 fixes in measurement.',
    '- **Prove it can fail.** Any assertion guarding an invariant must be shown to go red',
    '  when the invariant is broken, before it goes green.',
  ].join('\n');
}

function reviewBlock(ctx: PacketContext): string {
  return [
    '**The human review journey is the one thing you may not do.** The exit bar requires a',
    'human to reach the feature by clicking and complete its primary action. A step',
    'performed by you or a script is a step the journey did not test — simulated journeys',
    'have "completed" purchases on unreachable pages while every suite stayed green.',
    '',
    'Build up to it, make it *possible*, then hand it over: write the journey as a numbered',
    `click path (exact start URL, exact expected outcome) into \`${ctx.parkedPath}\`, set`,
    '`RUN_STATUS: awaiting-review`, and exit.',
  ].join('\n');
}

function exitBlock(): string {
  return [
    'Exit deliberately — your successor starts from what you leave behind:',
    '',
    '- **Never end a run waiting on a background command.** Nothing will notify you after',
    '  you exit; poll to completion or wait in the foreground.',
    '- At roughly **15% context remaining**, or as soon as the next unit visibly will not',
    '  fit: finish the unit you are inside, **never start a new one**, never stop mid-gate.',
    '- Commit the tree, update the handoff document.',
    '- Your final message is at most 15 lines: what you did, what is next, any `PARKED:` line.',
    '- End with exactly one status token on its own line:',
    '  ' + STATUS_TOKENS.map((t) => `\`RUN_STATUS: ${t}\``).join(' · '),
  ].join('\n');
}

function verdictBlock(verdict: PredecessorVerdict): string | null {
  const parts: string[] = [];
  if (verdict.assessment) parts.push(`**Assessment of the last run:** ${verdict.assessment}`);
  if (verdict.claimsUnverified?.length) {
    parts.push(
      '**Claims it could not verify — re-check these before building on them:**\n' +
        verdict.claimsUnverified.map((c) => `- ${c}`).join('\n'),
    );
  }
  if (verdict.correction) parts.push(`**Correction for this run:** ${verdict.correction}`);
  if (verdict.nextAction) parts.push(`**Directed next action:** ${verdict.nextAction}`);
  const text = parts.join('\n\n');
  return text ? text.slice(0, MAX_VERDICT_CHARS) : null;
}

/** Assemble the full worker prompt for one run of one stage. */
export function buildPacket(ctx: PacketContext): string {
  const blocks = [
    `# ${ctx.projectName.toUpperCase()} DELIVERY RUN ${ctx.runNumber} — spec ${ctx.specId} · stage ${ctx.stage.id}`,
    '',
    section('Your authority and your constraints', authorityBlock(ctx)),
    section('Where the tree actually is (generated, verified this second)', positionBlock(ctx.position)),
    section('Read-first — bounded', readFirstBlock(ctx.readFirst)),
    section(`This stage: ${ctx.stage.title}`, ctx.stage.instructions),
    section('The rules that have caught real defects', qualityBlock(ctx)),
    section('The human review journey — parked, never simulated', reviewBlock(ctx)),
    section('How to exit', exitBlock()),
  ];

  if (ctx.predecessorVerdict) {
    const v = verdictBlock(ctx.predecessorVerdict);
    if (v) blocks.push(section('The orchestrator reviewed your predecessor', v));
  }

  if (ctx.directNote?.trim()) {
    blocks.push(section('A DIRECT INSTRUCTION FOR THIS RUN — it outranks the work list', ctx.directNote.trim()));
  }

  for (const extra of ctx.extraSections ?? []) {
    blocks.push(section(extra.title, extra.body));
  }

  blocks.push(section('Now', 'Orient, then work. Start with the highest-priority unfinished unit. Go.'));

  return blocks.join('\n');
}
