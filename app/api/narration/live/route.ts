import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { getStore } from '../../../../src/store/runs';
import { RUN_COOKIE } from '../../../../src/web/server';
import { clipStore, liveClip, voiceConfig } from '../../../../src/web/voice';

// Voices a line of a guided live run. Only for a browser holding a live run (which needed the
// access code). 404 means "use the browser voice".
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  const id = (await cookies()).get(RUN_COOKIE)?.value;
  const run = id ? await getStore().get(id).catch(() => null) : null;
  if (!run || run.mode !== 'live') return NextResponse.json({ error: 'live runs only' }, { status: 404 });
  const { text } = (await req.json().catch(() => ({}))) as { text?: unknown };
  if (typeof text !== 'string') return NextResponse.json({ error: 'text required' }, { status: 400 });
  try {
    const out = await liveClip(text, { cfg: voiceConfig(), store: clipStore() });
    if ('missing' in out) return NextResponse.json({ error: out.missing }, { status: 404 });
    if ('redirect' in out) return NextResponse.redirect(out.redirect, { status: 302 });
    return new Response(out.audio, { headers: { 'Content-Type': 'audio/mpeg' } });
  } catch (err) {
    console.error('live narration', (err as Error).message);
    return NextResponse.json({ error: 'voice unavailable' }, { status: 503 });
  }
}
