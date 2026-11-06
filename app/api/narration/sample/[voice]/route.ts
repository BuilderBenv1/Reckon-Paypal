import { NextResponse } from 'next/server';
import { clipStore, sampleFor, voiceConfig } from '../../../../../src/web/voice';

// A shortlisted voice reading one line of the script, for /voices. Voiced once, then cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(_req: Request, ctx: { params: Promise<{ voice: string }> }) {
  const { voice } = await ctx.params;
  try {
    const out = await sampleFor(voice, { cfg: voiceConfig(), store: clipStore() });
    if ('missing' in out) return NextResponse.json({ error: out.missing }, { status: 404 });
    if ('redirect' in out) return NextResponse.redirect(out.redirect, { status: 302 });
    return new Response(out.audio, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' } });
  } catch (err) {
    console.error('voice sample', (err as Error).message);
    return NextResponse.json({ error: 'voice unavailable' }, { status: 503 });
  }
}
