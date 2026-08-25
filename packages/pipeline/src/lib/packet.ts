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

/**
 * The review economics, measured rather than assumed.
 *
 * A forensic audit of five delivered features (65 runs, $1,617, 273 tasks) found 57.7% of
 * spend going to review ceremony against 11.6% editing source, cost per task getting 1.8x
 * WORSE after an earlier round of cuts, and 17.6% of 664 findings changing any code. The
 * rules below are the ones that survived that audit with a defect behind them; the cadence
 * numbers are the ones the cheap feature used and the expensive one did not.
 */
function qualityBlock(ctx: PacketContext): string {
  return [
    'These are not ceremony. Each one has a measured defect catch, or a measured waste, behind it.',
    '',
    `- **Record every gate verdict as one machine-readable JSON line** appended to`,
    `  \`${ctx.gateRecordPath}\` — \`{"at","spec","stage","gate","verdict","seat","frozen"}\` —`,
    '  gate ∈ specify|design|wave|closing|terminal, verdict ∈ APPROVE|REVISE. The last line for',
    '  a spec is its current state. Machines read this line, humans read your prose — a verdict',
    '  only in prose will be misread. **No confidence score, and no BLOCK rung:** across 114',
    '  recorded verdicts confidence separated APPROVE from REVISE by 0.06 inside a 0.17 span,',
    '  never once discriminating an outcome, and BLOCK was used zero times.',
    '- **A gate verdict is written by the seat that reached it, not relayed by you.** Your',
    '  summary of a review is not the review. The orchestrator harvests your transcript for',
    '  the dispatch and the record write; an APPROVE it cannot corroborate is treated as',
    '  fabricated and the unit is re-dispatched.',
    '- **One review per WAVE of 5–6 tasks, never per task.** Two seats, and the owner of the',
    '  changed paths is MANDATORY — a lone critic is a missing reviewer, not compliance. A wave',
    '  closes in at most two rounds; a third only for a genuinely new defect class, never a',
    '  re-fix of the previous round in a new guise. MEASURED: the feature that reviewed 5.5',
    '  tasks per round minted no extra work, cost $4.46/task and shipped; the one that reviewed',
    '  1.1 per round ran 55 rounds to close 53 tasks, cost $8.99/task and did not. Batched',
    '  reviews also found 24% cross-task defects against 8% — the hollowed-harness and',
    '  dead-unwired-code classes are only visible when several tasks are seen together.',
    '- **Every finding names a falsifiable probe** — a mutation that stayed green, a red-first',
    '  test, or an executed command with its output pasted. A numbered item concluding PASS is',
    '  not a finding and is not written down. A round with no probe-backed finding is one line,',
    '  not a section. MEASURED: 57.5% of findings changed only prose and 19.7% were refuted by',
    '  the seat that raised them; every high-yield catch came from the probe form.',
    '- **Never review the process\'s own records.** Task lists, plans, review logs and handoffs',
    '  are corrected in place by their author and never carry a verdict. MEASURED: nine such',
    '  rounds produced nineteen findings and zero code changes, one of them a seat retracting',
    '  itself, and a third of one feature\'s review rounds froze on commits containing no',
    '  application code at all.',
    '- **A converge pass may mint work; a review may not.** A finding needing new work is fixed',
    '  inside the wave that found it, or filed as a converge input. MEASURED: review-minted',
    '  tasks are what drove one feature from 52 rows to 87 and its cadence to 1.1 tasks/round.',
    '- **Fix per finding, re-review the diff.** Batching findings into one commit injected',
    '  ~1 live defect per 6–9 fixes in measurement.',
    '- **Prove it can fail.** Any assertion guarding an invariant must be shown to go red',
    '  when the invariant is broken, before it goes green.',
    '- **Verification has three tiers and no others:** scoped and cached on the affected project',
    '  at every commit; a full uncached sweep at exactly two moments — end of wave, and the',
    '  terminal gate; and never a command byte-identical to one already run this session on the',
    '  same tree. MEASURED: 79% of verify calls ran with no source edit since the previous one,',
    '  and 73 full uncached suite runs landed inside one 5.4-hour window.',
  ].join('\n');
}

/**
 * TWO journeys, and the audit that separated them.
 *
 * The previous wording — "the human review journey is the one thing you may not do" — was
 * read as a ban on automating any clicking. Measured consequence across five delivered
 * features: ZERO browser tool calls in 8,855 tool calls and 22MB of session logs, three
 * runnable e2e projects excluded from every "full sweep", and a static route-reachability
 * parser built as a substitute that cost five review rounds and ten commits perfecting its
 * own regex while changing no product behaviour. Both defects that escaped to a human were
 * exactly the class clicking catches: a checkout page unreachable because the server
 * returned `url` where the client declared `redirectUrl` (15.5h in tree), and a published
 * listing whose PATCH re-validated nothing (25h to discovery). One real journey costs about
 * 70 seconds of wall clock.
 */
function reviewBlock(ctx: PacketContext): string {
  return [
    '**You owe an EXECUTED browser journey. It is not optional and no static check replaces it.**',
    'Write one end-to-end spec per feature in the repo\'s own browser-test project, reaching the',
    'feature **by navigation — no typed URL** — and completing its primary action. Discover the',
    'command from the repo\'s tooling, run it UNCACHED at the terminal gate, and paste the command',
    'with its pass/fail output into the gate record. A route-reachability parser, an architecture',
    'test, or an argument about reachability does NOT satisfy this: reasoning about whether a',
    'screen can be reached is exactly what has failed here before, twice, while every suite',
    'stayed green.',
    '',
    '**The FOUNDER journey is separate, and still theirs.** Your executed journey proves the path',
    'exists; their click proves the product is worth reaching. Never claim their journey as done,',
    'never simulate it, and never let yours stand in for it — write it as a numbered click path',
    `(exact start URL, exact expected outcome) into \`${ctx.parkedPath}\`, set`,
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
