/**
 * The runner CLI — what a team member actually types.
 *
 *   spicyspec-runner init                      write a starter config beside you
 *   spicyspec-runner start  --config <path>    connect to Temporal and poll for work
 *   spicyspec-runner service-xml --config <path>   emit WinSW XML for a Windows service
 *
 * Argument parsing is a pure function so it is testable; the commands stay thin.
 * No CLI framework: three subcommands do not justify a dependency.
 */
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface CliArgs {
  command: 'init' | 'start' | 'service-xml' | 'seed' | 'handoff' | 'dashboard' | 'help';
  configPath: string;
  catalogPath: string;
  outPath: string | null;
  port: number | null;
  problems: string[];
}

const FLAGS: Record<string, keyof Pick<CliArgs, 'configPath' | 'catalogPath' | 'outPath' | 'port'>> = {
  '--config': 'configPath',
  '--catalog': 'catalogPath',
  '--out': 'outPath',
  '--port': 'port',
};

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const problems: string[] = [];
  const [raw, ...rest] = argv;
  const known = new Set(['init', 'start', 'service-xml', 'seed', 'handoff', 'dashboard', 'help']);
  const command = (known.has(raw ?? '') ? raw : 'help') as CliArgs['command'];
  if (raw !== undefined && !known.has(raw)) problems.push(`unknown command "${raw}"`);

  const args: CliArgs = {
    command,
    configPath: 'spicyspec.runner.json',
    catalogPath: 'spicyspec.catalog.json',
    outPath: null,
    port: null,
    problems,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const field = FLAGS[rest[i]];
    if (field) {
      const value = rest[i + 1];
      if (!value || value.startsWith('--')) problems.push(`${rest[i]} needs a value`);
      else if (field === 'port') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0 || n > 65535) problems.push('--port must be a valid port number');
        else args.port = n;
        i += 1;
      } else {
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
    console.error('usage: spicyspec-runner <init|start|service-xml> [--config <path>]');
    return 2;
  }

  switch (args.command) {
    case 'help':
      console.log('usage: spicyspec-runner <init|start|service-xml> [--config <path>]');
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

    case 'service-xml': {
      const cliPath = resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
      console.log(winswXml(resolve(args.configPath), process.execPath, cliPath));
      return 0;
    }

    case 'start': {
      const { startRunner } = await import('./main.js');
      await startRunner(resolve(args.configPath));
      return 0;
    }

    case 'seed': {
      // Catalog in, pending queue out. Refuses to clobber an existing queue — a stray
      // re-seed that resets live statuses is the B21 defect class from the other side.
      const { readFile } = await import('node:fs/promises');
      const { openConfiguredStore } = await import('./open-store.js');
      const { parseRunnerConfig } = await import('./config.js');
      const config = parseRunnerConfig(JSON.parse(await readFile(resolve(args.configPath), 'utf8')));
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
      const config = parseRunnerConfig(JSON.parse(await readFile(resolve(args.configPath), 'utf8')));
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
      const { startControlPlane } = await import('@spicyspec/control-plane');
      const { parseRunnerConfig } = await import('./config.js');
      const config = parseRunnerConfig(JSON.parse(await readFile(resolve(args.configPath), 'utf8')));
      const store = await openConfiguredStore(config.storePath);
      const cp = await startControlPlane({ store, projectName: config.projectName, port: args.port ?? 4477 });
      console.log(`dashboard: http://127.0.0.1:${cp.port}  (Ctrl+C to stop)`);
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
