/**
 * LIVE smoke — the first end-to-end truth run:
 *
 *   real Temporal dev server (auto-downloaded by @temporalio/testing createLocal)
 *   → specRunWorkflow → runWorkerSession activity
 *   → REAL Claude session (Agent SDK, ambient login, haiku, tiny task)
 *   → classify → pool + ledger settled in SQLite
 *
 * Costs a few cents of quota. Scratch repo lives in the OS temp dir and is disposable.
 *
 * Run from packages/runner:  node tools/live-smoke.mjs
 */
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRunnerActivities, parseRunnerConfig } from '@spicyspec/runner';
import { createClaudeAdapter } from '@spicyspec/provider-claude';
import { openStore } from '@spicyspec/store';

const log = (m) => console.log(`[smoke ${new Date().toISOString().slice(11, 19)}] ${m}`);

/* ------------------------------------------------------------------ scratch repo ---- */
const scratch = mkdtempSync(join(tmpdir(), 'spicyspec-smoke-'));
const git = (...args) => execFileSync('git', args, { cwd: scratch, windowsHide: true, encoding: 'utf8' });

mkdirSync(join(scratch, 'specs', '001'), { recursive: true });
mkdirSync(join(scratch, '.spicyspec'), { recursive: true });
writeFileSync(
  join(scratch, 'specs', '001', 'tasks.md'),
  [
    '# Spec 001 — smoke',
    '',
    '- [ ] **T001** Create `hello.txt` at the repo root containing exactly `hello from spicyspec`,',
    '  then mark this task done (change `[ ]` to `[x]` on this line) in `specs/001/tasks.md`,',
    '  then commit ALL changes with the message `feat(001): T001 hello`.',
    '',
  ].join('\n'),
);
writeFileSync(join(scratch, 'HANDOFF.md'), '# HANDOFF\n\nFresh scratch repo. Spec 001 has one open task. No traps.\n');
git('init', '-q', '-b', 'main');
git('add', '-A');
git('-c', 'user.email=smoke@spicyspec.local', '-c', 'user.name=smoke', 'commit', '-q', '-m', 'chore: scratch repo');
log(`scratch repo at ${scratch}, HEAD ${git('rev-parse', '--short', 'HEAD').trim()}`);

/* ----------------------------------------------------------------------- wiring ---- */
const config = parseRunnerConfig({
  projectName: 'Smoke',
  repoCwd: scratch,
  accounts: [{ id: 'primary' }], // ambient login
  worker: {
    model: 'haiku',
    disallowedTools: ['Bash(git push*)'],
    protectedPaths: ['.spicyspec/'],
  },
  storePath: join(scratch, '.spicyspec', 'runner.db'),
});

const store = openStore(config.storePath);
const activities = createRunnerActivities({ config, store, provider: createClaudeAdapter() });

/* --------------------------------------------------------------------- temporal ---- */
log('starting local Temporal dev server (first run downloads the binary)…');
const env = await TestWorkflowEnvironment.createLocal();
log('temporal up');

const workflowsPath = fileURLToPath(
  new URL('../../orchestrator/src/lib/workflows-entry.ts', import.meta.url),
);

try {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: 'smoke',
    workflowsPath,
    activities,
  });

  log('worker up — starting specRunWorkflow (one run, real Claude session)…');
  const state = await worker.runUntil(
    env.client.workflow.execute('specRunWorkflow', {
      taskQueue: 'smoke',
      workflowId: `smoke-${Date.now()}`,
      args: [{ specId: '001', maxRuns: 2, maxConsecutiveStalls: 2 }],
    }),
  );

  /* ---------------------------------------------------------------- the verdict ---- */
  log(`workflow returned: ${JSON.stringify(state)}`);

  const runs = await store.listRuns();
  log(`ledger rows: ${JSON.stringify(runs)}`);
  const pool = await store.loadPoolState();
  log(`pool state: ${JSON.stringify(pool)}`);

  const hello = join(scratch, 'hello.txt');
  const helloExists = existsSync(hello);
  const helloContent = helloExists ? readFileSync(hello, 'utf8').trim() : null;
  // search the whole log — a worker legitimately commits a handoff update on top
  const subjects = git('log', '--format=%s').trim().split('\n');
  const porcelain = git('status', '--porcelain');
  // the runner's own state is self-owned, never "dirty" (B2)
  const foreignDirty = porcelain.split('\n').filter((l) => l.length > 3 && !l.slice(3).startsWith('.spicyspec/'));

  log(`hello.txt: ${helloExists ? JSON.stringify(helloContent) : 'MISSING'}`);
  log(`scratch subjects: ${JSON.stringify(subjects)}; foreign-dirty ${foreignDirty.length}`);

  const checks = [
    ['workflow reached a terminal state', ['complete', 'parked', 'exhausted'].includes(state.status)],
    ['runs recorded within maxRuns', runs.length >= 1 && runs.length <= 2],
    ['run cost is known and non-zero (a REAL session ran)', runs[0]?.costUsd > 0],
    ['pool recorded the use', (pool['primary']?.uses ?? 0) >= 1],
    ['worker created hello.txt with the exact content', helloContent === 'hello from spicyspec'],
    ['worker committed with the asked message', subjects.includes('feat(001): T001 hello')],
    ['B2 holds: nothing foreign left dirty', foreignDirty.length === 0],
    ['workflow classified spec-complete', state.status === 'complete'],
  ];
  let pass = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (ok) pass += 1;
  }
  console.log(`\n${pass}/${checks.length} checks — exit ${runs[0]?.exit ?? '?'} — scratch kept at ${scratch}`);
  process.exitCode = pass === checks.length ? 0 : 1;
} finally {
  await env.teardown();
  await store.close();
}
