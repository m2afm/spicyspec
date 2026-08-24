/**
 * Detached spawn — the "outlive me" contract.
 *
 * The incident: `temporal server start-dev`, the runner and the dashboard were bare
 * background processes of one interactive shell. The shell went away and the loop was dead
 * for eight hours. Anything the supervisor starts must therefore survive the supervisor
 * itself, which means all three of:
 *   detached — its own process group on POSIX, its own console on Windows, so a Ctrl+C or
 *              a closed terminal does not take the child with it;
 *   stdio to FILES — an inherited pipe nobody drains fills its buffer and blocks the child
 *              forever, and the founder needs somewhere to read why a restart failed;
 *   unref'd — an attached child handle would keep `supervise --once` alive past its cycle.
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

export interface SpawnRequest {
  /** a REAL executable (node.exe, temporal.exe) — see the no-shell note below */
  command: string;
  args: readonly string[];
  cwd: string;
  /** directory for the child's log file; created if missing */
  logDir: string;
  /** log file base name — `<logName>.log`, appended to */
  logName: string;
}

export type SpawnDetachedFn = (request: SpawnRequest) => Promise<number | null>;

/** Returns the child pid, or null when the spawn produced no process. */
export const spawnDetached: SpawnDetachedFn = async (request) => {
  mkdirSync(request.logDir, { recursive: true });
  const fd = openSync(join(request.logDir, `${request.logName}.log`), 'a');
  try {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      detached: true,
      windowsHide: true,
      // No `shell: true`. A shell re-splits the argument vector, so every path with a space
      // in it breaks (this repo's own checkout has one), and on Windows it would leave a
      // cmd.exe standing between the supervisor and the process it supervises. The cost is
      // that `command` must be a real executable and never an npm/batch shim — the same
      // rule the judge config states for `bin` (prototype B4).
      stdio: ['ignore', fd, fd],
    });
    // A failed spawn reports asynchronously; an unhandled 'error' event on a ChildProcess
    // is thrown, which would kill the supervisor over a missing binary. The repair's own
    // verification (probe / heartbeat wait) is what decides whether the spawn worked.
    child.once('error', () => undefined);
    child.unref();
    return child.pid ?? null;
  } finally {
    // The child inherited its own duplicate of the descriptor.
    closeSync(fd);
  }
};
