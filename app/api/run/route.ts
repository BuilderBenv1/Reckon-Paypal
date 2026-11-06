import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { appInfo, createRun, errorMessage, loadView, RUN_COOKIE } from '../../../src/web/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  const id = (await cookies()).get(RUN_COOKIE)?.value;
  try {
    return NextResponse.json({ info: appInfo(), run: await loadView(id) });
  } catch (err) {
    const e = errorMessage(err);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { mode?: string; code?: string };
    const mode = body.mode === 'live' ? 'live' : 'demo';
    const run = await createRun(mode, body.code);
    const res = NextResponse.json({ info: appInfo(), run });
    res.cookies.set(RUN_COOKIE, run.id, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 7 });
    return res;
  } catch (err) {
    const e = errorMessage(err);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
