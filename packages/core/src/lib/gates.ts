/**
 * Gate verdicts as machine-readable records, because prose cannot be read reliably.
 *
 * Ported from the Airvia prototype, where this was tested rather than assumed: a detector
 * looking for a spec id near a "closing gate" phrase near an APPROVE, run against the real
 * 5,260-line review journal, was wrong in both directions on the first three specs tried —
 * it approved a spec that had no directory, matched one spec's headings to another's frozen
 * commit, and missed a literal "CLOSING GATE" heading. Any hard rule built on prose would
 * retire an unbuilt spec and stall a finished one. So the prose stays for humans, and the
 * verdict gets its own append-only record.
 *
 * The record is a fact the reviewer states, not a fact inferred about the reviewer.
 * Absence means UNKNOWN, never PASS (RFC-001 §7.1). Work that predates the record store
 * reports 'unknown', and every consumer must degrade accordingly — otherwise adding
 * records would retroactively invalidate work that is fine.
 *
 * This module is pure: parsing and querying only. Storage (JSONL file, SQLite, Postgres)
 * lives behind the repository layer.
 */
import { z } from 'zod';

export const VERDICTS = ['APPROVE', 'REVISE', 'BLOCK'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const GATE_KINDS = ['specify', 'design', 'tasks', 'wave', 'closing', 'terminal'] as const;
export type GateKind = (typeof GATE_KINDS)[number];

export const gateRecordSchema = z
  .object({
    at: z.string(),
    spec: z.union([z.string(), z.number()]).transform(String),
    stage: z.string().optional(),
    gate: z.enum(GATE_KINDS).default('wave'),
    verdict: z.enum(VERDICTS),
    confidence: z.number().min(0).max(1).optional(),
    seat: z.string().optional(),
    frozen: z.string().optional(),
    note: z.string().optional(),
  })
  .passthrough();

export type GateRecord = z.infer<typeof gateRecordSchema> & { line?: number };

export interface ParsedGates {
  records: GateRecord[];
  problems: string[];
}

/**
 * Parse an append-only JSONL block of gate records. Malformed lines become problems, never
 * silent drops — a record that fails to parse is a fact the caller must surface.
 */
export function parseGateRecords(text: string, sourceName = 'gates.jsonl'): ParsedGates {
  const records: GateRecord[] = [];
  const problems: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      problems.push(`${sourceName}:${i + 1}: not JSON`);
      continue;
    }
    const parsed = gateRecordSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(`${sourceName}:${i + 1}: ${parsed.error.issues.map((iss) => iss.message).join('; ')}`);
      continue;
    }
    records.push({ ...parsed.data, line: i + 1 });
  }
  return { records, problems };
}

export type GateState = 'approved' | 'open' | 'unknown';

export interface GateStatus {
  state: GateState;
  record: GateRecord | null;
  count: number;
}

/**
 * The state of a spec's closing gate: 'approved', 'open', or 'unknown'.
 *
 * 'open' means the latest closing record is a REVISE or BLOCK — there are findings to fix.
 * 'unknown' means no record exists, which is the honest answer for anything built before
 * records existed, and must never be read as a pass.
 *
 * Last write wins: a re-review after fixes is the current verdict, and it appears later.
 */
export function closingGate(records: readonly GateRecord[], specId: string): GateStatus {
  const mine = records.filter(
    (r) => String(r.spec) === String(specId) && (r.gate === 'closing' || r.gate === 'terminal'),
  );
  if (!mine.length) return { state: 'unknown', record: null, count: 0 };
  const latest = mine[mine.length - 1];
  return {
    state: latest.verdict === 'APPROVE' ? 'approved' : 'open',
    record: latest,
    count: mine.length,
  };
}

/** Serialize one record for the append-only store. Validates; throws on a malformed record. */
export function serializeGateRecord(record: unknown): string {
  const parsed = gateRecordSchema.parse(record);
  return JSON.stringify(parsed);
}
