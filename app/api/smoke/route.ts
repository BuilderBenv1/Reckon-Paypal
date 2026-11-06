import { NextResponse } from 'next/server';
import { PayPalRest } from '../../../src/paypal/rest';
import { isSandbox, runSmoke } from '../../../src/paypal/smoke';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// One-off PayPal sandbox check on the hosted app, using the keys already in Vercel. Off by default:
// it runs only while the `smoke` row in reckon_pp_flags has an `until` in the future, and closes
// that window as soon as it runs. Sandbox only. The report holds no keys.

async function supabase(path: string, init: RequestInit = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase not configured');
  return fetch(`${url.replace(/\/$/, '')}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
      'Content-Type': 'application/json',
      ...init.headers,
    },
    cache: 'no-store',
  });
}

export async function GET() {
  if (!isSandbox(process.env.PAYPAL_BASE_URL)) return NextResponse.json({ error: 'sandbox only' }, { status: 403 });
  let open = false;
  try {
    const res = await supabase(`reckon_pp_flags?key=eq.smoke&until=gt.${encodeURIComponent(new Date().toISOString())}&select=key`);
    open = res.ok && ((await res.json()) as unknown[]).length > 0;
  } catch {
    open = false;
  }
  if (!open) return NextResponse.json({ error: 'smoke check is switched off' }, { status: 403 });
  // Close the window first, so a second request can't start another run.
  await supabase('reckon_pp_flags?key=eq.smoke', { method: 'PATCH', body: JSON.stringify({ until: new Date().toISOString() }) });

  let pp: PayPalRest;
  try {
    pp = PayPalRest.fromEnv();
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 503 });
  }
  return NextResponse.json(await runSmoke(pp));
}
