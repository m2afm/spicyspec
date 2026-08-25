import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './cli.js';
import {
  applyAutostart,
  autostartName,
  describeAutostart,
  launchdPlist,
  planAutostart,
  supervisorLogDir,
  systemdServiceUnit,
  systemdTimerUnit,
  windowsLauncherScript,
  type AutostartRequest,
} from './autostart.js';

const STATE_DIR = 'C:/XIII/share/Work/airvia/.spicyspec';
/** path.join is platform-flavoured; the expectations must be too, or this suite is Windows-only. */
const LAUNCHER = join(STATE_DIR, 'autostart', 'supervise.cmd');

const req = (over: Partial<AutostartRequest> = {}): AutostartRequest => ({
  projectName: 'Airvia',
  configPath: 'C:/XIII/share/Work/airvia/spicyspec.runner.json',
  cliPath: 'C:/tools/spicyspec/packages/runner/dist/bin.js',
  nodePath: 'C:/Program Files/nodejs/node.exe',
  intervalMinutes: 3,
  stateDir: STATE_DIR,
  homeDir: 'C:/Users/founder',
  platform: 'win32',
  ...over,
});

describe('autostartName', () => {
  it('is stable and strips separators — an uninstall matches the name literally', () => {
    expect(autostartName('Airvia')).toBe('Spicyspec-Airvia');
    // A backslash would nest the task in a Task Scheduler folder the delete never looks in.
    expect(autostartName('my\\proj')).toBe('Spicyspec-my-proj');
    expect(autostartName('a  b/c:d')).toBe('Spicyspec-a-b-c-d');
    expect(autostartName('***')).toBe('Spicyspec-project');
  });
});

describe('planAutostart — windows vectors', () => {
  it('registers a repeating sweep AND a boot/logon sweep, both forced so a re-run updates', () => {
    const plan = planAutostart(req());
    expect(plan.kind).toBe('schtasks');
    expect(plan.install.map((v) => v.args)).toEqual([
      [
        '/Create',
        '/TN',
        'Spicyspec-Airvia',
        '/TR',
        `"${LAUNCHER}"`,
        '/SC',
        'MINUTE',
        '/MO',
        '3',
        '/F',
      ],
      [
        '/Create',
        '/TN',
        'Spicyspec-Airvia-boot',
        '/TR',
        `"${LAUNCHER}"`,
        '/SC',
        'ONLOGON',
        '/F',
      ],
    ]);
  });

  it('/F is present on every create — without it a second install errors instead of updating', () => {
    for (const v of planAutostart(req()).install) expect(v.args).toContain('/F');
  });

  it('does not elevate by default, and says why in the notes', () => {
    const plan = planAutostart(req());
    expect(plan.needsElevation).toBe(false);
    expect(plan.install.flatMap((v) => [...v.args])).not.toContain('/RL');
    expect(plan.notes.join(' ')).toContain('--whether-logged-on');
  });

  it('--whether-logged-on takes SYSTEM + HIGHEST + ONSTART, and warns about the missing profile', () => {
    const plan = planAutostart(req({ whetherLoggedOn: true }));
    expect(plan.needsElevation).toBe(true);
    expect(plan.install[0].args).toEqual(expect.arrayContaining(['/RU', 'SYSTEM', '/RL', 'HIGHEST']));
    expect(plan.install[1].args).toEqual(expect.arrayContaining(['/SC', 'ONSTART']));
    expect(plan.notes.join(' ')).toContain('no user profile');
  });

  it('the interval reaches /MO, so --interval-minutes actually changes the schedule', () => {
    expect(planAutostart(req({ intervalMinutes: 10 })).install[0].args).toEqual(
      expect.arrayContaining(['/SC', 'MINUTE', '/MO', '10']),
    );
  });

  it('uninstall deletes BOTH tasks and tolerates their absence', () => {
    const plan = planAutostart(req());
    expect(plan.uninstall.map((v) => v.args)).toEqual([
      ['/Delete', '/TN', 'Spicyspec-Airvia', '/F'],
      ['/Delete', '/TN', 'Spicyspec-Airvia-boot', '/F'],
    ]);
    expect(plan.uninstall.every((v) => v.optional)).toBe(true);
  });

  it('the task points at a launcher script, not at a long node argv (schtasks truncates /TR)', () => {
    const plan = planAutostart(req());
    const tr = plan.install[0].args[plan.install[0].args.indexOf('/TR') + 1];
    expect(tr).toMatch(/supervise\.cmd"$/);
    expect(tr.length).toBeLessThan(261);
    const script = windowsLauncherScript(req());
    // --interval carries the scheduler's real cadence into the heartbeat, so the room does
    // not call a healthy supervisor missing (the beat's interval is the staleness clock).
    expect(script).toContain('supervise --once --interval 180 --config "C:/XIII/share/Work/airvia/spicyspec.runner.json"');
    // NO shell redirect. cmd's `>>` opens the log for the whole process, so any other holder
    // — an overlapping sweep, a tail — made the launcher exit 1 BEFORE node started: no
    // checks, no repairs, zero bytes written, no diagnosis. Reproduced by holding the file
    // open and running the launcher. The supervisor appends the log itself, per line.
    // The SWEEP's own line must carry no redirect — cmd's `>>` opens the file for the whole
    // process, so any other holder made the launcher exit 1 before node started, running no
    // checks and writing nothing. A failure breadcrumb to a SEPARATE file is allowed and
    // wanted: a scheduled task that fails silently is indistinguishable from one that never
    // ran, which cost an hour of blind diagnosis.
    const sweepLine = script.split(String.fromCharCode(13, 10)).find((l) => l.includes('supervise --once')) ?? '';
    expect(sweepLine).not.toContain('>');
    expect(script).toContain('launcher.log');
    expect(script).toMatch(/cd \/d "/);
    // .cmd files are parsed line-by-line by cmd.exe; a lone LF corrupts the last line.
    expect(script).toContain('\r\n');
  });

  it('verification lines name the exact tasks the founder can query', () => {
    expect(planAutostart(req()).verify).toEqual([
      'schtasks /Query /TN Spicyspec-Airvia /V /FO LIST',
      'schtasks /Query /TN Spicyspec-Airvia-boot /V /FO LIST',
    ]);
  });
});

describe('planAutostart — systemd user units', () => {
  const linux = req({ platform: 'linux', homeDir: '/home/founder', nodePath: '/usr/bin/node', cliPath: '/opt/s/bin.js' });

  it('installs a USER timer with no sudo anywhere in the vectors', () => {
    const plan = planAutostart(linux);
    expect(plan.kind).toBe('systemd-user');
    expect(plan.install.map((v) => v.args)).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'enable', '--now', 'spicyspec-airvia.timer'],
    ]);
    expect(plan.install.some((v) => v.bin === 'sudo')).toBe(false);
    expect(plan.needsElevation).toBe(false);
  });

  it('the timer fires after boot, on the interval, and catches up a missed tick', () => {
    const timer = systemdTimerUnit(linux);
    expect(timer).toContain('OnBootSec=1min');
    expect(timer).toContain('OnUnitActiveSec=3min');
    // A laptop asleep past a tick must sweep on wake instead of waiting out the interval.
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('Unit=spicyspec-airvia.service');
  });

  it('the service runs one sweep and appends to the same log the room links', () => {
    const service = systemdServiceUnit(linux);
    expect(service).toContain('Type=oneshot');
    expect(service).toContain('supervise --once --interval');
    expect(service).toContain('StandardOutput=append:');
    expect(service).toContain('StandardError=append:');
    expect(service).toContain('supervisor.log');
  });

  it('uninstall disables the timer and reloads, tolerating a timer that was never installed', () => {
    const plan = planAutostart(linux);
    expect(plan.uninstall[0].args).toEqual(['--user', 'disable', '--now', 'spicyspec-airvia.timer']);
    expect(plan.uninstall[0].optional).toBe(true);
  });
});

describe('planAutostart — launchd', () => {
  const mac = req({ platform: 'darwin', homeDir: '/Users/founder', nodePath: '/usr/local/bin/node', cliPath: '/opt/s/bin.js', uid: 501 });

  it('bootstraps a LaunchAgent in the user gui domain, unloading any previous version first', () => {
    const plan = planAutostart(mac);
    expect(plan.kind).toBe('launchd');
    expect(plan.install[0].args).toEqual(['bootout', 'gui/501/com.spicyspec.airvia']);
    // bootstrap refuses a label that is already loaded — the bootout IS the update path.
    expect(plan.install[0].optional).toBe(true);
    expect(plan.install[1].args[0]).toBe('bootstrap');
    expect(plan.install[1].args[1]).toBe('gui/501');
  });

  it('the plist reloads at login and repeats on the interval in seconds', () => {
    const plist = launchdPlist(mac);
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain('<key>StartInterval</key><integer>180</integer>');
    expect(plist).toContain('<string>supervise</string>');
    expect(plist).toContain('<string>--once</string>');
  });
});

describe('applyAutostart', () => {
  it('writes the plan files and the log dir before anything is registered', async () => {
    const { mkdtemp, readFile, stat } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'spicyspec-autostart-'));
    const plan = planAutostart(req({ stateDir: join(dir, '.spicyspec') }));
    const result = await applyAutostart(plan, 'install');
    expect(result.written).toContain(plan.files[0].path);
    expect(await readFile(plan.files[0].path, 'utf8')).toContain('supervise --once');
    // Appending to a log inside a missing directory fails silently at 3am.
    expect((await stat(supervisorLogDir(join(dir, '.spicyspec')))).isDirectory()).toBe(true);
  });

  it('a missing scheduler tool still writes the files and reports the gap, never silence', async () => {
    const plan = { ...planAutostart(req()), requiresTool: 'definitely-not-a-real-binary-xyz', files: [] };
    const result = await applyAutostart(plan, 'install');
    expect(result.toolMissing).toBe(true);
    const said = describeAutostart(plan, result, 'install').join('\n');
    expect(said).toContain('is not on PATH');
    expect(said).toContain('schtasks /Create');
  });
});

describe('parseCliArgs — install-autostart', () => {
  it('parses the command with its interval and boolean flags', () => {
    expect(parseCliArgs(['install-autostart', '--config', 'c.json', '--interval-minutes', '5'])).toMatchObject({
      command: 'install-autostart',
      configPath: 'c.json',
      intervalMinutes: 5,
      uninstall: false,
      whetherLoggedOn: false,
      problems: [],
    });
    expect(parseCliArgs(['install-autostart', '--uninstall'])).toMatchObject({ uninstall: true, problems: [] });
    expect(parseCliArgs(['install-autostart', '--whether-logged-on'])).toMatchObject({
      whetherLoggedOn: true,
      problems: [],
    });
  });

  it('the interval defaults to null so the command can own the 3-minute default', () => {
    expect(parseCliArgs(['install-autostart']).intervalMinutes).toBeNull();
  });

  it('rejects an interval schtasks would refuse rather than registering a task that never fires', () => {
    expect(parseCliArgs(['install-autostart', '--interval-minutes', '0']).problems).toHaveLength(1);
    expect(parseCliArgs(['install-autostart', '--interval-minutes', '2.5']).problems).toHaveLength(1);
    expect(parseCliArgs(['install-autostart', '--interval-minutes', '600000']).problems).toHaveLength(1);
  });

  it('a boolean flag never swallows the next argument', () => {
    expect(parseCliArgs(['install-autostart', '--uninstall', '--config', 'c.json'])).toMatchObject({
      uninstall: true,
      configPath: 'c.json',
      problems: [],
    });
  });
});
