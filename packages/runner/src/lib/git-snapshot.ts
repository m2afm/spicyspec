/**
 * Evidence snapshots — the repo facts the classifier compares before/after a run.
 *
 * Exec and file reads are injected so every parsing rule is testable; the defaults hit
 * the real repo. Two prototype defects live here as rules:
 *  - B1: `git status --porcelain` lines are parsed WITHOUT trimming — the status field is
 *    columns 0–1 and the path starts at column 3; a trimmed unstaged-only line
 *    (`" M path"`) loses its first character.
 *  - B22: git calls carry `--no-optional-locks` and a timeout — a snapshot must never
 *    take the index lock against a tree a worker is committing to, and an unbounded
 *    sync git call inside a watchdog interval once stalled the only heartbeat.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { EvidenceSnapshot } from '@spicyspec/core';
import { countTasks } from './tasks.js';

const execFileAsync = promisify(execFile);

export type ExecFn = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string>;

const defaultExec: ExecFn = async (cmd, args, { cwd, timeoutMs }) => {
  const { stdout } = await execFileAsync(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true });
  return stdout;
};

export interface GitStatus {
  dirty: boolean;
  dirtyPaths: string[];
}

/** Parse porcelain output. NEVER trim the lines (B1). */
export function parsePorcelain(output: string): GitStatus {
  const dirtyPaths: string[] = [];
  for (const line of output.split('\n')) {
    if (!line || line.length < 4) continue;
    dirtyPaths.push(line.slice(3));
  }
  return { dirty: dirtyPaths.length > 0, dirtyPaths };
}

/**
 * Drop the orchestrator's own paths from a dirty listing — B2: the prototype's state
 * files made every tree look dirty, so every run was told to reconcile a diff that was
 * just the ledger. Reproduced verbatim by the first live smoke (`.spicyspec/runner.db`
 * kept the tree "dirty", which also blocked the spec-complete classification).
 */
export function filterSelfOwned(paths: readonly string[], selfOwnedPaths: readonly string[]): string[] {
  if (!selfOwnedPaths.length) return [...paths];
  const prefixes = selfOwnedPaths.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase());
  return paths.filter((path) => {
    const normalized = path.replace(/\\/g, '/').replace(/^"|"$/g, '').toLowerCase();
    return !prefixes.some((prefix) => normalized.startsWith(prefix));
  });
}

export interface SnapshotOptions {
  cwd: string;
  /** absolute path of the active task list, or null when the spec has none yet */
  tasksFile: string | null;
  /** orchestrator-owned paths excluded from the dirty computation (B2) */
  selfOwnedPaths?: string[];
  /** file whose mtime marks a handoff update; optional */
  handoffFile?: string | null;
  execFn?: ExecFn;
  readFileFn?: (path: string) => Promise<string>;
  statMtimeMsFn?: (path: string) => Promise<number>;
  timeoutMs?: number;
}

export interface FullSnapshot extends EvidenceSnapshot {
  git: EvidenceSnapshot['git'] & { branch: string; headSubject: string; dirtyPaths: string[] };
  tasks: EvidenceSnapshot['tasks'] & { nextTaskIds: string[] };
}

export async function snapshot(options: SnapshotOptions): Promise<FullSnapshot> {
  const exec = options.execFn ?? defaultExec;
  const read = options.readFileFn ?? ((p: string) => readFile(p, 'utf8'));
  const mtime =
    options.statMtimeMsFn ??
    (async (p: string) => {
      const { stat } = await import('node:fs/promises');
      return (await stat(p)).mtimeMs;
    });
  const timeoutMs = options.timeoutMs ?? 15_000;
  const git = (args: string[]) => exec('git', ['--no-optional-locks', ...args], { cwd: options.cwd, timeoutMs });

  const [head, branch, subject, porcelain] = await Promise.all([
    git(['rev-parse', 'HEAD']).then((s) => s.trim()),
    git(['branch', '--show-current']).then((s) => s.trim()),
    git(['log', '-1', '--format=%s']).then((s) => s.trim()),
    git(['status', '--porcelain']),
  ]);

  const rawStatus = parsePorcelain(porcelain);
  const dirtyPaths = filterSelfOwned(rawStatus.dirtyPaths, options.selfOwnedPaths ?? []);
  const status = { dirty: dirtyPaths.length > 0, dirtyPaths };

  let tasksText: string | null = null;
  if (options.tasksFile) {
    try {
      tasksText = await read(options.tasksFile);
    } catch {
      tasksText = null; // a spec without a task list yet is a fact, not an error
    }
  }
  const tasks = countTasks(tasksText);

  let handoffMtimeMs = 0;
  if (options.handoffFile) {
    try {
      handoffMtimeMs = await mtime(options.handoffFile);
    } catch {
      handoffMtimeMs = 0;
    }
  }

  return {
    git: { head, dirty: status.dirty, branch, headSubject: subject, dirtyPaths: status.dirtyPaths },
    tasks,
    handoff: { mtimeMs: handoffMtimeMs },
  };
}
