/**
 * The control-plane request handler — pure: (method, path, body) in, (status, json) out.
 * Testable without a socket; the http binding (server.ts) is a thin shell over this.
 *
 * Read endpoints are GET and side-effect-free. The ONE mutation — recording a review
 * decision — is POST and requires a CSRF token that a browser cannot forge cross-site
 * (prototype B32: the dashboard's process-control API was CSRF-open). GET carries no
 * token; a mutation without a valid token is refused before it touches the store.
 */
import type { Store } from '@spicyspec/store';
import { gateTrail, overview, readReviewDecision, recordReviewDecision, runHistory } from './views.js';

export interface ApiRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  /** the CSRF token the client presented (header/body); required for mutations */
  csrfToken?: string;
}

export interface ApiResponse {
  status: number;
  json: unknown;
}

export interface ApiDeps {
  store: Store;
  projectName: string;
  /** the session CSRF token a mutation must present; issued to the page at load */
  csrfToken: string;
  now: () => string;
}

const json = (status: number, body: unknown): ApiResponse => ({ status, json: body });

export async function handleApi(req: ApiRequest, deps: ApiDeps): Promise<ApiResponse> {
  const { store } = deps;

  // Read surface — GET only, no token.
  if (req.method === 'GET') {
    if (req.path === '/api/overview') return json(200, await overview(store, deps.projectName, deps.now()));
    if (req.path === '/api/runs') {
      const limit = Math.min(Math.max(Number(req.query['limit'] ?? '50') || 50, 1), 500);
      return json(200, await runHistory(store, limit));
    }
    if (req.path === '/api/gates') return json(200, await gateTrail(store, req.query['spec']));
    const m = /^\/api\/specs\/([^/]+)\/review$/.exec(req.path);
    if (m) return json(200, { specId: m[1], decision: await readReviewDecision(store, m[1]) });
    return json(404, { error: 'not found' });
  }

  // Mutation surface — POST, CSRF-guarded.
  if (req.method === 'POST') {
    const m = /^\/api\/specs\/([^/]+)\/review$/.exec(req.path);
    if (!m) return json(404, { error: 'not found' });
    if (req.csrfToken !== deps.csrfToken) return json(403, { error: 'bad or missing CSRF token' });

    const body = (req.body ?? {}) as { approved?: unknown; note?: unknown; by?: unknown };
    if (typeof body.approved !== 'boolean') {
      return json(400, { error: 'body.approved must be a boolean' });
    }
    try {
      const record = {
        specId: m[1],
        approved: body.approved,
        note: String(body.note ?? ''),
        by: String(body.by ?? 'unknown'),
        at: deps.now(),
      };
      await recordReviewDecision(store, record);
      return json(200, { ok: true, decision: record });
    } catch (err) {
      return json(404, { error: String((err as Error).message) });
    }
  }

  return json(405, { error: 'method not allowed' });
}
