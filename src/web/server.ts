import { liveConfigured, Session, type Action, type Mode, type SessionDeps } from '../demo/session.js';
import { getStore } from '../store/runs.js';
import { withRun } from '../store/withRun.js';
import { buildView, type RunView } from './view.js';
import { presenterName } from './narration.js';

export const RUN_COOKIE = 'reckon_run';

/**
 * Demo runs are public, so they use Claude only when the owner opts in (RECKON_DEMO_CLAUDE=1);
 * live runs use Claude whenever a key is set.
 */
export function depsFor(mode: Mode): SessionDeps {
  const key = !!process.env.ANTHROPIC_API_KEY;
  return { claude: mode === 'live' ? key : key && process.env.RECKON_DEMO_CLAUDE === '1' };
}

export interface AppInfo {
  liveAvailable: boolean;
  liveNeedsCode: boolean;
  persistent: boolean;
  /** ElevenLabs is configured, so the guided demo can use a human voice. */
  voice: boolean;
  /** Who the guided demo hands over to at the end, when the page is opened with ?handoff. */
  presenter: string | null;
}

export function appInfo(): AppInfo {
  return {
    liveAvailable: liveConfigured(),
    liveNeedsCode: !!process.env.RECKON_LIVE_CODE,
    persistent: getStore().persistent,
    voice: !!process.env.ELEVENLABS_API_KEY?.trim(),
    presenter: presenterName(process.env.RECKON_PRESENTER),
  };
}

export async function loadView(runId: string | undefined): Promise<RunView | null> {
  if (!runId) return null;
  const run = await getStore().get(runId);
  if (!run) return null;
  return buildView(run.id, Session.restore(run.data, depsFor(run.mode)));
}

export async function createRun(mode: Mode, code?: string): Promise<RunView> {
  if (mode === 'live') {
    if (!liveConfigured()) throw new UserError('Live runs need Airwallex sandbox keys on the server.');
    const want = process.env.RECKON_LIVE_CODE;
    if (want && code !== want) throw new UserError('That access code is not right.');
  }
  const session = await Session.create(mode, depsFor(mode));
  const run = await getStore().create(mode, session.snapshot(), session.refs());
  return buildView(run.id, session);
}

const ALLOWED: Action['type'][] = ['delay_email', 'run', 'approve', 'customer_pays', 'check_links', 'split_reply', 'chase', 'replay', 'custom_email'];

export async function applyAction(runId: string, action: Action): Promise<RunView> {
  if (!ALLOWED.includes(action.type)) throw new UserError('Unknown action.');
  const store = getStore();
  const existing = await store.get(runId);
  if (!existing) throw new UserError('This run has expired. Start a new one.');
  const { run, session } = await withRun(store, runId, (s) => s.act(action), depsFor(existing.mode));
  return buildView(run.id, session);
}

/** Errors worth showing to the person, as opposed to bugs. */
export class UserError extends Error {}

export function errorMessage(err: unknown): { message: string; status: number } {
  if (err instanceof UserError) return { message: err.message, status: 400 };
  const message = err instanceof Error ? err.message : String(err);
  // Policy and sandbox refusals are meaningful to show; keep them short.
  return { message: message.slice(0, 300), status: 500 };
}
