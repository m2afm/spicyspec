/**
 * LIVE rotation smoke — the multi-stage truth run:
 *
 *   queueRunWorkflow → guard → open spec 001 at stage 1
 *     → specRunWorkflow child (REAL Claude session) writes the spec artifacts
 *     → settle advances the stage → child per stage → past the last stage
 *     → awaiting-review → rotation drains.
 *
 * Three real haiku sessions (~$0.4). Exercises live: stage progression, worker-declared
 * RUN_STATUS spec-complete (clean-tree guard), the parked-file exception inside a
 * protected path, and B2 self-owned filtering.
 *
 * Run from packages/runner:  node tools/live-rotation-smoke.mjs
 */
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePipeline } from '@spicyspec/pipeline';
import { createClaudeAdapter } from '@spicyspec/provider-claude';
import { createQueueActivities, createRunnerActivities, parseRunnerConfig } from '@spicyspec/runner';
import { openStore } from '@spicyspec/store';

const log = (m) => console.log(`[rotation ${new Date().toISOString().slice(11, 19)}] ${m}`);

/* --------------------------------------------------------------------- pipeline ---- */
const pipeline = parsePipeline({
  id: 'smoke-short',
  name: 'Three-stage smoke',
  stages: [
    {
      id: 'specify',
      title: 'Specify',
      instructions: [
        'Create `specs/001/spec.md` containing a title line and one requirement: FR-001 —',
        '`hello.txt` at the repo root must contain exactly `hello from spicyspec`.',
        'Then create `specs/001/tasks.md` containing EXACTLY one task line:',
        '`- [ ] **T001** Create hello.txt at the repo root containing exactly hello from spicyspec, mark this task done in specs/001/tasks.md, and commit everything with message feat(001): T001 hello`.',
        'Commit both files with the message `docs(001): spec + tasks`. Do nothing else.',
        'End with `RUN_STATUS: spec-complete` on its own line.',
      ].join(' '),
    },
    {
      id: 'execute',
      title: 'Execute',
      instructions:
        'Work the open task in specs/001/tasks.md exactly as written, commit as it instructs, and stop.',
    },
    {
      id: 'handoff',
      title: 'Handoff',
      instructions: [
        'Append a human review journey to `.spicyspec/PARKED.md` (that exact file is writable):',
        'a numbered 2-step click path — 1. open hello.txt, 2. confirm it reads `hello from spicyspec`.',
        'Do NOT commit anything. End with `RUN_STATUS: spec-complete` on its own line.',
      ].join(' '),
    },
  ],
});

/* ------------------------------------------------------------------ scratch repo ---- */
const scratch = mkdtempSync(join(tmpdir(), 'spicyspec-rotation-'));
const git = (...args) => execFileSync('git', args, { cwd: scratch, windowsHide: true, encoding: 'utf8' });

mkdirSync(join(scratch, '.spicyspec'), { recursive: true });
writeFileSync(join(scratch, 'HANDOFF.md'), '# HANDOFF\n\nFresh scratch repo. Spec 001 starts at stage specify.\n');
git('init', '-q', '-b', 'main');
git('add', '-A');
git('-c', 'user.email=smoke@spicyspec.local', '-c', 'user.name=smoke', 'commit', '-q', '-m', 'chore: scratch repo');
log(`scratch at ${scratch}`);

/* ----------------------------------------------------------------------- wiring ---- */
const config = parseRunnerConfig({
  projectName: 'Rotation',
  repoCwd: scratch,
  accounts: [{ id: 'primary' }],
  worker: { model: 'haiku', disallowedTools: ['Bash(git push*)'], protectedPaths: ['.spicyspec/'] },
  storePath: join(scratch, '.spicyspec', 'runner.db'),
  parkedPath: '.spicyspec/PARKED.md',
});

const store = openStore(config.storePath);
store.saveQueue({ entries: [{ id: '001', status: 'pending' }] });

const runnerDeps = { config, store, provider: createClaudeAdapter(), pipeline };
const activities = {
  ...createRunnerActivities(runnerDeps),
  ...createQueueActivities({ runner: runnerDeps, pipeline }),
};

/* --------------------------------------------------------------------- temporal ---- */
log('starting local Temporal dev server…');
const env = await TestWorkflowEnvironment.createLocal();
log('temporal up');

const workflowsPath = fileURLToPath(new URL('../../orchestrator/src/lib/workflows-entry.ts', import.meta.url));

try {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: 'rotation-smoke',
    workflowsPath,
    activities,
  });

  log('worker up — starting queueRunWorkflow (three stages, three real sessions)…');
  const state = await worker.runUntil(
    env.client.workflow.execute('queueRunWorkflow', {
      taskQueue: 'rotation-smoke',
      workflowId: `rotation-${Date.now()}`,
      args: [{ maxRunsPerSpec: 2, maxConsecutiveStalls: 2, maxSpecRuns: 6 }],
    }),
  );

  /* ---------------------------------------------------------------- the verdict ---- */
  log(`rotation returned: ${JSON.stringify(state)}`);
  const queue = store.loadQueue();
  const runs = store.listRuns();
  log(`queue: ${JSON.stringify(queue.entries)}`);
  log(`runs: ${JSON.stringify(runs.map((r) => ({ tick: r.tick, exit: r.exit, cost: r.costUsd?.toFixed(3) })))}`);

  const spec = join(scratch, 'specs', '001', 'spec.md');
  const tasks = join(scratch, 'specs', '001', 'tasks.md');
  const hello = join(scratch, 'hello.txt');
  const parked = join(scratch, '.spicyspec', 'PARKED.md');
  const tasksText = existsSync(tasks) ? readFileSync(tasks, 'utf8') : '';
  const helloContent = existsSync(hello) ? readFileSync(hello, 'utf8').trim() : null;
  const parkedText = existsSync(parked) ? readFileSync(parked, 'utf8') : '';
  const subjects = git('log', '--format=%s').trim().split('\n');

  const checks = [
    ['rotation drained', state.status === 'drained'],
    ['walked the three stages in order', JSON.stringify(state.settled.map((s) => s.stage)) === JSON.stringify(['specify', 'execute', 'handoff'])],
    ['every stage child completed', state.settled.every((s) => s.runStatus === 'complete')],
    ['queue entry ended awaiting-review (the platform never marks its own work done)', queue.entries[0]?.status === 'awaiting-review'],
    ['spec.md written by the specify stage', existsSync(spec)],
    ['task closed by the execute stage', /\[x\] \*\*T001\*\*/i.test(tasksText)],
    ['hello.txt exact', helloContent === 'hello from spicyspec'],
    ['parked-file exception honored LIVE (journey appended inside protected dir)', /1\./.test(parkedText) && /hello/i.test(parkedText)],
    ['both commits present', subjects.some((s) => s.startsWith('docs(001)')) && subjects.includes('feat(001): T001 hello')],
    ['three real sessions recorded with known cost', runs.length >= 3 && runs.every((r) => r.costUsd > 0)],
  ];
  let pass = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (ok) pass += 1;
  }
  const total = runs.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  console.log(`\n${pass}/${checks.length} checks — total cost $${total.toFixed(2)} — scratch kept at ${scratch}`);
  process.exitCode = pass === checks.length ? 0 : 1;
} finally {
  await env.teardown();
  store.close();
}
