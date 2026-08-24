import { describe, expect, it } from 'vitest';
import {
  createNtfyChannel,
  createWebhookChannel,
  notificationFor,
  notifyAll,
  type FetchFn,
  type NotifyChannel,
} from './notify.js';

type Sent = { url: string; init: { method: string; headers: Record<string, string>; body: string } };

const capture = (): { calls: Sent[]; fetchFn: FetchFn } => {
  const calls: Sent[] = [];
  return {
    calls,
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200 };
    },
  };
};

describe('ntfy channel', () => {
  it('POSTs to the topic with title, priority, and tags headers', async () => {
    const { calls, fetchFn } = capture();
    const ch = createNtfyChannel({ topic: 't0p1c-s3cret', fetchFn });
    await ch.send(notificationFor('awaiting-review', 'Acme', '002'));
    expect(calls[0].url).toBe('https://ntfy.sh/t0p1c-s3cret');
    expect(calls[0].init.headers['title']).toContain('002 awaits YOUR review');
    expect(calls[0].init.headers['priority']).toBe('4');
    expect(calls[0].init.body).toContain('Walk the journey');
  });

  it('a halt outranks everything on the lock screen', async () => {
    const { calls, fetchFn } = capture();
    await createNtfyChannel({ topic: 't', fetchFn }).send(notificationFor('halted', 'Acme', null, 'Q3 two active'));
    expect(calls[0].init.headers['priority']).toBe('5');
    expect(calls[0].init.body).toBe('Q3 two active');
  });

  it('a custom server is honored, trailing slash tolerated', async () => {
    const { calls, fetchFn } = capture();
    await createNtfyChannel({ topic: 't', server: 'https://ntfy.example.com/', fetchFn }).send(
      notificationFor('complete', 'Acme', '001'),
    );
    expect(calls[0].url).toBe('https://ntfy.example.com/t');
  });

  it('a non-2xx is an error the fanout will record', async () => {
    const ch = createNtfyChannel({ topic: 't', fetchFn: async () => ({ ok: false, status: 429 }) });
    await expect(ch.send(notificationFor('parked', 'Acme', '003'))).rejects.toThrow(/429/);
  });
});

describe('webhook channel', () => {
  it('POSTs JSON with a readable text field for Slack-style receivers', async () => {
    const { calls, fetchFn } = capture();
    await createWebhookChannel({ url: 'https://hooks.example.com/T/B/x', fetchFn }).send(
      notificationFor('awaiting-review', 'Acme', '002'),
    );
    const payload = JSON.parse(calls[0].init.body);
    expect(payload.event).toBe('awaiting-review');
    expect(payload.specId).toBe('002');
    expect(payload.text).toContain('awaits YOUR review');
    expect(calls[0].init.headers['content-type']).toBe('application/json');
  });
});

describe('notifyAll — C3: failures recorded, never thrown, never silent', () => {
  const good = (id: string): NotifyChannel => ({ id, send: async () => undefined });
  const dead = (id: string, msg: string): NotifyChannel => ({
    id,
    send: async () => {
      throw new Error(msg);
    },
  });

  it('fans out to every channel and reports both outcomes', async () => {
    const r = await notifyAll([good('ntfy:a'), dead('webhook:b', 'ECONNREFUSED')], notificationFor('parked', 'Acme', '001'));
    expect(r.sent).toEqual(['ntfy:a']);
    expect(r.failures).toEqual([{ id: 'webhook:b', error: 'ECONNREFUSED' }]);
  });

  it('every channel dead still resolves — a dead channel must not kill the run it announces', async () => {
    const r = await notifyAll([dead('a', 'x'), dead('b', 'y')], notificationFor('halted', 'Acme', null));
    expect(r.sent).toEqual([]);
    expect(r.failures).toHaveLength(2);
  });

  it('no channels configured is a quiet no-op', async () => {
    const r = await notifyAll([], notificationFor('complete', 'Acme', '001'));
    expect(r).toEqual({ sent: [], failures: [] });
  });
});
