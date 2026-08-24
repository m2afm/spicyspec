import { describe, expect, it } from 'vitest';
import { parseCliArgs, winswXml, STARTER_CONFIG } from './cli.js';
import { parseRunnerConfig } from './config.js';

describe('parseCliArgs', () => {
  it('parses command and --config', () => {
    expect(parseCliArgs(['start', '--config', 'x.json'])).toMatchObject({
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
    expect(parseCliArgs(['start', '--config']).problems).toEqual(['--config needs a value']);
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

describe('parseCliArgs — seed and handoff', () => {
  it('parses seed with catalog and handoff with out', () => {
    expect(parseCliArgs(['seed', '--config', 'c.json', '--catalog', 'cat.json'])).toMatchObject({
      command: 'seed',
      configPath: 'c.json',
      catalogPath: 'cat.json',
    });
    expect(parseCliArgs(['handoff', '--out', 'PKG.md'])).toMatchObject({ command: 'handoff', outPath: 'PKG.md' });
  });

  it('defaults hold for the new flags', () => {
    const a = parseCliArgs(['seed']);
    expect(a.catalogPath).toBe('spicyspec.catalog.json');
    expect(a.outPath).toBeNull();
  });
});

describe('parseCliArgs — dashboard', () => {
  it('parses dashboard with a port', () => {
    expect(parseCliArgs(['dashboard', '--port', '4477'])).toMatchObject({ command: 'dashboard', port: 4477 });
  });
  it('rejects a non-numeric or out-of-range port', () => {
    expect(parseCliArgs(['dashboard', '--port', 'abc']).problems).toContain('--port must be a valid port number');
    expect(parseCliArgs(['dashboard', '--port', '99999']).problems).toContain('--port must be a valid port number');
  });
  it('port defaults to null (the command supplies 4477)', () => {
    expect(parseCliArgs(['dashboard']).port).toBeNull();
  });
});
