/**
 * One branch per spec, enforced at the start of every run.
 *
 * The convention held for the first four specs — `001-auth-identity-verification`,
 * `002-…`, `003-…`, `004-…` — and then quietly stopped: specs 005, 006, 007 and 008 all
 * committed onto the 004 branch, so four features of history carry a fifth feature's name,
 * `git log <branch>` answers for the wrong feature, and no spec can be reviewed or reverted
 * on its own. Nothing enforced it, so it drifted.
 *
 * Single-spec mode works the repo itself, so the branch IS the isolation. Parallel mode uses
 * worktrees on `spec/<id>` and this is skipped.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const firstLine = (s: string): string => s.split(String.fromCharCode(10))[0];

export interface SpecBranchResult {
  /** the branch the run will work on */
  branch: string;
  /** 'already' | 'switched' | 'created' | 'refused' */
  action: 'already' | 'switched' | 'created' | 'refused';
  detail: string;
}

export type GitFn = (cwd: string, args: readonly string[]) => Promise<string>;

const realGit: GitFn = async (cwd, args) => {
  const { stdout } = await execFileAsync('git', ['--no-optional-locks', ...args], {
    cwd,
    timeout: 20_000,
    windowsHide: true,
  });
  return stdout.trim();
};

/**
 * The branch name for a spec, taken from its directory so the two can never disagree:
 * `specs/008-pilot-listing-cost-share-gate` -> `008-pilot-listing-cost-share-gate`.
 */
export function specBranchName(specDir: string | null, specId: string): string {
  if (!specDir) return specId;
  const leaf = specDir.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? specId;
  return leaf;
}

/**
 * Put the repo on this spec's branch, or refuse and say why.
 *
 * REFUSES rather than forces when the tree is dirty: a checkout carries uncommitted work
 * across, and a half-finished unit from another spec landing in this spec's history is worse
 * than a run that says it could not start cleanly.
 */
export async function ensureSpecBranch(
  repoCwd: string,
  branch: string,
  gitFn: GitFn = realGit,
): Promise<SpecBranchResult> {
  const current = await gitFn(repoCwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
  if (current === branch) return { branch, action: 'already', detail: `already on ${branch}` };

  const porcelain = await gitFn(repoCwd, ['status', '--porcelain']).catch(() => '');
  const tracked = porcelain
    .split('\n')
    .filter((l) => l.trim().length > 0 && !l.startsWith('??'));
  if (tracked.length) {
    return {
      branch: current || branch,
      action: 'refused',
      detail:
        `${tracked.length} tracked file(s) are modified, so switching to ${branch} would carry ` +
        `another spec's half-finished work into its history — reconcile the tree first`,
    };
  }

  const existing = await gitFn(repoCwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).catch(() => '');
  // A git failure — no repository, a lock, a hook refusing — must never kill the run. The
  // branch is bookkeeping; the work is the point. Report it and let the run proceed.
  try {
    if (existing) {
      await gitFn(repoCwd, ['checkout', branch]);
      return { branch, action: 'switched', detail: `switched from ${current || 'detached'} to ${branch}` };
    }
    await gitFn(repoCwd, ['checkout', '-b', branch]);
    return { branch, action: 'created', detail: `created ${branch} from ${current || 'HEAD'}` };
  } catch (err) {
    return {
      branch: current || branch,
      action: 'refused',
      detail: `could not put the repo on ${branch}: ${firstLine(String((err as Error).message))}`,
    };
  }
}
