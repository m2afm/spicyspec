/**
 * Runner entrypoint — the process a team member's machine keeps alive (as a WinSW/systemd
 * service). Connects OUT to Temporal and polls for work; nothing inbound (RFC-001 §2).
 *
 * Deliberately thin: everything testable lives in wiring.ts; this file only assembles and
 * runs. Replaces the prototype's 1,138-line driver.
 */
import { NativeConnection, Worker } from '@temporalio/worker';
import { createClaudeAdapter } from '@spicyspec/provider-claude';
import { openConfiguredStore } from './open-store.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseRunnerConfig } from './config.js';
import { registerRunner, startHeartbeat } from '@spicyspec/store';
import { clearLockView, writeLockView } from './compat-view.js';
import { createAllActivities, sweepOrphanedLeases } from './wiring.js';

export async function startRunner(configPath: string): Promise<void> {
  const config = parseRunnerConfig(JSON.parse(await readFile(configPath, 'utf8')));

  let secrets: Record<string, { env?: Record<string, string> }> = {};
  try {
    // Same split as the config schema documents: secrets live beside the config in a
    // gitignored file, keyed by account id. Absence is fine (ambient login).
    secrets = JSON.parse(await readFile(configPath.replace(/\.json$/, '.secrets.json'), 'utf8'));
  } catch {
    /* no secrets file — ambient credentials */
  }

  const store = await openConfiguredStore(config.storePath);
  const swept = await sweepOrphanedLeases(store);
  // eslint-disable-next-line no-console
  if (swept.length) console.log(`released ${swept.length} orphaned account lease(s): ${swept.join(', ')}`);
  const provider = createClaudeAdapter();
  const activities = createAllActivities({ config, store, provider, secrets });

  // Register in the shared store so the dashboard lists this runner; liveness is the
  // heartbeat timestamp, never the record's existence (prototype B17).
  const runnerId = `${hostname()}-${randomUUID().slice(0, 8)}`;
  const nowIso = () => new Date().toISOString();
  await registerRunner(store, {
    id: runnerId,
    host: hostname(),
    pid: process.pid,
    taskQueue: config.temporal.taskQueue,
    startedAt: nowIso(),
    heartbeatAt: nowIso(),
    accounts: config.accounts.map((a) => a.id),
  });
  const stopHeartbeat = startHeartbeat(store, runnerId, nowIso);

  // Loop Control Room view: the RUNNING chip reads a fresh RUN.lock heartbeat.
  let stopLockView: (() => void) | null = null;
  if (config.compatLoopDir) {
    const compat = { repoCwd: config.repoCwd, loopDir: config.compatLoopDir };
    const startedAt = nowIso();
    writeLockView(compat, startedAt);
    const lockTimer = setInterval(() => writeLockView(compat, startedAt), 15_000);
    lockTimer.unref?.();
    stopLockView = () => {
      clearInterval(lockTimer);
      clearLockView(compat);
    };
  }

  const connection = await NativeConnection.connect({ address: config.temporal.address });
  try {
    const worker = await Worker.create({
      connection,
      namespace: config.temporal.namespace,
      taskQueue: config.temporal.taskQueue,
      workflowsPath: fileURLToPath(new URL('../../../orchestrator/src/lib/workflows-entry.ts', import.meta.url)),
      activities,
    });
    // eslint-disable-next-line no-console
    console.log(
      `spicyspec runner up — project ${config.projectName}, queue ${config.temporal.taskQueue}, temporal ${config.temporal.address}`,
    );
    await worker.run();
  } finally {
    stopHeartbeat();
    stopLockView?.();
    await connection.close();
    await store.close();
  }
}
