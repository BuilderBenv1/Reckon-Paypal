import type { SessionDeps } from '../demo/session.js';
import type { RunStore } from '../store/runs.js';
import { withRun } from '../store/withRun.js';
import type { WebhookHeaders } from '../paypal/rest.js';

// PayPal webhooks: https://developer.paypal.com/api/rest/webhooks/
// Each delivery is signed; we ask PayPal to verify it (POST /v1/notifications/verify-webhook-signature)
// before acting. Delivery is at-least-once and unordered, so events are deduplicated on their id.

export interface PayPalEvent {
  id: string;
  event_type: string;
  resource_type?: string;
  resource?: {
    id?: string;
    invoice?: { id?: string };
    payout_batch_id?: string;
    batch_header?: { payout_batch_id?: string };
  };
}

/** Reads PayPal's signature headers; null if any is missing. */
export function webhookHeaders(get: (name: string) => string | null): WebhookHeaders | null {
  const authAlgo = get('paypal-auth-algo');
  const certUrl = get('paypal-cert-url');
  const transmissionId = get('paypal-transmission-id');
  const transmissionSig = get('paypal-transmission-sig');
  const transmissionTime = get('paypal-transmission-time');
  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) return null;
  // PayPal only ever serves its signing certs from paypal.com.
  try {
    const host = new URL(certUrl).hostname;
    if (!(host === 'paypal.com' || host.endsWith('.paypal.com'))) return null;
  } catch {
    return null;
  }
  return { authAlgo, certUrl, transmissionId, transmissionSig, transmissionTime };
}

/** The invoice an invoicing event is about. */
export const invoiceIdOf = (e: PayPalEvent) => e.resource?.invoice?.id ?? (e.resource_type === 'invoices' || e.event_type.startsWith('INVOICING.') ? e.resource?.id : undefined);

/** The payout batch a payouts event is about. */
export const payoutBatchOf = (e: PayPalEvent) => e.resource?.payout_batch_id ?? e.resource?.batch_header?.payout_batch_id;

/**
 * Applies one event to the live runs it concerns. A paid invoice makes the agent check its
 * invoices and replan on its own; a payout event refreshes that payout's status in the ledger.
 */
export async function handleEvent(store: RunStore, evt: PayPalEvent, deps: SessionDeps = {}): Promise<string[]> {
  const handled: string[] = [];
  if (evt.event_type === 'INVOICING.INVOICE.PAID') {
    const invoiceId = invoiceIdOf(evt);
    let runs = invoiceId ? await store.findLiveByRef(invoiceId) : [];
    // No run owns that invoice id: fall back to recent live runs still waiting on an invoice.
    if (!runs.length) runs = (await store.recentLive(5)).filter((r) => Object.values(r.data.reckon.state.earlyPayLinks).includes('sent'));
    for (const run of runs) {
      await withRun(store, run.id, (s) => s.act({ type: 'check_links' }), deps);
      handled.push(run.id);
    }
  } else if (evt.event_type.startsWith('PAYMENT.PAYOUTS-ITEM.') || evt.event_type.startsWith('PAYMENT.PAYOUTSBATCH.')) {
    const transferId = payoutBatchOf(evt);
    if (!transferId) return handled;
    for (const run of await store.findLiveByRef(transferId)) {
      await withRun(store, run.id, (s) => s.act({ type: 'sync_transfer', transferId }), deps);
      handled.push(run.id);
    }
  }
  return handled;
}
