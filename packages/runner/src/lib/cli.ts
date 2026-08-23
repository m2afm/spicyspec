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
  command: 'init' | 'start' | 'service-xml' | 'help';
  configPath: string;
  problems: string[];
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const problems: string[] = [];
  const [raw, ...rest] = argv;
  const known = new Set(['init', 'start', 'service-xml', 'help']);
  const command = (known.has(raw ?? '') ? raw : raw === undefined ? 'help' : 'help') as CliArgs['command'];
  if (raw !== undefined && !known.has(raw)) problems.push(`unknown command "${raw}"`);

  let configPath = 'spicyspec.runner.json';
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--config') {
      const value = rest[i + 1];
      if (!value || value.startsWith('--')) problems.push('--config needs a path');
      else {
        configPath = value;
        i += 1;
      }
    } else {
      problems.push(`unknown argument "${rest[i]}"`);
    }
  }
  return { command, configPath, problems };
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
  }
}
