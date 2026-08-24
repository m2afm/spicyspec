/**
 * Notifications — the 91%-idle killer.
 *
 * The prototype's single dominant waste: 9.8 hours of a 48-hour run spent stopped dead,
 * waiting on a human who did not know they were being waited on. A run that parks on a
 * review, a spec that gets parked, a rotation that halts — each MUST reach a phone.
 *
 * Channels are dead simple on purpose: ntfy.sh (one HTTP POST, free phone app — right for
 * a solo founder) and a generic webhook (Slack/Discord/anything). Fanout records every
 * failure and never throws — a dead notification channel must not take down the run it
 * was announcing (the C3 pattern: degrade visibly, never silently).
 */

export type NotifyEvent = 'awaiting-review' | 'parked' | 'halted' | 'complete' | 'stopped';

export interface Notification {
  event: NotifyEvent;
  specId: string | null;
  title: string;
  body: string;
}

export interface NotifyChannel {
  id: string;
  send(notification: Notification): Promise<void>;
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

const defaultFetch: FetchFn = async (url, init) => {
  const r = await fetch(url, init);
  return { ok: r.ok, status: r.status };
};

/** Urgency by event — a halt beats a completion on a lock screen. */
const NTFY_PRIORITY: Record<NotifyEvent, string> = {
  halted: '5',
  'awaiting-review': '4',
  parked: '4',
  stopped: '3',
  complete: '3',
};

const NTFY_TAGS: Record<NotifyEvent, string> = {
  halted: 'rotating_light',
  'awaiting-review': 'eyes',
  parked: 'construction',
  stopped: 'octagonal_sign',
  complete: 'white_check_mark',
};

export interface NtfyOptions {
  /** the topic is the address — treat it as a secret */
  topic: string;
  server?: string;
  fetchFn?: FetchFn;
}

export function createNtfyChannel(options: NtfyOptions): NotifyChannel {
  const server = (options.server ?? 'https://ntfy.sh').replace(/\/$/, '');
  const fetchFn = options.fetchFn ?? defaultFetch;
  return {
    id: `ntfy:${options.topic}`,
    async send(n) {
      const r = await fetchFn(`${server}/${options.topic}`, {
        method: 'POST',
        headers: {
          title: n.title,
          priority: NTFY_PRIORITY[n.event],
          tags: NTFY_TAGS[n.event],
        },
        body: n.body,
      });
      if (!r.ok) throw new Error(`ntfy responded ${r.status}`);
    },
  };
}

export interface WebhookOptions {
  url: string;
  fetchFn?: FetchFn;
}

export function createWebhookChannel(options: WebhookOptions): NotifyChannel {
  const fetchFn = options.fetchFn ?? defaultFetch;
  return {
    id: `webhook:${new URL(options.url).host}`,
    async send(n) {
      const r = await fetchFn(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `text` rides along so Slack/Discord-style receivers render something readable
        // without a mapping step.
        body: JSON.stringify({ event: n.event, specId: n.specId, title: n.title, body: n.body, text: `${n.title}\n${n.body}` }),
      });
      if (!r.ok) throw new Error(`webhook responded ${r.status}`);
    },
  };
}

export interface NotifyResult {
  sent: string[];
  failures: Array<{ id: string; error: string }>;
}

/** Fan out to every channel. Never throws; every failure is recorded (C3). */
export async function notifyAll(channels: readonly NotifyChannel[], notification: Notification): Promise<NotifyResult> {
  const sent: string[] = [];
  const failures: Array<{ id: string; error: string }> = [];
  await Promise.all(
    channels.map(async (ch) => {
      try {
        await ch.send(notification);
        sent.push(ch.id);
      } catch (err) {
        failures.push({ id: ch.id, error: String((err as Error)?.message ?? err).slice(0, 200) });
      }
    }),
  );
  return { sent, failures };
}

/** The standard messages, one place — dashboards and phones say the same thing. */
export function notificationFor(event: NotifyEvent, projectName: string, specId: string | null, detail = ''): Notification {
  const titles: Record<NotifyEvent, string> = {
    'awaiting-review': `${projectName}: spec ${specId ?? '?'} awaits YOUR review`,
    parked: `${projectName}: spec ${specId ?? '?'} parked`,
    halted: `${projectName}: rotation HALTED`,
    stopped: `${projectName}: spec ${specId ?? '?'} stopped by you`,
    complete: `${projectName}: spec ${specId ?? '?'} complete`,
  };
  const bodies: Record<NotifyEvent, string> = {
    'awaiting-review': detail || 'Walk the journey by clicking, then Approve/Reject on the dashboard. Nothing moves until you do.',
    parked: detail || 'It needs a decision or a fix the loop cannot make.',
    halted: detail || 'The queue is in a state the loop refuses to guess about.',
    stopped: detail || 'Your kill ended the run. The spec keeps its stage — Clear stop to resume it.',
    complete: detail || 'Stage advanced.',
  };
  return { event, specId, title: titles[event], body: bodies[event] };
}
