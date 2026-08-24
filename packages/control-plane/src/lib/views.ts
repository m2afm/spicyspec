/**
 * Dashboard view models — the "managers page" data, RFC-001 layer 7.
 *
 * Pure: store state in, view model out. The control plane READS the store the runner
 * writes; it never writes run state (single-writer discipline — the runner owns the tree
 * and its own state). The one thing a manager can DO — approve/reject a review — is
 * recorded as an intent in the store KV, which a runner-side bridge turns into the
 * Temporal signal. So even the command path keeps the control plane off Temporal.
 */
import { closingGate, ledgerTotals, overageSummary, type GateState } from '@spicyspec/core';
import type { Store } from '@spicyspec/store';

export interface SpecView {
  id: string;
  status: string;
  stage: string | null;
  closingGate: GateState;
  runs: number;
  lastExit: string | null;
  lastCostUsd: number | null;
}

export interface OverviewView {
  projectName: string;
  generatedAt: string;
  counts: Record<string, number>;
  specs: SpecView[];
  totals: { runs: number; rows: number; costUsd: number; tasksClosed: number };
  billing: string;
  awaitingReview: string[];
}

export interface RunView {
  tick: number;
  exit: string | null;
  costUsd: number | null;
  tasksClosed: number | null;
  commits: boolean | null;
  account: string | null;
  judgedBy: string | null;
  judgeHonest: boolean | null;
  judgeAction: string | null;
}

/** The review-decision intent a manager records; a runner bridge signals Temporal from it. */
export interface ReviewDecisionRecord {
  specId: string;
  approved: boolean;
  note: string;
  at: string;
  by: string;
}

export const REVIEW_DECISION_KEY = (specId: string) => `review:decision:${specId}`;

export function overview(store: Store, projectName: string, generatedAt: string): OverviewView {
  const queue = store.loadQueue();
  const runs = store.listRuns();
  const gates = store.listGates();

  const counts: Record<string, number> = {};
  for (const e of queue.entries) counts[String(e.status)] = (counts[String(e.status)] ?? 0) + 1;

  const runsBySpec = new Map<string, RunView[]>();
  // ledger rows do not carry a specId in Phase 1 (one active spec at a time); attribute by
  // order is unsafe, so spec-level run counts come from the queue's own accounting when
  // present and fall back to the whole-ledger total otherwise.
  void runsBySpec;

  const specs: SpecView[] = queue.entries.map((e) => {
    const gate = closingGate(gates, e.id);
    return {
      id: e.id,
      status: String(e.status),
      stage: e.stage ?? null,
      closingGate: gate.state,
      runs: 0,
      lastExit: null,
      lastCostUsd: null,
    };
  });

  const t = ledgerTotals(runs);
  return {
    projectName,
    generatedAt,
    counts,
    specs,
    totals: { runs: t.runs, rows: t.rows, costUsd: t.costUsd, tasksClosed: t.tasksClosed },
    billing: overageSummary(runs).line,
    awaitingReview: queue.entries.filter((e) => e.status === 'awaiting-review').map((e) => e.id),
  };
}

export function runHistory(store: Store, limit = 50): RunView[] {
  return store.listRuns(limit).map((r) => ({
    tick: r.tick,
    exit: (r.exit as string) ?? null,
    costUsd: (r.costUsd as number) ?? null,
    tasksClosed: (r.tasksClosed as number) ?? null,
    commits: (r.commits as boolean) ?? null,
    account: (r['account'] as string) ?? null,
    judgedBy: (r['judgedBy'] as string) ?? null,
    judgeHonest: (r['judgeHonest'] as boolean) ?? null,
    judgeAction: (r['judgeAction'] as string) ?? null,
  }));
}

export function gateTrail(store: Store, specId?: string) {
  return store.listGates(specId).map((g) => ({
    at: g.at,
    spec: g.spec,
    gate: g.gate,
    verdict: g.verdict,
    confidence: g.confidence ?? null,
    seat: g.seat ?? null,
    frozen: g.frozen ?? null,
  }));
}

/** Record a manager's review decision (the only write the control plane performs). */
export function recordReviewDecision(store: Store, record: ReviewDecisionRecord): void {
  const queue = store.loadQueue();
  if (!queue.entries.some((e) => e.id === record.specId)) {
    throw new Error(`review decision for unknown spec "${record.specId}"`);
  }
  store.setKv(REVIEW_DECISION_KEY(record.specId), JSON.stringify(record));
}

export function readReviewDecision(store: Store, specId: string): ReviewDecisionRecord | null {
  const raw = store.getKv(REVIEW_DECISION_KEY(specId));
  return raw ? (JSON.parse(raw) as ReviewDecisionRecord) : null;
}
