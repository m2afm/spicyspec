import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scaffoldProject } from './scaffold.js';

const freshDir = () => mkdtemp(join(tmpdir(), 'spicyspec-scaffold-'));

describe('scaffoldProject', () => {
  it('writes the five project files plus state dirs into an empty dir', async () => {
    const dir = await freshDir();
    const r = await scaffoldProject(dir, { projectName: 'demo' });
    expect(r.files).toEqual(['spicyspec.runner.json', 'spicyspec.catalog.json', 'README.md', '.gitignore', 'HANDOFF.md']);
    const config = JSON.parse(await readFile(join(dir, 'spicyspec.runner.json'), 'utf8'));
    expect(config.projectName).toBe('demo');
    expect(config.worker.protectedPaths).toEqual(['.spicyspec/']);
    const readme = await readFile(join(dir, 'README.md'), 'utf8');
    expect(readme).toContain('temporal server start-dev');
    expect(readme).toContain('spicyspec-runner seed');
  });

  it('the scaffolded config validates against the real runner schema', { timeout: 30_000 }, async () => {
    const dir = await freshDir();
    await scaffoldProject(dir, { projectName: 'demo' });
    const { parseRunnerConfig } = await import('@spicyspec/runner');
    const raw = JSON.parse(await readFile(join(dir, 'spicyspec.runner.json'), 'utf8'));
    expect(() => parseRunnerConfig(raw)).not.toThrow();
  });

  it('refuses a non-empty directory — a scaffolder that overwrites is a data-loss tool', async () => {
    const dir = await freshDir();
    await writeFile(join(dir, 'precious.txt'), 'do not touch');
    await expect(scaffoldProject(dir, { projectName: 'x' })).rejects.toThrow(/non-empty/);
    expect(await readFile(join(dir, 'precious.txt'), 'utf8')).toBe('do not touch');
  });

  it('an absent directory is created', async () => {
    const dir = join(await freshDir(), 'nested', 'project');
    const r = await scaffoldProject(dir, { projectName: 'nested' });
    expect(r.dir).toBe(dir);
  });
});
