/**
 * The control-plane HTTP server — a thin node:http shell over the pure handleApi.
 *
 * No web framework: the read/command surface is small and every routing decision lives in
 * the tested pure handler. The server binds localhost by default (a team deployment fronts
 * it with its own auth/proxy — the control plane does not invent an auth scheme it cannot
 * test). The CSRF token is minted per process and injected into the page; a cross-site
 * POST cannot read it, so it cannot forge the one mutation (prototype B32).
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Store } from '@spicyspec/store';
import { handleApi } from './api.js';
import { renderDashboard } from './dashboard-html.js';

export interface ControlPlaneOptions {
  store: Store;
  projectName: string;
  host?: string;
  port?: number;
}

export interface RunningControlPlane {
  server: Server;
  port: number;
  csrfToken: string;
  close(): Promise<void>;
}

const MAX_BODY = 1024 * 1024;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        rejectPromise(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolvePromise(null);
      try {
        resolvePromise(JSON.parse(raw));
      } catch {
        rejectPromise(new Error('invalid JSON body'));
      }
    });
    req.on('error', rejectPromise);
  });
}

export function startControlPlane(options: ControlPlaneOptions): Promise<RunningControlPlane> {
  const csrfToken = randomUUID();
  const host = options.host ?? '127.0.0.1';
  const now = () => new Date().toISOString();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${host}`);
      const path = url.pathname;

      // The page itself, with the CSRF token embedded for its fetch() calls.
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        const html = renderDashboard(options.projectName, csrfToken);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return;
      }

      if (!path.startsWith('/api/')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      let body: unknown = null;
      if (req.method === 'POST') {
        try {
          body = await readBody(req);
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String((err as Error).message) }));
          return;
        }
      }

      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) query[k] = v;

      const response = await handleApi(
        {
          method: req.method ?? 'GET',
          path,
          query,
          body,
          csrfToken: req.headers['x-csrf-token'] as string | undefined,
        },
        { store: options.store, projectName: options.projectName, csrfToken, now },
      );
      res.writeHead(response.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(response.json));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    });
  });

  return new Promise((resolvePromise) => {
    server.listen(options.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : (options.port ?? 0);
      resolvePromise({
        server,
        port,
        csrfToken,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}
