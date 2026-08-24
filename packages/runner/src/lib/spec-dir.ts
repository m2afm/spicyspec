/**
 * Spec-directory resolution — the first real tenant (Airvia) names spec directories
 * `006-aircraft-subscription-autopause`, not `006`. A spec id resolves to the unique
 * directory whose name IS the id or starts with `<id>-`; ambiguity is an error, never a
 * guess (two dirs claiming one id is the queue-guard Q2 class on the filesystem).
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type ReadDirFn = (dir: string) => Promise<string[]>;

export async function findSpecDir(
  repoCwd: string,
  specsDir: string,
  specId: string,
  readDirFn: ReadDirFn = (d) => readdir(d),
): Promise<string | null> {
  let names: string[];
  try {
    names = await readDirFn(join(repoCwd, specsDir));
  } catch {
    return null; // no specs dir yet is a fact, not an error
  }
  const matches = names.filter((n) => n === specId || n.startsWith(`${specId}-`));
  if (matches.length > 1) {
    throw new Error(`spec id "${specId}" is ambiguous in ${specsDir}/: ${matches.join(', ')}`);
  }
  return matches.length ? join(specsDir, matches[0]) : null;
}
