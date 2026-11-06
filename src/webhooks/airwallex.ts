import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SessionDeps } from '../demo/session.js';
import type { RunStore } from '../store/runs.js';
import { withRun } from '../store/withRun.js';

// Airwallex webhooks: https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events
// Signature = hex HMAC-SHA256 over (x-timestamp + raw body), keyed with the notification URL's secret.
// Delivery is at-least-once and unordered, so events are deduplicated on their id.

/** How far the x-timestamp (milliseconds) may be from now. */
export const TOLERANCE_MS = 5 * 60 * 1000;

export function signatureFor(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}${rawBody}`).digest('hex');
}

export function verifySignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  secret: string,
  now = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (!timestamp || !signature) return { ok: false, reason: 'missing x-timestamp or x-signature' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  if (Math.abs(now - ts) > TOLERANCE_MS) return { ok: false, reason: 'timestamp outside tolerance' };
  const expected = Buffer.from(signatureFor(secret, timestamp, rawBody), 'hex');
  const given = Buffer.from(signature.trim(), 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

export interface AirwallexEvent {
  id: string;
  name: string;
  data?: { object?: { id?: string; status?: string } };
}

/**
 * Applies one event to the live runs it concerns. A paid payment link makes the agent check its
 * links and replan on its own; a transfer event refreshes that transfer's status in the ledger.
 */
export async function handleEvent(store: RunStore, evt: AirwallexEvent, deps: SessionDeps = {}): Promise<string[]> {
  const handled: string[] = [];
  if (evt.name === 'payment_intent.succeeded') {
    // The intent doesn't reliably name the link, so check the recent live runs still waiting on one.
    for (const run of await store.recentLive(5)) {
      const waiting = Object.values(run.data.reckon.state.earlyPayLinks).includes('sent');
      if (!waiting) continue;
      await withRun(store, run.id, (s) => s.act({ type: 'check_links' }), deps);
      handled.push(run.id);
    }
  } else if (evt.name.startsWith('payout.transfer.')) {
    const transferId = evt.data?.object?.id;
    if (!transferId) return handled;
    for (const run of await store.findLiveByRef(transferId)) {
      await withRun(store, run.id, (s) => s.act({ type: 'sync_transfer', transferId }), deps);
      handled.push(run.id);
    }
  }
  return handled;
}
