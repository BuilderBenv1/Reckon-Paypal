import { NextResponse } from 'next/server';
import { depsFor } from '../../../../src/web/server';
import { getStore } from '../../../../src/store/runs';
import { PayPalRest } from '../../../../src/paypal/rest';
import { handleEvent, webhookHeaders, type PayPalEvent } from '../../../../src/webhooks/paypal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// PayPal retries anything but a 2xx, so only a delivery that fails verification gets a 4xx.
export async function POST(req: Request) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return NextResponse.json({ error: 'Webhook id not configured' }, { status: 503 });

  const headers = webhookHeaders((n) => req.headers.get(n));
  if (!headers) return NextResponse.json({ error: 'missing or untrusted PayPal signature headers' }, { status: 400 });

  let evt: PayPalEvent;
  try {
    evt = (await req.json()) as PayPalEvent;
  } catch {
    return NextResponse.json({ error: 'Body is not JSON' }, { status: 400 });
  }
  if (!evt.id || !evt.event_type) return NextResponse.json({ ok: true, ignored: 'no id or event_type' });

  let genuine = false;
  try {
    genuine = await PayPalRest.fromEnv().verifyWebhookSignature(headers, webhookId, evt);
  } catch (err) {
    console.error('webhook verification call failed', evt.id, err);
    return NextResponse.json({ error: 'could not verify' }, { status: 503 }); // PayPal will retry
  }
  if (!genuine) return NextResponse.json({ error: 'signature did not verify' }, { status: 400 });

  const store = getStore();
  if (!(await store.recordWebhook({ id: evt.id, name: evt.event_type, payload: evt }))) {
    return NextResponse.json({ ok: true, duplicate: true });
  }
  try {
    const handled = await handleEvent(store, evt, depsFor('live'));
    await store.markWebhookHandled(evt.id, handled);
    return NextResponse.json({ ok: true, handled: handled.length });
  } catch (err) {
    // Recorded but not applied. Return 200 so PayPal doesn't retry into the same failure;
    // the page's own invoice check still picks up a paid invoice.
    console.error('webhook handling failed', evt.id, err);
    return NextResponse.json({ ok: true, applied: false });
  }
}
