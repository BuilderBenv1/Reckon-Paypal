import { NextResponse } from 'next/server';
import { depsFor } from '../../../../src/web/server';
import { getStore } from '../../../../src/store/runs';
import { handleEvent, verifySignature, type AirwallexEvent } from '../../../../src/webhooks/airwallex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Airwallex retries anything but a 200 for about three days, so only a bad signature gets a 4xx.
export async function POST(req: Request) {
  const secret = process.env.AIRWALLEX_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 503 });

  const raw = await req.text(); // verify the exact bytes, before any JSON parsing
  const check = verifySignature(raw, req.headers.get('x-timestamp'), req.headers.get('x-signature'), secret);
  if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 400 });

  let evt: AirwallexEvent;
  try {
    evt = JSON.parse(raw) as AirwallexEvent;
  } catch {
    return NextResponse.json({ error: 'Body is not JSON' }, { status: 400 });
  }
  if (!evt.id || !evt.name) return NextResponse.json({ ok: true, ignored: 'no id or name' });

  const store = getStore();
  if (!(await store.recordWebhook({ id: evt.id, name: evt.name, payload: evt }))) {
    return NextResponse.json({ ok: true, duplicate: true });
  }
  try {
    const handled = await handleEvent(store, evt, depsFor('live'));
    await store.markWebhookHandled(evt.id, handled);
    return NextResponse.json({ ok: true, handled: handled.length });
  } catch (err) {
    // Recorded but not applied. Return 200 so Airwallex doesn't retry into the same failure;
    // the page's own payment check still picks up a paid link.
    console.error('webhook handling failed', evt.id, err);
    return NextResponse.json({ ok: true, applied: false });
  }
}
