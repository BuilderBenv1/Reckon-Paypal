import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import type { Action } from '../../../../src/demo/session';
import { applyAction, appInfo, errorMessage, RUN_COOKIE } from '../../../../src/web/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  const id = (await cookies()).get(RUN_COOKIE)?.value;
  if (!id) return NextResponse.json({ error: 'Start a run first.' }, { status: 400 });
  try {
    const { action } = (await req.json()) as { action: Action };
    return NextResponse.json({ info: appInfo(), run: await applyAction(id, action) });
  } catch (err) {
    const e = errorMessage(err);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
