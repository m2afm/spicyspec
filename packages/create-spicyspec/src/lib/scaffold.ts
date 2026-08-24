/**
 * `npx create-spicyspec my-project` — the front door.
 *
 * Scaffolds a project directory a team member can run in five commands. Writes only into
 * an empty (or absent) directory — a scaffolder that overwrites is a data-loss tool.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ScaffoldOptions {
  projectName: string;
}

export interface ScaffoldResult {
  dir: string;
  files: string[];
}

const runnerConfig = (projectName: string) =>
  JSON.stringify(
    {
      projectName,
      repoCwd: '.',
      temporal: { address: 'localhost:7233', namespace: 'default', taskQueue: 'spicyspec' },
      storePath: '.spicyspec/runner.db',
      worker: {
        model: 'opus',
        effort: 'high',
        disallowedTools: ['Bash(git push --force*)', 'Bash(git reset --hard*)', 'Bash(rm -rf /*)'],
        protectedPaths: ['.spicyspec/'],
      },
      accounts: [{ id: 'primary', label: 'ambient login', env: {}, configDir: null }],
      judges: [],
      maxAwaitingReview: 3,
    },
    null,
    2,
  ) + '\n';

const sampleCatalog =
  JSON.stringify(
    [
      { id: '001', title: 'First feature — replace me' },
      { id: '002', title: 'Second feature — replace me' },
    ],
    null,
    2,
  ) + '\n';

const readme = (projectName: string) => `# ${projectName}

Delivery run orchestrated by [Spicyspec](https://github.com/spicyspec) — spec in, gated
autonomous execution, dev-ready app + handoff package out.

## Five commands to a running loop

\`\`\`bash
# 1. one-time: the Temporal dev server (single binary, no Docker)
temporal server start-dev --db-filename .spicyspec/temporal.db

# 2. put your feature catalog into the queue
spicyspec-runner seed --config spicyspec.runner.json --catalog spicyspec.catalog.json

# 3. start the runner (brings your own AI accounts; polls for work)
spicyspec-runner start --config spicyspec.runner.json

# 4. open the managers dashboard
spicyspec-runner dashboard --config spicyspec.runner.json --port 4477

# 5. when a spec waits on you: walk the journey BY CLICKING, then Approve on the dashboard
\`\`\`

## The rules this project runs under

- Nothing is done until a human walked the review journey and approved it.
- Every quality claim is paired with the executed command that proves it.
- Gate verdicts are machine-readable records; absence means UNKNOWN, never a pass.
- \`.spicyspec/\` is orchestrator state — workers are DENIED writes there at the runtime.

Generate the auditable handoff at any time:

\`\`\`bash
spicyspec-runner handoff --config spicyspec.runner.json --out HANDOFF-PACKAGE.md
\`\`\`
`;

const gitignore = `# spicyspec orchestrator state (runner db, temporal dev db)
.spicyspec/
node_modules/
`;

export async function scaffoldProject(targetDir: string, options: ScaffoldOptions): Promise<ScaffoldResult> {
  // Never write into a directory that has anything in it.
  let existing: string[] = [];
  try {
    existing = await readdir(targetDir);
  } catch {
    /* absent is fine */
  }
  if (existing.length) {
    throw new Error(`refusing to scaffold into non-empty directory: ${targetDir}`);
  }

  await mkdir(join(targetDir, '.spicyspec'), { recursive: true });
  await mkdir(join(targetDir, 'specs'), { recursive: true });

  const files: Array<[string, string]> = [
    ['spicyspec.runner.json', runnerConfig(options.projectName)],
    ['spicyspec.catalog.json', sampleCatalog],
    ['README.md', readme(options.projectName)],
    ['.gitignore', gitignore],
    ['HANDOFF.md', `# HANDOFF\n\nFresh ${options.projectName} project. Nothing built yet.\n`],
  ];
  for (const [name, content] of files) {
    await writeFile(join(targetDir, name), content, 'utf8');
  }
  return { dir: targetDir, files: files.map(([name]) => name) };
}
