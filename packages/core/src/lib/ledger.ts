/**
 * The run ledger — pure parsing and aggregation.
 *
 * Append-only JSONL is the record; a ROLLING digest is what anyone reads. An append-only
 * log that every resume re-reads grows token cost quadratically over a marathon — the
 * prototype paid for that lesson with a 4,751-line decision journal. Storage and digest
 * rendering live outside core; this module owns the shapes and the arithmetic.
 */

export interface LedgerEntry {
  /** run number — a rate-limited attempt keeps its number and is retried */
  tick: number;
  /**
   * Retry identity for a row that SHARES its tick with another: 'rate-limited-retry',
   * 'account-refused-retry', 'no-attempt-retry', or null on a real work run. Declared,
   * not left to the index signature, because two things read it — `runs` counts distinct
   * ticks (so retries never inflate the total) and the control room renders this tag so a
   * founder can tell a real run from an infra retry in the same table.
   */
  attempt?: string | null;
  startedAt?: string;
  durationMinutes?: number;
  exit?: string;
  commits?: boolean;
  tasksClosed?: number;
  costUsd?: number;
  /** HEAD of the worked tree after the run. `null` is unknown, same as absent. */
  head?: string | null;
  note?: string;
  overageStatus?: string | null;
  usedOverage?: boolean | null;
  /**
   * Provider rate-limit facts as reported ON THIS RUN — the account panel's rate,
   * utilization and window chips have no other source, and read the LAST row per account.
   * `rateResetsAt` is epoch SECONDS, as the provider states it.
   */
  rateStatus?: string | null;
  utilization?: number | null;
  rateResetsAt?: number | null;
  /**
   * Red-first residue left behind by this run. Declared, not left to the index signature,
   * because the distinction is load-bearing: an EMPTY list means clean, an absent field
   * means unknown, and the control room renders those differently on purpose.
   */
  redFirstResidue?: Array<{ file: string; marker: string }>;
  [key: string]: unknown;
}

export interface ParsedLedger {
  entries: LedgerEntry[];
  problems: string[];
}

/** Parse a JSONL ledger. Malformed lines are problems, never silent drops. */
export function parseLedger(text: string, sourceName = 'ledger.jsonl'): ParsedLedger {
  const entries: LedgerEntry[] = [];
  const problems: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as LedgerEntry;
      if (typeof parsed.tick !== 'number') {
        problems.push(`${sourceName}:${i + 1}: entry has no numeric tick`);
        continue;
      }
      entries.push(parsed);
    } catch {
      problems.push(`${sourceName}:${i + 1}: not JSON`);
    }
  }
  return { entries, problems };
}

export interface LedgerTotals {
  /** DISTINCT run numbers, not rows: counting rows overstated the prototype's run, because
   * a rate-limited attempt keeps its number and is retried. */
  runs: number;
  rows: number;
  costUsd: number;
  tasksClosed: number;
  minutes: number;
}

export function ledgerTotals(entries: readonly LedgerEntry[]): LedgerTotals {
  const distinct = new Set(entries.map((t) => t.tick)).size;
  return entries.reduce<LedgerTotals>(
    (acc, t) => ({
      runs: distinct,
      rows: acc.rows + 1,
      costUsd: acc.costUsd + (t.costUsd ?? 0),
      tasksClosed: acc.tasksClosed + (t.tasksClosed ?? 0),
      minutes: acc.minutes + (t.durationMinutes ?? 0),
    }),
    { runs: 0, rows: 0, costUsd: 0, tasksClosed: 0, minutes: 0 },
  );
}

/**
 * State the billing position from what the provider actually reported, per run.
 *
 * The prototype hard-coded "overage is disabled" — true when written, false hours later
 * when the account's overage state changed mid-run, and the dashboard went on asserting
 * the stale value as fact. So: derived from records, never assumed.
 */
export function overageSummary(entries: readonly LedgerEntry[]): {
  assertable: boolean;
  billedRuns: number;
  statesSeen: string[];
  line: string;
} {
  const statesSeen = [...new Set(entries.map((t) => t.overageStatus).filter((s): s is string => Boolean(s)))];
  const billedRuns = entries.filter((t) => t.usedOverage === true).length;
  if (!statesSeen.length) {
    return {
      assertable: false,
      billedRuns: 0,
      statesSeen,
      line: 'no overage state was reported on any run, so nothing can be asserted.',
    };
  }
  if (billedRuns) {
    return {
      assertable: true,
      billedRuns,
      statesSeen,
      line: `${billedRuns} run(s) used overage and may be billable (states seen: ${statesSeen.join(', ')}).`,
    };
  }
  return {
    assertable: true,
    billedRuns: 0,
    statesSeen,
    line: `no run used overage (states seen: ${statesSeen.join(', ')}).`,
  };
}
