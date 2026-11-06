import type { Mode, SessionSnapshot } from '../demo/session.js';

// Where runs live between serverless requests. Supabase (Postgres) when configured, otherwise
// process memory, which is fine for `next dev` and tests but forgets everything on Vercel.

export interface StoredRun {
  id: string;
  mode: Mode;
  version: number;
  refs: string[];
  data: SessionSnapshot;
  updatedAt: string;
}

export interface WebhookEvent {
  id: string;
  name: string;
  payload: unknown;
}

export class ConflictError extends Error {
  constructor(id: string) {
    super(`Run ${id} was changed by another request`);
  }
}

export interface RunStore {
  readonly persistent: boolean;
  create(mode: Mode, data: SessionSnapshot, refs: string[]): Promise<StoredRun>;
  get(id: string): Promise<StoredRun | null>;
  /** Saves only if nobody else saved since `run` was read; otherwise throws ConflictError. */
  save(run: StoredRun, data: SessionSnapshot, refs: string[]): Promise<StoredRun>;
  findLiveByRef(ref: string): Promise<StoredRun[]>;
  recentLive(limit: number): Promise<StoredRun[]>;
  /** Records a webhook event; false if this event id was already received. */
  recordWebhook(evt: WebhookEvent): Promise<boolean>;
  markWebhookHandled(id: string, runIds: string[]): Promise<void>;
}

// ---------------------------------------------------------------- memory

interface MemoryState {
  runs: Map<string, StoredRun>;
  events: Map<string, WebhookEvent & { handled: string[] }>;
}
const g = globalThis as unknown as { __reckonMemory?: MemoryState };

export class MemoryRunStore implements RunStore {
  readonly persistent = false;
  private m: MemoryState;
  constructor(shared = true) {
    this.m = shared ? (g.__reckonMemory ??= { runs: new Map(), events: new Map() }) : { runs: new Map(), events: new Map() };
  }
  async create(mode: Mode, data: SessionSnapshot, refs: string[]) {
    const run: StoredRun = { id: crypto.randomUUID(), mode, version: 1, refs, data: structuredClone(data), updatedAt: new Date().toISOString() };
    this.m.runs.set(run.id, run);
    return structuredClone(run);
  }
  async get(id: string) {
    const r = this.m.runs.get(id);
    return r ? structuredClone(r) : null;
  }
  async save(run: StoredRun, data: SessionSnapshot, refs: string[]) {
    const cur = this.m.runs.get(run.id);
    if (!cur || cur.version !== run.version) throw new ConflictError(run.id);
    const next: StoredRun = { ...cur, version: cur.version + 1, refs, data: structuredClone(data), updatedAt: new Date().toISOString() };
    this.m.runs.set(run.id, next);
    return structuredClone(next);
  }
  async findLiveByRef(ref: string) {
    return [...this.m.runs.values()].filter((r) => r.mode === 'live' && r.refs.includes(ref)).map((r) => structuredClone(r));
  }
  async recentLive(limit: number) {
    return [...this.m.runs.values()]
      .filter((r) => r.mode === 'live')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }
  async recordWebhook(evt: WebhookEvent) {
    if (this.m.events.has(evt.id)) return false;
    this.m.events.set(evt.id, { ...evt, handled: [] });
    return true;
  }
  async markWebhookHandled(id: string, runIds: string[]) {
    const e = this.m.events.get(id);
    if (e) e.handled = runIds;
  }
}

// ---------------------------------------------------------------- supabase

interface Row {
  id: string;
  mode: Mode;
  version: number;
  refs: string[];
  data: SessionSnapshot;
  updated_at: string;
}

const toRun = (r: Row): StoredRun => ({ id: r.id, mode: r.mode, version: r.version, refs: r.refs, data: r.data, updatedAt: r.updated_at });

/** Talks to Supabase's REST API (PostgREST) with the service role key. Server-side only. */
export class SupabaseRunStore implements RunStore {
  readonly persistent = true;
  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown, prefer?: string): Promise<T> {
    const res = await this.fetchImpl(`${this.url.replace(/\/$/, '')}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: this.serviceKey,
        // Legacy service_role keys are JWTs and go in Authorization too; new sb_secret_ keys
        // belong in the apikey header only.
        ...(this.serviceKey.startsWith('eyJ') ? { Authorization: `Bearer ${this.serviceKey}` } : {}),
        'Content-Type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} failed (${res.status}): ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  async create(mode: Mode, data: SessionSnapshot, refs: string[]) {
    const rows = await this.req<Row[]>('POST', 'reckon_runs', { mode, data, refs }, 'return=representation');
    return toRun(rows[0]!);
  }

  async get(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const rows = await this.req<Row[]>('GET', `reckon_runs?id=eq.${id}&select=*`);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async save(run: StoredRun, data: SessionSnapshot, refs: string[]) {
    const rows = await this.req<Row[]>(
      'PATCH',
      `reckon_runs?id=eq.${run.id}&version=eq.${run.version}`,
      { data, refs, version: run.version + 1, updated_at: new Date().toISOString() },
      'return=representation',
    );
    if (!rows.length) throw new ConflictError(run.id);
    return toRun(rows[0]!);
  }

  async findLiveByRef(ref: string) {
    const safe = ref.replace(/[^A-Za-z0-9_-]/g, '');
    const rows = await this.req<Row[]>('GET', `reckon_runs?mode=eq.live&refs=cs.%7B${encodeURIComponent(safe)}%7D&select=*`);
    return rows.map(toRun);
  }

  async recentLive(limit: number) {
    const rows = await this.req<Row[]>('GET', `reckon_runs?mode=eq.live&order=updated_at.desc&limit=${Math.max(1, Math.min(limit, 20))}&select=*`);
    return rows.map(toRun);
  }

  async recordWebhook(evt: WebhookEvent) {
    const rows = await this.req<unknown[]>(
      'POST',
      'reckon_webhook_events?on_conflict=id',
      { id: evt.id, name: evt.name, payload: evt.payload },
      'resolution=ignore-duplicates,return=representation',
    );
    return rows.length > 0;
  }

  async markWebhookHandled(id: string, runIds: string[]) {
    await this.req('PATCH', `reckon_webhook_events?id=eq.${encodeURIComponent(id)}`, { handled_runs: runIds });
  }
}

let cached: RunStore | null = null;

export function getStore(): RunStore {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  cached = url && key ? new SupabaseRunStore(url, key) : new MemoryRunStore();
  return cached;
}
