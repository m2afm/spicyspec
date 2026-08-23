import { describe, expect, it } from 'vitest';
import { parseCliArgs, winswXml, STARTER_CONFIG } from './cli.js';
import { parseRunnerConfig } from './config.js';

describe('parseCliArgs', () => {
  it('parses command and --config', () => {
    expect(parseCliArgs(['start', '--config', 'x.json'])).toEqual({
      command: 'start',
      configPath: 'x.json',
      problems: [],
    });
  });

  it('defaults: no argv → help; no --config → conventional filename', () => {
    expect(parseCliArgs([]).command).toBe('help');
    expect(parseCliArgs(['start']).configPath).toBe('spicyspec.runner.json');
  });

  it('unknown commands and dangling flags are problems, never guesses', () => {
    expect(parseCliArgs(['strat']).problems).toHaveLength(1);
    expect(parseCliArgs(['start', '--config']).problems).toEqual(['--config needs a path']);
    expect(parseCliArgs(['start', '--verbose']).problems).toEqual(['unknown argument "--verbose"']);
  });
});

describe('STARTER_CONFIG', () => {
  it('the template we hand users actually validates', () => {
    expect(() => parseRunnerConfig(STARTER_CONFIG)).not.toThrow();
  });
});

describe('winswXml', () => {
  it('emits a service definition with escaped paths and restart-on-failure', () => {
    const xml = winswXml('C:\\a & b\\cfg.json', 'C:\\node\\node.exe', 'C:\\cli.js');
    expect(xml).toContain('<id>spicyspec-runner</id>');
    expect(xml).toContain('C:\\a &amp; b\\cfg.json');
    expect(xml).toContain('<onfailure action="restart"');
  });
});
