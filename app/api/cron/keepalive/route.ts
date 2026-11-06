import { NextResponse } from 'next/server';
import { getStore } from '../../../../src/store/runs';

// Supabase pauses free projects after 7 days with no activity. Vercel Cron calls this once a
// day (see vercel.json) so the run store stays awake while the demo is public.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  }
  const store = getStore();
  if (!store.persistent) return NextResponse.json({ ok: true, store: 'memory' });
  try {
    await store.recentLive(1);
    return NextResponse.json({ ok: true, store: 'supabase' });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
