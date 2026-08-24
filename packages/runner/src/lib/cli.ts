/**
 * The runner CLI — what a team member actually types.
 *
 *   spicyspec-runner init                      write a starter config beside you
 *   spicyspec-runner start  --config <path>    connect to Temporal and poll for work
 *   spicyspec-runner supervise --config <path>  heal the stack: temporal, worker, rotation
 *   spicyspec-runner service-xml --config <path>   emit WinSW XML for a Windows service
 *   spicyspec-runner install-autostart --config <path>   register the OS to sweep forever
 *
 * Argument parsing is a pure function so it is testable; the commands stay thin.
 * No CLI framework: three subcommands do not justify a dependency.
 */
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface CliArgs {
  command:
    | 'init'
    | 'start'
    | 'run'
    | 'halt'
    | 'service-xml'
    | 'install-autostart'
    | 'seed'
    | 'handoff'
    | 'dashboard'
    | 'supervise'
    | 'help';
  configPath: string;
  catalogPath: string;
  outPath: string | null;
  port: number | null;
  /** install-autostart: how often the OS re-runs the supervision sweep */
  intervalMinutes: number | null;
  /** supervise: seconds between cycles; null = whatever the config says */
  intervalSeconds: number | null;
  uninstall: boolean;
  whetherLoggedOn: boolean;
  /** supervise: one cycle, then exit — the exit code IS the health verdict */
  once: boolean;
  problems: string[];
}

const FLAGS: Record<string, keyof Pick<CliArgs, 'configPath' | 'catalogPath' | 'outPath'>> = {
  '--config': 'configPath',
  '--catalog': 'catalogPath',
  '--out': 'outPath',
};

/**
 * Numeric flags carry their own range check: a value the scheduler will reject must be a
 * usage error here, not a task that registers and never fires.
 */
const NUMBER_FLAGS: Record<
  string,
  { field: keyof Pick<CliArgs, 'port' | 'intervalMinutes' | 'intervalSeconds'>; min: number; max: number; problem: string }
> = {
  '--port': { field: 'port', min: 0, max: 65535, problem: '--port must be a valid port number' },
  '--interval-minutes': {
    // schtasks /MO caps at 599940 minutes; below 1 there is no schedule to register.
    field: 'intervalMinutes',
    min: 1,
    max: 599_940,
    problem: '--interval-minutes must be a whole number of minutes between 1 and 599940',
  },
  '--interval': {
    // A supervise cycle probes ports and may wait on a spawned dependency; below a second
    // there is no cycle, and above a day the loop could be dead most of a weekend.
    field: 'intervalSeconds',
    min: 1,
    max: 86_400,
    problem: '--interval must be a whole number of seconds between 1 and 86400',
  },
};

/** Presence-only flags — asking for a value would be a usage error, not a missing argument. */
const BOOLEAN_FLAGS: Record<string, keyof Pick<CliArgs, 'uninstall' | 'whetherLoggedOn' | 'once'>> = {
  '--uninstall': 'uninstall',
  '--whether-logged-on': 'whetherLoggedOn',
  '--once': 'once',
};

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const problems: string[] = [];
  const [raw, ...rest] = argv;
  const known = new Set([
    'init',
    'start',
    'run',
    'halt',
    'service-xml',
    'install-autostart',
    'seed',
    'handoff',
    'dashboard',
    'supervise',
    'help',
  ]);
  const command = (known.has(raw ?? '') ? raw : 'help') as CliArgs['command'];
  if (raw !== undefined && !known.has(raw)) problems.push(`unknown command "${raw}"`);

  const args: CliArgs = {
    command,
    configPath: 'spicyspec.runner.json',
    catalogPath: 'spicyspec.catalog.json',
    outPath: null,
    port: null,
    intervalMinutes: null,
    intervalSeconds: null,
    uninstall: false,
    whetherLoggedOn: false,
    once: false,
    problems,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const boolField = BOOLEAN_FLAGS[rest[i]];
    if (boolField) {
      args[boolField] = true;
      continue;
    }
    const numeric = NUMBER_FLAGS[rest[i]];
    if (numeric) {
      const value = rest[i + 1];
      if (!value || value.startsWith('--')) {
        problems.push(`${rest[i]} needs a value`);
        continue;
      }
      const n = Number(value);
      if (!Number.isInteger(n) || n < numeric.min || n > numeric.max) problems.push(numeric.problem);
      else args[numeric.field] = n;
      i += 1;
      continue;
    }
    const field = FLAGS[rest[i]];
    if (field) {
      const value = rest[i + 1];
      if (!value || value.startsWith('--')) problems.push(`${rest[i]} needs a value`);
      else {
        args[field] = value;
        i += 1;
      }
    } else {
      problems.push(`unknown argument "${rest[i]}"`);
    }
  }
  return args;
}

export const STARTER_CONFIG = {
  projectName: 'my-project',
  repoCwd: 'C:/path/to/the/repo',
  temporal: { address: 'localhost:7233', namespace: 'default', taskQueue: 'spicyspec' },
  storePath: '.spicyspec/runner.db',
  worker: {
    model: 'opus',
    effort: 'high',
    disallowedTools: ['Bash(git push --force*)', 'Bash(git reset --hard*)', 'Bash(rm -rf /*)'],
    protectedPaths: ['.spicyspec/'],
  },
  accounts: [{ id: 'primary', label: 'ambient login', env: {}, configDir: null }],
} as const;

/** WinSW service definition — the reboot-survival answer (prototype C1: pm2 startup is broken on Windows). */
export function winswXml(configPath: string, nodePath: string, cliPath: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    '<service>',
    '  <id>spicyspec-runner</id>',
    '  <name>Spicyspec Runner</name>',
    '  <description>Spicyspec delivery-platform runner — polls Temporal for work.</description>',
    `  <executable>${esc(nodePath)}</executable>`,
    `  <arguments>"${esc(cliPath)}" start --config "${esc(configPath)}"</arguments>`,
    '  <onfailure action="restart" delay="10 sec"/>',
    '  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>4</keepFiles></log>',
    '</service>',
  ].join('\n');
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const args = parseCliArgs(argv);
  if (args.problems.length) {
    for (const p of args.problems) console.error(`spicyspec-runner: ${p}`);
    console.error('usage: spicyspec-runner <init|start|run|halt|supervise|seed|handoff|dashboard|service-xml|install-autostart> [--config <path>] [--once] [--interval <seconds>]');
    return 2;
  }

  switch (args.command) {
    case 'help':
      console.log('usage: spicyspec-runner <init|start|run|halt|supervise|seed|handoff|dashboard|service-xml|install-autostart> [--config <path>] [--once] [--interval <seconds>]');
      return 0;

    case 'init': {
      const path = resolve(args.configPath);
      if (existsSync(path)) {
        console.error(`spicyspec-runner: refusing to overwrite ${path}`);
        return 1;
      }
      await writeFile(path, JSON.stringify(STARTER_CONFIG, null, 2) + '\n', 'utf8');
      console.log(`wrote ${path} — edit repoCwd and accounts, then: spicyspec-runner start --config ${args.configPath}`);
      return 0;
    }

    case 'halt': {
      // Graceful stop: cancel the rotation workflow. Temporal cancellation is cooperative —
      // the in-flight activity finishes, the workflow ends. The durable twin of the
      // prototype's STOP marker: no work lost.
      const { readFile } = await import('node:fs/promises');
      const { Client, Connection } = await import('@temporalio/client');
      const { parseRunnerConfig } = await import('./config.js');
      const { rotationWorkflowId } = await import('./rotation-id.js');
      const config = parseRunnerConfig(JSON.parse(await readFile(resolve(args.configPath), 'utf8')), dirname(resolve(args.configPath)));
      const connection = await Connection.connect({ address: config.temporal.address });
      try {
        const client = new Client({ connection, namespace: config.temporal.namespace });
        const workflowId = rotationWorkflowId(config.projectName);
        try {
          await client.workflow.getHandle(workflowId).cancel();
          console.log(`rotation ${workflowId} cancelled — the current run finishes, then the rotation ends`);
        } catch (err) {
          console.log(`nothing to halt (${String((err as Error).message).split('\n')[0]})`);
        }
        return 0;
      } finally {
        await connection.close();
      }
    }

    case 'service-xml': {
      const cliPath = resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
      console.log(winswXml(resolve(args.configPath), process.execPath, cliPath));
      console.error('# hosts the WORKER as a service; for whole-loop boot survival also run install-autostart');
      return 0;
    }

    case 'install-autostart': {
      // The reboot answer. `service-xml` hosts ONE process — the worker — as a Windows
      // service; this registers the OS to run the SUPERVISOR, which is what brings back
      // Temporal, the worker, the dashboard and a cancelled rotation. Boot survival for the
      // whole loop instead of for one child of it. Written after the night the founder left
      // it running and found it dead for ~8 hours with nothing on the machine trying to
      // restart anything.
      const { readFile } = await import('node:fs/promises');
      const { homedir } = await import('node:os');
      const { fileURLToPath } = await import('node:url');
      const { join: joinPath } = await import('node:path');
      const { parseRunnerConfig } = await import('./config.js');
      const { planAutostart, applyAutostart, describeAutostart } = await import('./autostart.js');
      const configPath = resolve(args.configPath);
      const config = parseRunnerConfig(JSON.parse(await readFile(configPath, 'utf8')), dirname(configPath));
      const plan = planAutostart({
        projectName: config.projectName,
        configPath,
        // bin.js, not this module: cli.js is not executable on its own.
        cliPath: joinPath(dirname(fileURLToPath(import.meta.url)), '..', 'bin.js'),
        nodePath: process.execPath,
        intervalMinutes: args.intervalMinutes ?? 3,
        stateDir: resolve(config.repoCwd, '.spicyspec'),
        whetherLoggedOn: args.whetherLoggedOn,
        homeDir: homedir(),
        uid: process.getuid?.(),
      });
      const mode = args.uninstall ? 'uninstall' : 'install';
      const result = await applyAutostart(plan, mode);
      for (const line of describeAutostart(plan, result, mode)) console.log(line);
      return result.failures.length ? 1 : 0;
    }

    case 'start': {
      const { startRunner } = await import('./main.js');
      await startRunner(resolve(args.configPath));
      return 0;
    }

    case 'run': {
      // Ignition: start (or join) the durable rotation. `start` only hosts the WORKER —
      // found by the first real ignition attempt: everything was up and nothing moved,
      // because no client had ever started queueRunWorkflow. The dispatch itself lives in
      // supervisor.ts, so a self-healed restart is exactly what a founder gets by hand.
      const { readFile } = await import('node:fs/promises');
      const { parseRunnerConfig } = await import('./config.js');
      const { dispatchRotation } = await import('./supervisor.js');
      const config = parseRunnerConfig(JSON.parse(await readFile(resolve(args.configPath), 'utf8')), dirname(resolve(args.configPath)));
      const result = await dispatchRotation(config);
      if (result.started) {
        console.log(`rotation started — workflowId ${result.workflowId}`);
        console.log('watch it: the dashboard, or the Temporal UI at http://localhost:8233');
      } else {
        console.log(`rotation already running — workflowId ${result.workflowId}`);
      }
      return 0;
    }

    case 'supervise': {
      // The night watch. Six checks, each repairing what it finds broken: Temporal, the
      // worker's heartbeat, the rotation workflow, a stale AGENT stop flag, orphaned account
      // leases, the dashboard. `--once` exits 0 healthy / 1 still-broken, which is what the
      // scheduled task install-autostart registers actually reports on.
      const { superviseCommand } = await import('./supervisor.js');
      return superviseCommand({
        configPath: resolve(args.configPath),
        once: args.once,
        intervalSeconds: args.intervalSeconds,
      });
    }

    case 'seed': {
      // Catalog in, pending queue out. Refuses to clobber an existing queue — a stray
      // re-seed that resets live statuses is the B21 defect class from the other side.
      const { readFile } = await import('node:fs/promises');
      const { openConfiguredStore } = await import('./open-store.js');
      const { parseRunnerConfig } = await import('./config.js');
      const config = parseRunnerConfig(JSON.parse(await readFile(resolve(args.configPath), 'utf8')), dirname(resolve(args.configPath)));
      const catalog = JSON.parse(await readFile(resolve(args.catalogPath), 'utf8')) as Array<{ id: string }>;
      if (!Array.isArray(catalog) || catalog.some((e) => !e?.id)) {
        console.error('spicyspec-runner: the catalog must be a JSON array of { id, ... } entries');
        return 1;
      }
      const store = await openConfiguredStore(config.storePath);
      try {
        if ((await store.loadQueue()).entries.length) {
          console.error('spicyspec-runner: the queue is not empty — refusing to re-seed over live state');
          return 1;
        }
        await store.saveQueue({ entries: catalog.map((e) => ({ id: String(e.id), status: 'pending' })) });
        console.log(`seeded ${catalog.length} pending entr${catalog.length === 1 ? 'y' : 'ies'} into ${config.storePath}`);
        return 0;
      } finally {
        await store.close();
      }
    }

    case 'handoff': {
      const { readFile, writeFile } = await import('node:fs/promises');
      const { openConfiguredStore } = await import('./open-store.js');
      const { closingGate } = await import('@spicyspec/core');
      const { renderHandoffPackage } = await import('@spicyspec/pipeline');
      const { snapshot } = await import('./git-snapshot.js');
      const { parseRunnerConfig } = await import('./config.js');
      const config = parseRunnerConfig(JSON.parse(await readFile(resolve(args.configPath), 'utf8')), dirname(resolve(args.configPath)));
      const store = await openConfiguredStore(config.storePath);
      try {
        const snap = await snapshot({ cwd: config.repoCwd, tasksFile: null, selfOwnedPaths: config.worker.protectedPaths });
        const gates = await store.listGates();
        let parked = '';
        try {
          parked = await readFile(resolve(config.repoCwd, config.parkedPath), 'utf8');
        } catch {
          /* nothing parked yet */
        }
        const md = renderHandoffPackage({
          projectName: config.projectName,
          generatedAt: new Date().toISOString(),
          frozen: { sha: snap.git.head, branch: snap.git.branch, subject: snap.git.headSubject },
          specs: (await store.loadQueue()).entries.map((e) => ({
            id: e.id,
            status: String(e.status),
            stage: e.stage ?? null,
            closingGate: closingGate(gates, e.id).state,
          })),
          runs: await store.listRuns(),
          parked,
          gatesJsonl: await store.exportGatesJsonl(),
        });
        const out = resolve(args.outPath ?? 'HANDOFF-PACKAGE.md');
        await writeFile(out, md, 'utf8');
        console.log(`wrote ${out}`);
        return 0;
      } finally {
        await store.close();
      }
    }

    case 'dashboard': {
      const { readFile } = await import('node:fs/promises');
      const { openConfiguredStore } = await import('./open-store.js');
      const { startControlRoom } = await import('@spicyspec/control-plane');
      const { parseRunnerConfig } = await import('./config.js');
      const { dirname, join: joinPath } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const config = parseRunnerConfig(JSON.parse(await readFile(resolve(args.configPath), 'utf8')), dirname(resolve(args.configPath)));
      const store = await openConfiguredStore(config.storePath);
      const cp = await startControlRoom({
        store,
        projectName: config.projectName,
        repoCwd: resolve(config.repoCwd),
        accountIds: config.accounts.map((a) => a.id),
        stateDir: resolve(config.repoCwd, '.spicyspec'),
        runnerBin: joinPath(dirname(fileURLToPath(import.meta.url)), '..', 'bin.js'),
        configPath: resolve(args.configPath),
        port: args.port ?? 4477,
      });
      console.log(`control room: http://127.0.0.1:${cp.port}  (Ctrl+C to stop)`);
      // hold open until signalled; the store closes on shutdown
      await new Promise<void>((r) => {
        const stop = () => {
          void cp.close().then(async () => {
            await store.close();
            r();
          });
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
      });
      return 0;
    }
  }
}
