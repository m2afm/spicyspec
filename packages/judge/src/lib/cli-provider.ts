/**
 * A judge provider backed by a vendor CLI (`kimi -p`, `gemini -p`, a second `claude -p`…).
 *
 * Prototype B4 lives here as a rule: an npm extensionless shim is a SHELL script — spawned
 * from Node it fails ENOENT. The fix was to resolve the package's real entry script and
 * run it under `node` with array argv; `shell: true` was refused because it concatenates
 * argv and the prompt carries worker output (a `&&` inside a commit message would become a
 * command). So: `bin` must be a real executable (`.exe`, `.cmd` via cmd-file spawn support,
 * or `node` + script path in `args`), argv stays an array, and no shell is ever involved.
 */
import { execFile } from 'node:child_process';
import type { JudgeProvider } from './judge.js';

export interface CliProviderOptions {
  id: string;
  /** a REAL executable — node.exe + script args, or a native binary. Never a bare npm shim. */
  bin: string;
  /** argv BEFORE the prompt; the prompt is appended as the final array element */
  args?: string[];
  timeoutMs?: number;
  /** injected for tests */
  execFn?: (bin: string, args: string[], opts: { timeoutMs: number }) => Promise<string>;
}

const defaultExec = (bin: string, args: string[], opts: { timeoutMs: number }): Promise<string> =>
  new Promise((resolvePromise, rejectPromise) => {
    execFile(
      bin,
      args,
      { timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) rejectPromise(new Error(`${err.message}${stderr ? ` — ${String(stderr).slice(0, 200)}` : ''}`));
        else resolvePromise(String(stdout));
      },
    );
  });

export function cliJudgeProvider(options: CliProviderOptions): JudgeProvider {
  const exec = options.execFn ?? defaultExec;
  const timeoutMs = options.timeoutMs ?? 300_000; // judges read long evidence; 5 min floor
  return {
    id: options.id,
    invoke: (prompt: string) => exec(options.bin, [...(options.args ?? []), prompt], { timeoutMs }),
  };
}
