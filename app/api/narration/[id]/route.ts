import { NextResponse } from 'next/server';
import { clipFor, clipStore, voiceConfig } from '../../../../src/web/voice';

// One line of the guided demo, voiced by ElevenLabs and cached. 404 means "use the browser voice".
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const out = await clipFor(id, { cfg: voiceConfig(), store: clipStore() });
    if ('missing' in out) return NextResponse.json({ error: out.missing }, { status: 404 });
    if ('redirect' in out) return NextResponse.redirect(out.redirect, { status: 302, headers: { 'Cache-Control': 'public, max-age=86400' } });
    return new Response(out.audio, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' } });
  } catch (err) {
    console.error('narration', (err as Error).message);
    return NextResponse.json({ error: 'voice unavailable' }, { status: 503 });
  }
}
