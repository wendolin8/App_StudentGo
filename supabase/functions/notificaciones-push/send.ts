import * as webpush from 'npm:web-push@4.0.0';
import { validSubscription, type Subscription } from './validation.ts';

export type PushConfig = { publicKey: string; privateKey: string; subject: string };
export type PushMessage = { kind: 'test' | 'notice'; tag: string };

export async function sendPush(subscription: Subscription, message: PushMessage, config: PushConfig): Promise<number> {
  if (!validSubscription(subscription)) throw new Error('Invalid subscription');
  const details = webpush.generateRequestDetails(subscription, JSON.stringify(message), {
    vapidDetails: config,
    TTL: 300,
    urgency: 'normal',
  });
  const response = await fetch(details.endpoint, {
    method: details.method,
    headers: details.headers,
    body: details.body ? new Uint8Array(details.body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  await response.body?.cancel();
  return response.status;
}
