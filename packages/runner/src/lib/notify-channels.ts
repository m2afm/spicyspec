/**
 * Notification channels from a runner config — one builder, two callers (the rotation's
 * queue activities and the supervisor). Split out so the supervisor can reach a phone
 * without importing the rotation's activity graph.
 */
import { createNtfyChannel, createWebhookChannel, type NotifyChannel } from '@spicyspec/notify';
import type { RunnerConfig } from './config.js';

export function notifyChannelsFor(config: RunnerConfig): NotifyChannel[] {
  return config.notify.channels.map((c) =>
    c.type === 'ntfy' ? createNtfyChannel({ topic: c.topic, server: c.server }) : createWebhookChannel({ url: c.url }),
  );
}
