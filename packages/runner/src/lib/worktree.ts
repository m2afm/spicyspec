/**
 * Worktree isolation — what makes N concurrent sessions on one repo SAFE.
 *
 * One git tree = one writer (prototype B12: two writers on one tree is the incident class
 * the whole lock architecture existed to prevent). Parallel mode gives each concurrent
 * spec its OWN checkout: `.spicyspec/worktrees/<id>` on branch `spec/<id>`. Sessions
 * commit to their spec branch; integration back to the main line is deliberate later work
 * (a merge is a decision, not a side effect).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type GitFn = (args: string[], cwd: string) => Promise<string>;

const defaultGit: GitFn = async (args, cwd) => {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 30_000, windowsHide: true });
  return stdout.trim();
};

export interface WorktreeResult {
  /** absolute path of the isolated checkout */
  path: string;
  branch: string;
  created: boolean;
}

/**
 * Ensure the spec's worktree exists and return it. Idempotent: an existing worktree is
 * reused (the spec keeps its branch state across runs); a missing one is created from the
 * repo's current HEAD.
 */
export async function ensureWorktree(
  repoCwd: string,
  specId: string,
  gitFn: GitFn = defaultGit,
): Promise<WorktreeResult> {
  const path = join(repoCwd, '.spicyspec', 'worktrees', specId);
  const branch = `spec/${specId}`;

  if (existsSync(join(path, '.git'))) {
    return { path, branch, created: false };
  }
  // -B: create or reset the branch at HEAD if it does not exist yet; an existing branch
  // with an existing worktree was handled above, so this only fires on first creation.
  await gitFn(['worktree', 'add', '-B', branch, path, 'HEAD'], repoCwd);
  return { path, branch, created: true };
}

/** List spec worktrees git knows about (for the dashboard and cleanup tooling). */
export async function listWorktrees(repoCwd: string, gitFn: GitFn = defaultGit): Promise<string[]> {
  const out = await gitFn(['worktree', 'list', '--porcelain'], repoCwd);
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree ') && l.includes('.spicyspec'))
    .map((l) => l.slice('worktree '.length));
}
