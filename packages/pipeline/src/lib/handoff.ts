/**
 * The handoff package — the platform's OUTPUT CONTRACT (RFC-001 §5).
 *
 * A run never ends as "code somewhere": it ends as an auditable document a production
 * team can act on — frozen commit, spec inventory with gate states, run economics
 * derived from records (never assumed — the prototype once hard-coded a billing claim
 * that went stale mid-run), the machine-readable gate trail, and the human review
 * journeys still owed. Pure render: the caller gathers facts, this file writes them.
 */
import type { GateState, LedgerEntry } from '@spicyspec/core';

export interface HandoffSpec {
  id: string;
  status: string;
  stage: string | null;
  /** from core closingGate over the stored records — 'unknown' is printed as exactly that */
  closingGate: GateState;
}

export interface HandoffInput {
  projectName: string;
  generatedAt: string;
  frozen: { sha: string; branch: string; subject: string };
  specs: HandoffSpec[];
  runs: LedgerEntry[];
  /** verbatim parked journeys — what a human must click before anything is "done" */
  parked: string;
  /** the git-auditable gate trail, verbatim JSONL */
  gatesJsonl: string;
  notes?: string;
}

const GATE_LABEL: Record<GateState, string> = {
  approved: 'APPROVED',
  open: 'OPEN — findings outstanding',
  unknown: 'UNKNOWN — no record; never read as a pass',
};

export function renderHandoffPackage(input: HandoffInput): string {
  const totalCost = input.runs.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const totalTasks = input.runs.reduce((a, r) => a + (r.tasksClosed ?? 0), 0);
  const distinctRuns = new Set(input.runs.map((r) => r.tick)).size;
  const judged = input.runs.filter((r) => r['judgedBy']).length;
  const dishonest = input.runs.filter((r) => r['judgeHonest'] === false).length;

  const L: string[] = [];
  L.push(`# ${input.projectName} — handoff package`);
  L.push('');
  L.push(`Generated ${input.generatedAt}. Everything below is derived from records; where a`);
  L.push('record is absent the state is printed as UNKNOWN, never assumed.');
  L.push('');
  L.push('## Frozen position');
  L.push('');
  L.push(`- branch \`${input.frozen.branch}\`, commit \`${input.frozen.sha}\` — ${input.frozen.subject}`);
  L.push('- the app boots in dev mode from this commit; production adjustment is the receiving');
  L.push("  team's work, guided by the notes below.");
  L.push('');
  L.push('## Spec inventory');
  L.push('');
  L.push('| Spec | Status | Stage | Closing gate |');
  L.push('|---|---|---|---|');
  for (const s of input.specs) {
    L.push(`| ${s.id} | ${s.status} | ${s.stage ?? '—'} | ${GATE_LABEL[s.closingGate]} |`);
  }
  L.push('');
  L.push('## Run economics (from the ledger, not from memory)');
  L.push('');
  L.push(`- ${distinctRuns} distinct runs (${input.runs.length} rows — retries keep their number)`);
  L.push(`- ${totalTasks} tasks closed · ~$${totalCost.toFixed(2)} notional token value`);
  L.push(
    judged
      ? `- second-vendor judge reviewed ${judged} run(s); ${dishonest} flagged dishonest — read those rows first`
      : '- no second-vendor judge records — honesty checks were not configured for this run',
  );
  L.push('');
  L.push('## Human review owed (nothing here is done until a human clicks it)');
  L.push('');
  L.push(input.parked.trim() || '_No parked journeys were recorded — verify this against the spec inventory before accepting._');
  L.push('');
  L.push('## Gate trail (machine-readable, append-only)');
  L.push('');
  L.push('```jsonl');
  L.push(input.gatesJsonl.trim() || '(empty — no gate verdicts were recorded)');
  L.push('```');
  if (input.notes?.trim()) {
    L.push('');
    L.push('## Production adjustment notes');
    L.push('');
    L.push(input.notes.trim());
  }
  L.push('');
  return L.join('\n');
}
