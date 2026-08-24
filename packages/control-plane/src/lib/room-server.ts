/**
 * The Loop Control Room — spicyspec edition. THE product dashboard.
 *
 * The frontend (room/app.html + React bundles) is the founder tooling proven on the
 * prototype, vendored byte-identical. This server implements the API it speaks, over the
 * spicyspec store: catalog and totals from the queue/ledger, owed-by-you checklists built
 * from each spec's own acceptance scenarios (vendored founder-brief), check state in the
 * store's directory, sign-off gated on the checklist and recorded BOTH as the git tag the
 * guards read AND as the review decision the parked workflow collects.
 *
 * Same security model as the original, hardened after prototype B32: host allowlist,
 * sec-fetch-site rejection, and a per-start token injected into the page — every
 * state-changing POST requires it.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Store } from '@spicyspec/store';

const execFileAsync = promisify(execFile);
const ROOM = fileURLToPath(new URL('../../room/', import.meta.url));

/* ------------------------------------------------------- vendored prototype modules ---- */
/* Plain-JS modules shipped in room/ — imported dynamically, typed at the boundary. */
interface BriefModule {
  specDirFor(root: string, id: string): string | null;
  buildBrief(root: string, args: { kind: string; id: string; parkedKey: string | null }): Record<string, unknown>;
  listOwed(root: string, queueEntries: unknown[]): Array<Record<string, unknown>>;
}
interface ChecksModule {
  loadChecks(path: string): Record<string, unknown>;
  setCheck(path: string, itemKey: string, checkKey: string, value: boolean): Record<string, unknown>;
  setNote(path: string, itemKey: string, checkKey: string, text: string): Record<string, unknown>;
  markSignedOff(path: string, itemKey: string): void;
  progressFor(state: Record<string, unknown>, itemKey: string, brief: Record<string, unknown>): {
    complete: boolean;
    blockingDone: number;
    blockingTotal: number;
    remaining: Array<{ section: string; title: string }>;
    startedAt: string | null;
    signedOffAt: string | null;
  };
}

interface AgentsModule {
  ROOT_ID: string;
  createRegistry(meta?: Record<string, unknown>): Record<string, unknown>;
  ingest(reg: Record<string, unknown>, event: unknown): Iterable<string>;
  snapshot(reg: Record<string, unknown>, opts?: { detail?: boolean }): { agents: Array<Record<string, unknown>>; counts: Record<string, number> };
}

async function vendored(): Promise<{ brief: BriefModule; checks: ChecksModule; agents: AgentsModule }> {
  const brief = (await import(new URL('founder-brief.mjs', new URL('../../room/', import.meta.url)).href)) as unknown as BriefModule;
  const checks = (await import(new URL('founder-checks.mjs', new URL('../../room/', import.meta.url)).href)) as unknown as ChecksModule;
  const agents = (await import(new URL('agents.mjs', new URL('../../room/', import.meta.url)).href)) as unknown as AgentsModule;
  return { brief, checks, agents };
}

/* ---------------------------------------------------------------------- options ---- */

export interface RoomOptions {
  store: Store;
  projectName: string;
  repoCwd: string;
  /** configured account ids — the panel shows THESE from the start; state overlays them */
  accountIds?: string[];
  /** where founder-checks.json lives (orchestrator state) */
  stateDir: string;
  /** the runner CLI entry, for the START/STOP actions */
  runnerBin: string;
  configPath: string;
  host?: string;
  port?: number;
}

export interface RunningRoom {
  server: Server;
  port: number;
  close(): Promise<void>;
}

const STATUS_TO_ROOM: Record<string, string> = {
  'awaiting-review': 'awaiting-founder',
  done: 'done',
  parked: 'parked',
  pending: 'pending',
  active: 'active',
};

/* ------------------------------------------------------------------- state build ---- */

async function git(repoCwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['--no-optional-locks', ...args], {
      cwd: repoCwd,
      timeout: 15_000,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

function specProgress(repoCwd: string, dir: string | null): { done: number; open: number; held: number; total: number } | null {
  if (!dir) return null;
  const path = join(repoCwd, dir, 'tasks.md');
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const done = (text.match(/^\s*[-*] \[[xX]\] \*\*T\d+\*\*/gm) ?? []).length;
  const open = (text.match(/^\s*[-*] \[ \] \*\*T\d+\*\*/gm) ?? []).length;
  return { done, open, held: 0, total: done + open };
}

async function buildRoomState(options: RoomOptions, brief: BriefModule): Promise<Record<string, unknown>> {
  const { store, repoCwd } = options;
  const queue = await store.loadQueue();
  const runs = await store.listRuns();
  const pool = await store.loadPoolState();
  const now = Date.now();

  const runnersRaw = await store.listKv('runner:');
  const runners = runnersRaw.map((r) => JSON.parse(r.value) as { pid: number; heartbeatAt: string });
  const liveRunner = runners.find((r) => now - Date.parse(r.heartbeatAt) < 90_000) ?? null;

  const entries = queue.entries.map((e) => {
    const dir = brief.specDirFor(repoCwd, e.id);
    return {
      id: e.id,
      slug: dir ? dir.replace(/\\/g, '/').split('/').pop()?.replace(/^\d+-/, '') : null,
      dir,
      status: STATUS_TO_ROOM[String(e.status)] ?? String(e.status),
      stage: e.stage ?? null,
      progress: specProgress(repoCwd, dir),
    };
  });
  const active = entries.find((e) => e.status === 'active') ?? null;

  const sum = runs.reduce(
    (a, t) => ({
      cost: a.cost + (Number(t.costUsd) || 0),
      minutes: a.minutes + (Number(t.durationMinutes) || 0),
      closed: a.closed + (Number(t.tasksClosed) || 0),
    }),
    { cost: 0, minutes: 0, closed: 0 },
  );

  const [head, subject, branch, porcelain] = await Promise.all([
    git(repoCwd, ['rev-parse', '--short', 'HEAD']),
    git(repoCwd, ['log', '-1', '--format=%s']),
    git(repoCwd, ['branch', '--show-current']),
    git(repoCwd, ['status', '--porcelain']),
  ]);
  const dirtyPaths = porcelain.split('\n').filter((l) => l.length > 3).map((l) => l.slice(3));

  return {
    at: new Date().toISOString(),
    running: Boolean(liveRunner),
    stopArmed: false,
    killArmed: false,
    driver: liveRunner
      ? { pid: liveRunner.pid, workerPid: liveRunner.pid, code: 'spicyspec', config: options.projectName, startedAt: null, heartbeat: liveRunner.heartbeatAt }
      : null,
    git: { head, subject, branch, dirty: dirtyPaths.length, dirtyPaths: dirtyPaths.slice(0, 8) },
    catalog: {
      total: entries.length,
      signedOff: entries.filter((e) => e.status === 'done').length,
      awaitingFounder: entries.filter((e) => e.status === 'awaiting-founder').map((e) => e.id),
      parked: entries.filter((e) => e.status === 'parked').map((e) => e.id),
      pending: entries.filter((e) => e.status === 'pending').length,
      builtFraction: entries
        .filter((e) => e.status !== 'done')
        .reduce((s, e) => s + (e.progress?.total ? (e.progress.done + e.progress.held) / e.progress.total : 0), 0),
      entries,
    },
    active,
    accounts: [...new Set([...(options.accountIds ?? []), ...Object.keys(pool)])].map((id) => {
      const a = pool[id] ?? {};
      const rows = runs.filter((t) => t['account'] === id);
      const last = rows[rows.length - 1] ?? null;
      const cold = (a.coldUntilMs ?? 0) > now;
      return {
        id,
        cold,
        coldMinutes: cold ? Math.ceil(((a.coldUntilMs ?? 0) - now) / 60000) : 0,
        refused: Boolean(a.refusedReason) && cold,
        refusedReason: a.refusedReason ?? null,
        ticks: a.uses ?? 0,
        cost: rows.reduce((s, t) => s + (Number(t.costUsd) || 0), 0),
        rateStatus: (last?.['rateStatus'] as string) ?? null,
        utilization: typeof last?.['utilization'] === 'number' ? last['utilization'] : null,
        windowEndsAt: null,
        overageStatus: (last?.['overageStatus'] as string) ?? null,
      };
    }),
    totals: {
      rows: runs.length,
      ticks: new Set(runs.map((t) => t.tick)).size,
      minutes: Math.round(sum.minutes),
      notional: Number(sum.cost.toFixed(2)),
      closed: sum.closed,
      billable: runs.filter((t) => t['usedOverage'] === true).length,
    },
    ticks: runs
      .slice(-40)
      .reverse()
      .map((t) => ({
        tick: t.tick,
        attempt: null,
        exit: t.exit ?? null,
        account: (t['account'] as string) ?? null,
        minutes: Math.round(Number(t.durationMinutes) || 0),
        closed: t.tasksClosed ?? 0,
        cost: t.costUsd ?? null,
        head: (t['head'] as string) ?? null,
        spec: (t['spec'] as string) ?? (t['specId'] as string) ?? null,
        startedAt: (t['startedAt'] as string) ?? null,
        tracker: (t['judgeAction'] as string) ?? null,
        note: (t['note'] as string) ?? (t['judgedBy'] ? `judge ${t['judgedBy']}: ${t['judgeHonest'] === false ? 'dishonest' : 'ok'}` : ''),
        redFirst: null,
      })),
    live: null,
    parked: [],
  };
}

/* --------------------------------------------------------------------- sign-off ---- */

async function isSignedOff(repoCwd: string, id: string): Promise<boolean> {
  const tags = await git(repoCwd, ['tag', '--list', `signed-off/${id}`]);
  return tags.split('\n').some((t) => t.trim() === `signed-off/${id}`);
}

/* ----------------------------------------------------------------------- server ---- */

/* --------------------------------------------------------------- live session feed ----
 * The Current-tick panel's engine: tail the newest `.spicyspec/runs/<...>/stream.jsonl`
 * (written live by the runner), ingest through the vendored agents registry, broadcast the
 * prototype's SSE events. Polled, not watched — Windows fs.watch misses appends, and a
 * frozen feed reads as a quiet worker, the worst failure a liveness view can have.
 * Deltas follow the prototype's B38 rule: offsets count against activityCount (which only
 * grows), never the retained window (which shrinks at its cap).
 * ------------------------------------------------------------------------------------ */

interface LiveTail {
  dir: string | null;
  offset: number;
  partial: string;
  reg: Record<string, unknown>;
  meta: Record<string, unknown> | null;
  seen: Map<string, number>;
}

function createLivePump(runsRoot: string, agentsMod: AgentsModule, broadcast: (event: string, data: unknown) => void) {
  const tail: LiveTail = { dir: null, offset: 0, partial: '', reg: agentsMod.createRegistry(), meta: null, seen: new Map() };

  const newestRunDir = (): string | null => {
    try {
      const names = readdirSync(runsRoot);
      let best: string | null = null;
      let bestM = 0;
      for (const n of names) {
        const p = join(runsRoot, n);
        const m = statSync(p).mtimeMs;
        if (m > bestM) {
          bestM = m;
          best = p;
        }
      }
      return best;
    } catch {
      return null;
    }
  };

  const readMeta = (dir: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const reset = (dir: string) => {
    tail.dir = dir;
    tail.offset = 0;
    tail.partial = '';
    tail.meta = readMeta(dir);
    tail.seen = new Map();
    const m = tail.meta;
    tail.reg = agentsMod.createRegistry({
      name: m ? `run ${String(m['number'])}` : 'worker',
      description: m ? `${String(m['spec'])}/${String(m['stage'])} via ${String(m['account'])}` : 'starting…',
      startedAt: (m?.['startedAt'] as string) ?? null,
    });
  };

  const pump = () => {
    const dir = newestRunDir();
    if (!dir) return;
    if (dir !== tail.dir) {
      reset(dir);
      broadcast('tick', { id: dir.split(/[\\\/]/).pop(), meta: tail.meta, reset: true });
    }
    const path = join(dir, 'stream.jsonl');
    if (!existsSync(path)) return;
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    if (size < tail.offset) reset(dir); // truncated under us
    if (size === tail.offset) return;
    let chunk: string;
    try {
      chunk = readFileSync(path).subarray(tail.offset, size).toString('utf8');
    } catch {
      return;
    }
    tail.offset = size;
    const text = tail.partial + chunk;
    const lines = text.split('\n');
    tail.partial = lines.pop() ?? '';

    const changed = new Set<string>();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        for (const id of agentsMod.ingest(tail.reg, JSON.parse(line))) changed.add(id);
      } catch {
        /* skip bad line */
      }
    }
    if (!changed.size) return;

    const full = agentsMod.snapshot(tail.reg, { detail: true });
    const byId = new Map(full.agents.map((a) => [String(a['id']), a]));
    const agents: Array<Record<string, unknown>> = [];
    const activity: Array<{ id: string; entry: unknown }> = [];
    for (const id of changed) {
      const a = byId.get(id);
      if (!a) continue;
      const { prompt, summary, activity: acts, activityCount, ...base } = a as Record<string, unknown> & {
        activity?: unknown[];
        activityCount?: number;
      };
      void prompt;
      void summary;
      agents.push(base);
      const count = Number(activityCount ?? 0);
      const window = (acts as unknown[]) ?? [];
      const sent = tail.seen.get(id) ?? Math.max(0, count - window.length);
      const fresh = Math.min(count - sent, window.length);
      if (fresh > 0) for (const entry of window.slice(window.length - fresh)) activity.push({ id, entry });
      tail.seen.set(id, count);
    }
    broadcast('agents', { agents, activity: activity.slice(-150), counts: full.counts, meta: tail.meta });
  };

  return {
    pump,
    hello(): unknown {
      const snap = agentsMod.snapshot(tail.reg, { detail: false });
      return { agents: snap.agents, counts: snap.counts, meta: tail.meta, where: null };
    },
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

export async function startControlRoom(options: RoomOptions): Promise<RunningRoom> {
  const { brief, checks, agents: agentsMod } = await vendored();
  const host = options.host ?? '127.0.0.1';
  const token = randomUUID();
  const checksPath = join(options.stateDir, 'founder-checks.json');

  // live feed: tail the runner's session logs, broadcast to every open EventSource
  const sseClients = new Set<ServerResponse>();
  const broadcast = (event: string, data: unknown) => {
    const frame = `event: ${event}
data: ${JSON.stringify(data)}

`;
    for (const client of sseClients) {
      try {
        client.write(frame);
      } catch {
        sseClients.delete(client);
      }
    }
  };
  const live = createLivePump(join(options.repoCwd, '.spicyspec', 'runs'), agentsMod, broadcast);
  const pumpTimer = setInterval(() => {
    try {
      live.pump();
    } catch {
      /* the feed must never take the room down */
    }
  }, 1000);
  pumpTimer.unref?.();

  const briefFor = async (kind: string, id: string) => {
    const built = brief.buildBrief(options.repoCwd, { kind, id, parkedKey: kind === 'parked' ? id : null });
    const itemKey = (kind === 'parked' ? '' : 'spec-') + id;
    const progress = checks.progressFor(checks.loadChecks(checksPath), itemKey, built);
    return { ...built, itemKey, progress, signedOffInGit: kind === 'spec' ? await isSignedOff(options.repoCwd, id) : false };
  };

  const owedIndex = async () => {
    const queue = await options.store.loadQueue();
    const roomEntries = queue.entries.map((e) => ({ ...e, status: STATUS_TO_ROOM[String(e.status)] ?? e.status }));
    const state = checks.loadChecks(checksPath);
    const items = brief.listOwed(options.repoCwd, roomEntries);
    return Promise.all(
      items.map(async (item) => {
        let progress = null;
        try {
          const built = brief.buildBrief(options.repoCwd, {
            kind: String(item['kind']),
            id: String(item['id']),
            parkedKey: item['kind'] === 'parked' ? String(item['id']) : null,
          });
          progress = checks.progressFor(state, String(item['key']), built);
        } catch {
          progress = null;
        }
        return {
          ...item,
          signedOff: item['kind'] === 'spec' ? await isSignedOff(options.repoCwd, String(item['id'])) : Boolean(progress?.signedOffAt),
          progress: progress && {
            done: progress.blockingDone,
            total: progress.blockingTotal,
            complete: progress.complete,
            startedAt: progress.startedAt,
            signedOffAt: progress.signedOffAt,
          },
        };
      }),
    );
  };

  const signOff = async (id: string) => {
    if (!/^\d{3}$/.test(id)) return { ok: false, message: 'sign-off needs a three-digit spec id' };
    const built = brief.buildBrief(options.repoCwd, { kind: 'spec', id, parkedKey: null });
    const progress = checks.progressFor(checks.loadChecks(checksPath), `spec-${id}`, built);
    if (!progress.complete) {
      const left = progress.blockingTotal - progress.blockingDone;
      return {
        ok: false,
        message: `${left} of ${progress.blockingTotal} checks still unticked — sign-off is refused until the journey is walked.`,
      };
    }
    if (await isSignedOff(options.repoCwd, id)) return { ok: false, message: `spec ${id} is already tagged signed-off/${id}` };
    try {
      execFileSync('git', ['tag', '-a', `signed-off/${id}`, '-m', `founder sign-off: ${progress.blockingDone} checks walked via the control room`], {
        cwd: options.repoCwd, encoding: 'utf8', windowsHide: true, timeout: 15_000,
      });
    } catch (err) {
      return { ok: false, message: 'git refused the tag: ' + String((err as Error).message).split('\n')[0] };
    }
    checks.markSignedOff(checksPath, `spec-${id}`);
    // ALSO record the review decision the parked workflow collects — one click, both systems.
    const { recordReviewDecision } = await import('./views.js');
    await recordReviewDecision(options.store, {
      specId: id, approved: true, note: `${progress.blockingDone} checks walked via the control room`, by: 'control-room', at: new Date().toISOString(),
    }).catch(() => undefined);
    return { ok: true, message: `spec ${id} is tagged signed-off/${id} and the review decision is recorded — the rotation collects it.` };
  };

  const actions: Record<string, () => { ok: boolean; message: string }> = {
    start: () => {
      const child = spawn(process.execPath, [options.runnerBin, 'run', '--config', options.configPath], {
        cwd: options.repoCwd, detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.unref();
      return { ok: true, message: 'rotation start dispatched (idempotent) — a runner must be up: spicyspec-runner start' };
    },
    stop: () => {
      try {
        const out = execFileSync(process.execPath, [options.runnerBin, 'halt', '--config', options.configPath], {
          cwd: options.repoCwd, encoding: 'utf8', windowsHide: true, timeout: 30_000,
        });
        return { ok: true, message: out.trim().split('\n')[0] || 'rotation cancelled' };
      } catch (err) {
        return { ok: false, message: String((err as Error).message).split('\n')[0] };
      }
    },
    kill: () => actions['stop'](),
    resume: () => ({ ok: true, message: 'nothing armed — START dispatches the rotation' }),
    report: () => ({ ok: true, message: 'use: spicyspec-runner handoff — writes HANDOFF-PACKAGE.md' }),
  };

  const ALLOWED_HOSTS = (port: number) => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const port = (server.address() as { port: number }).port;
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);
      const send = (code: number, body: string, type = 'application/json; charset=utf-8') => {
        res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
        res.end(body);
      };

      // B32 defences: host allowlist + cross-site rejection + token on mutations.
      if (!ALLOWED_HOSTS(port).has(String(req.headers.host))) return send(403, JSON.stringify({ error: 'host not allowed' }));
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return send(403, JSON.stringify({ error: 'cross-site rejected' }));

      const needsToken = req.method === 'POST';
      if (needsToken && req.headers['x-loop-token'] !== token) {
        return send(403, JSON.stringify({ ok: false, message: 'missing or stale control token — reload the page' }));
      }

      const readBody = () =>
        new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
          const parts: Buffer[] = [];
          let size = 0;
          req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > 64 * 1024) { rejectPromise(new Error('body too large')); req.destroy(); }
            else parts.push(c);
          });
          req.on('end', () => {
            try { resolvePromise(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); }
            catch { rejectPromise(new Error('body is not JSON')); }
          });
          req.on('error', rejectPromise);
        });

      try {
        if (url.pathname === '/api/state') return send(200, JSON.stringify(await buildRoomState(options, brief)));
        if (url.pathname === '/api/owed') return send(200, JSON.stringify({ owed: await owedIndex() }));
        if (url.pathname === '/api/brief') {
          return send(200, JSON.stringify(await briefFor(url.searchParams.get('kind') === 'parked' ? 'parked' : 'spec', url.searchParams.get('id') ?? '')));
        }
        if (url.pathname === '/api/check' && req.method === 'POST') {
          const b = await readBody();
          return send(200, JSON.stringify({ ok: true, state: checks.setCheck(checksPath, String(b['itemKey']), String(b['checkKey']), Boolean(b['value'])) }));
        }
        if (url.pathname === '/api/note' && req.method === 'POST') {
          const b = await readBody();
          return send(200, JSON.stringify({ ok: true, state: checks.setNote(checksPath, String(b['itemKey']), String(b['checkKey']), String(b['text'] ?? '')) }));
        }
        if (url.pathname === '/api/signoff' && req.method === 'POST') {
          const b = await readBody();
          return send(200, JSON.stringify(await signOff(String(b['id'] ?? ''))));
        }
        if (url.pathname.startsWith('/api/action/') && req.method === 'POST') {
          const name = url.pathname.split('/').pop() ?? '';
          const fn = Object.prototype.hasOwnProperty.call(actions, name) ? actions[name] : null;
          return send(fn ? 200 : 404, JSON.stringify(fn ? fn() : { ok: false, message: 'no such action' }));
        }
        if (url.pathname === '/api/live') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          res.write('retry: 3000\n\n');
          res.write(`event: hello\ndata: ${JSON.stringify(live.hello())}\n\n`);
          sseClients.add(res);
          const beat = setInterval(() => {
            try {
              res.write(': keepalive\n\n');
            } catch {
              /* closed */
            }
          }, 15_000);
          req.on('close', () => {
            clearInterval(beat);
            sseClients.delete(res);
          });
          return;
        }
        // Tabs whose machinery is not ported yet return valid empty shapes, never a crash.
        if (url.pathname === '/api/roles') return send(200, JSON.stringify({ roles: [] }));
        if (url.pathname === '/api/agents') return send(200, JSON.stringify({ agents: [], counts: {}, meta: null }));
        if (url.pathname === '/api/agent') return send(200, JSON.stringify({ agent: null }));
        if (url.pathname === '/api/where') return send(200, JSON.stringify({ text: 'narrative not ported yet' }));
        if (url.pathname === '/api/ship') return send(200, JSON.stringify({ readiness: { ready: false, reasons: ['ship is not ported yet'] }, request: null, specIds: [], plan: null }));

        // static assets
        const file = url.pathname === '/' ? 'app.html' : url.pathname.replace(/^\/+/, '');
        const path = join(ROOM, file);
        if (!path.startsWith(ROOM) || !existsSync(path)) return send(404, JSON.stringify({ error: 'not found' }));
        const ext = file.slice(file.lastIndexOf('.'));
        let body = readFileSync(path, 'utf8');
        if (file === 'app.html') body = body.replace('__LOOP_TOKEN__', token);
        return send(200, body, MIME[ext] ?? 'application/octet-stream');
      } catch (err) {
        return send(500, JSON.stringify({ error: String((err as Error).message) }));
      }
    })();
  });

  return new Promise((resolvePromise) => {
    server.listen(options.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : (options.port ?? 0);
      resolvePromise({
        server,
        port,
        close: () =>
          new Promise<void>((r) => {
            clearInterval(pumpTimer);
            for (const c of sseClients) {
              try {
                c.end();
              } catch {
                /* closing */
              }
            }
            server.close(() => r());
          }),
      });
    });
  });
}
