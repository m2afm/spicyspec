/**
 * PARKED.md — the founder-owned list, written in the shape the control room parses.
 *
 * Ported from the prototype's `park()` (lib/ledger.mjs:121) and the stall diagnosis it
 * wrote (driver.mjs:627-634). The heading and field shape is load-bearing, not cosmetic:
 * the room's `parseParked` (room/founder-brief.mjs:144) matches `## <ISO> · <title>` and
 * `- **spec | why the loop cannot do it | what unblocks it**: …`, and it REPORTS AS A
 * PROBLEM any item with no "what unblocks it" — so every append writes all three fields.
 *
 * The prototype's third bug in this area was writing nothing at all: a spec retired by two
 * environmental failures left no trace for the founder to find. A park nobody can read is a
 * park nobody can clear, which is why the room lists a parked entry with no diagnosis as a
 * defect of its own (room-server's parkedList).
 */
import { appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ParkItem {
  title: string;
  spec: string | null;
  why: string;
  unblocks: string;
}

/** The exact block the prototype appended — leading blank line included, so two parks in
 * a row still parse as two headings. */
export function parkBlock(item: ParkItem, at: string): string {
  return [
    '',
    `## ${at} · ${item.title}`,
    '',
    `- **spec**: ${item.spec ?? 'n/a'}`,
    `- **why the loop cannot do it**: ${item.why}`,
    `- **what unblocks it**: ${item.unblocks}`,
    '',
  ].join('\n');
}

export function appendParked(path: string, item: ParkItem, at = new Date().toISOString()): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, parkBlock(item, at), 'utf8');
}

/**
 * The newest run directories for a spec, newest first. Session logs are named
 * `<specId>-r<run>-<startedMs>` (session-log.ts), so the trailing start instant orders them
 * — sorting the names lexically would put run 10 before run 9.
 */
export function lastRunDirs(runsRoot: string, specId: string, limit = 2): string[] {
  let names: string[];
  try {
    names = readdirSync(runsRoot);
  } catch {
    return [];
  }
  const prefix = `${specId}-r`;
  return names
    .filter((n) => n.startsWith(prefix))
    .map((n) => ({ n, started: Number(n.slice(n.lastIndexOf('-') + 1)) || 0 }))
    .sort((a, b) => b.started - a.started)
    .slice(0, limit)
    .map((e) => e.n);
}

export interface ParkDiagnosisInput {
  specId: string;
  /** why the child workflow parked; null when only the queue status says 'parked' */
  parkedFor: 'stalls' | 'review-rejected' | 'blocked' | 'infra-retry-cap' | 'operator-kill' | null | undefined;
  /** the settle status — 'exhausted' is the maxRuns backstop, never a retirement */
  status: string;
  lastExit?: string | null;
  stalls?: number;
  runs?: number;
  /** run-directory names, newest first — where the evidence for this park lives */
  runDirs?: string[];
}

/**
 * Turn a park into a diagnosis a founder can act on. Each cause gets its own "what unblocks
 * it", because the actions are genuinely different: a stall park is an environment to
 * inspect, a blocked park is a decision to make, and an infra-retry park is an account to
 * fix. Collapsing them to one line ("re-queue it") is what made the prototype's parks
 * unreadable.
 */
export function diagnoseParkedSpec(input: ParkDiagnosisInput): ParkItem {
  const exit = input.lastExit ?? 'unrecorded';
  const dirs = input.runDirs ?? [];
  const evidence = dirs.length
    ? ` Read the last ${dirs.length === 1 ? 'run directory' : 'two run directories'} before re-queueing it: ${dirs
        .map((d) => `\`.spicyspec/runs/${d}/\``)
        .join(', ')}.`
    : ' No run directory was recorded for this spec, which is itself worth a look.';
  const counts = `Last exit was \`${exit}\` after ${input.runs ?? 0} run(s) and ${input.stalls ?? 0} consecutive non-progressing run(s).`;

  switch (input.parkedFor) {
    case 'stalls':
      return {
        title: `Spec ${input.specId} parked after repeated stalls`,
        spec: input.specId,
        why:
          `the rotation parked it after ${input.stalls ?? 0} consecutive non-progressing runs. This is an ` +
          'environmental symptom, not a decision about the work: the watchdog killed, or the worker made no ' +
          `progress, twice running. ${counts}${evidence}`,
        unblocks: 'diagnose the stalls, then set this entry back to "pending" in the queue',
      };
    case 'review-rejected':
      return {
        title: `Spec ${input.specId} parked — review rejected`,
        spec: input.specId,
        why: `a recorded review decision rejected this spec, so the run stopped rather than continuing against it. ${counts}${evidence}`,
        unblocks: 'address the rejection note, then set this entry back to "pending" in the queue',
      };
    case 'blocked':
      return {
        title: `Spec ${input.specId} parked — the worker declared a wall`,
        spec: input.specId,
        why:
          'the worker reported RUN_STATUS: blocked — a permission grant or a decision it is not allowed to make. ' +
          `A retry cannot climb a permission wall, so it parked immediately instead of burning the stall budget. ${counts}${evidence}`,
        unblocks: 'grant what the run asked for (or make the decision it named), then set this entry back to "pending"',
      };
    case 'infra-retry-cap':
      return {
        title: `Spec ${input.specId} parked — every account refused`,
        spec: input.specId,
        why:
          'consecutive infra retries hit their cap: every attempt came back rate-limited, refused, or with no ' +
          `attempt at all, so this is the account pool failing rather than the work. ${counts}${evidence}`,
        unblocks: 'check account entitlement and rate-limit state, then set this entry back to "pending"',
      };
    default:
      return {
        title:
          input.status === 'exhausted'
            ? `Spec ${input.specId} parked — the run backstop fired`
            : `Spec ${input.specId} parked`,
        spec: input.specId,
        why:
          (input.status === 'exhausted'
            ? 'the maxRuns backstop fired, which parks the spec with a note and never retires it — a runaway loop ' +
              'must not consume the catalog. '
            : 'the rotation parked it without recording a cause, which is itself the first thing to look at. ') +
          `${counts}${evidence}`,
        unblocks: 'read the run directories, decide whether the work or the environment is at fault, then re-queue as "pending"',
      };
  }
}

/** Compose the two: diagnose, then append. Returns what was written, for the log. */
export function writeParkDiagnosis(
  parkedPath: string,
  runsRoot: string,
  input: ParkDiagnosisInput,
  at = new Date().toISOString(),
): ParkItem {
  const item = diagnoseParkedSpec({ ...input, runDirs: input.runDirs ?? lastRunDirs(runsRoot, input.specId) });
  appendParked(parkedPath, item, at);
  return item;
}

/** The runs root a spec's session logs live under — one place, so the writer and the
 * reader of `.spicyspec/runs/` can never drift. */
export const runsRootFor = (repoCwd: string): string => join(repoCwd, '.spicyspec', 'runs');
