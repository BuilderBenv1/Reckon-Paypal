import { Session, type SessionDeps } from '../demo/session.js';
import { ConflictError, type RunStore, type StoredRun } from './runs.js';

/**
 * Loads a run, applies a change, and saves it. If another request (say, a webhook) saved the
 * same run in between, reload and try again rather than overwrite its work.
 */
export async function withRun<T>(
  store: RunStore,
  id: string,
  fn: (s: Session) => Promise<T>,
  deps: SessionDeps = {},
  attempts = 3,
): Promise<{ run: StoredRun; session: Session; result: T }> {
  for (let i = 0; ; i++) {
    const run = await store.get(id);
    if (!run) throw new Error('Run not found');
    const session = Session.restore(run.data, deps);
    const result = await fn(session);
    try {
      const saved = await store.save(run, session.snapshot(), session.refs());
      return { run: saved, session, result };
    } catch (err) {
      if (!(err instanceof ConflictError) || i >= attempts - 1) throw err;
    }
  }
}
