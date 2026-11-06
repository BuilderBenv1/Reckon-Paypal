import { describe, expect, it } from 'vitest';
import { Session } from '../src/demo/session.js';
import { ConflictError, MemoryRunStore, SupabaseRunStore } from '../src/store/runs.js';
import { withRun } from '../src/store/withRun.js';

describe('memory run store', () => {
  it('saves with optimistic versioning and rejects a stale save', async () => {
    const store = new MemoryRunStore(false);
    const s = await Session.create('demo', { claude: false });
    const run = await store.create('demo', s.snapshot(), s.refs());
    const saved = await store.save(run, s.snapshot(), []);
    expect(saved.version).toBe(2);
    await expect(store.save(run, s.snapshot(), [])).rejects.toBeInstanceOf(ConflictError);
  });

  it('dedupes webhook events', async () => {
    const store = new MemoryRunStore(false);
    expect(await store.recordWebhook({ id: 'evt_1', name: 'x', payload: {} })).toBe(true);
    expect(await store.recordWebhook({ id: 'evt_1', name: 'x', payload: {} })).toBe(false);
  });

  it('withRun retries when another request saved in between', async () => {
    const store = new MemoryRunStore(false);
    const s = await Session.create('demo', { claude: false });
    const run = await store.create('demo', s.snapshot(), []);
    let sneaky = true;
    const { run: saved } = await withRun(
      store,
      run.id,
      async (session) => {
        if (sneaky) {
          sneaky = false;
          const cur = (await store.get(run.id))!;
          await store.save(cur, cur.data, cur.refs); // a webhook lands mid-request
        }
        await session.act({ type: 'delay_email' });
      },
      { claude: false },
    );
    expect(saved.version).toBe(3);
    expect(saved.data.done).toContain('delay_email');
  });
});

describe('supabase run store', () => {
  const recorder = (responses: { status: number; body: unknown }[]) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = responses.shift() ?? { status: 200, body: [] };
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  it('saves with a version filter and treats no rows as a conflict', async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: [] }]);
    const store = new SupabaseRunStore('https://x.supabase.co/', 'eyJsvc', fetchImpl);
    const run = { id: '11111111-1111-4111-8111-111111111111', mode: 'demo' as const, version: 4, refs: [], data: {} as never, updatedAt: '' };
    await expect(store.save(run, {} as never, [])).rejects.toBeInstanceOf(ConflictError);
    expect(calls[0]!.url).toBe('https://x.supabase.co/rest/v1/reckon_runs?id=eq.11111111-1111-4111-8111-111111111111&version=eq.4');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer eyJsvc');
    expect(JSON.parse(calls[0]!.init.body as string).version).toBe(5);
  });

  it('sends a new-style secret key in the apikey header only', async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: [] }]);
    await new SupabaseRunStore('https://x.supabase.co', 'sb_secret_abc', fetchImpl).recentLive(5);
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.apikey).toBe('sb_secret_abc');
    expect(h.Authorization).toBeUndefined();
  });

  it('ignores duplicate webhook ids', async () => {
    const { calls, fetchImpl } = recorder([{ status: 201, body: [] }]);
    const store = new SupabaseRunStore('https://x.supabase.co', 'svc', fetchImpl);
    expect(await store.recordWebhook({ id: 'evt_1', name: 'n', payload: {} })).toBe(false);
    expect((calls[0]!.init.headers as Record<string, string>).Prefer).toContain('ignore-duplicates');
  });

  it('rejects ids that are not uuids without calling Supabase', async () => {
    const { calls, fetchImpl } = recorder([]);
    expect(await new SupabaseRunStore('https://x.supabase.co', 'svc', fetchImpl).get("x' or 1=1")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
