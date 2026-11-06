import { createHash } from 'node:crypto';
import { Session } from '../demo/session.js';
import { after, afterTamper, before, intro, outro, presenterName, TOUR_STEPS, type Opts } from './narration.js';
import { buildView, type RunView } from './view.js';

// Human narration for the guided demo. Each line is voiced once by ElevenLabs and cached in
// Supabase Storage, so judges replaying the demo cost nothing. Only lines the demo itself would
// say can be voiced: the allowlist is the demo script, rebuilt here from a fresh demo run.

export const DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb'; // ElevenLabs "George": warm, British
export const DEFAULT_MODEL = 'eleven_v4'; // ElevenLabs' highest-quality model; eleven_multilingual_v2 also works

/** The id the browser asks for. Same algorithm in narrator.ts: sha256 hex, first 20. */
export const lineId = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 20);

export interface VoiceConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
  /** Leave unset to use the voice's own tuned settings (the most natural on v4). */
  stability?: number;
}

/** ElevenLabs' built-in voices, offered on /voices to audition against a real line of the script. */
export const CANDIDATES: { id: string; name: string; accent: string }[] = [
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', accent: 'British, male' },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', accent: 'British, male' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', accent: 'British, female' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice', accent: 'British, female' },
  { id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie', accent: 'Australian, male' },
  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian', accent: 'American, male' },
  { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda', accent: 'American, female' },
  { id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica', accent: 'American, female' },
];

export function voiceConfig(env: Record<string, string | undefined> = process.env): VoiceConfig | null {
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) return null;
  const stability = Number(env.ELEVENLABS_STABILITY);
  return {
    apiKey,
    voiceId: env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_VOICE,
    modelId: env.ELEVENLABS_MODEL?.trim() || DEFAULT_MODEL,
    ...(env.ELEVENLABS_STABILITY && stability >= 0 && stability <= 1 ? { stability } : {}),
  };
}

let script: Promise<string[]> | null = null;

/**
 * Every line the guided demo can say, in order: the default script (names PayPal), then event
 * mode (?handoff: generic bank, presenter's name), each with the Claude-on wording where it differs.
 */
export function demoScript(): Promise<string[]> {
  return (script ??= (async () => {
    const s = await Session.create('demo', { claude: false });
    const morning = buildView('script', s);
    const steps: { step: (typeof TOUR_STEPS)[number]; before: RunView; after: RunView }[] = [];
    let v = morning;
    for (const step of TOUR_STEPS) {
      const prev = v;
      await s.act(v.steps.find((x) => x.id === step)!.action!);
      v = buildView('script', s);
      steps.push({ step, before: prev, after: v });
    }
    await s.act({ type: 'replay', decisionId: 'pay:PAY-114-FREIGHT', tamper: true });
    const end = buildView('script', s);

    const presenter = presenterName(process.env.RECKON_PRESENTER);
    const variants: Opts[] = [{}, { paypal: false, presenter }, { paypal: false, presenter: null }];
    const lines: string[] = [];
    const add = (beats: { text: string }[]) => beats.forEach((b) => lines.push(b.text));
    for (const o of variants) {
      for (const claude of [false, true]) {
        const c = (x: RunView): RunView => ({ ...x, claude });
        add(intro(c(morning), o));
        for (const st of steps) {
          add(before(st.step, c(st.before), o));
          add(after(st.step, c(st.before), c(st.after), o));
        }
        add(afterTamper(c(end), o));
        add(outro(c(end), o));
      }
    }
    return [...new Set(lines)];
  })());
}

export async function findLine(id: string): Promise<{ text: string; previous?: string; next?: string } | null> {
  if (!/^[0-9a-f]{20}$/.test(id)) return null;
  const lines = await demoScript();
  const i = lines.findIndex((t) => lineId(t) === id);
  if (i < 0) return null;
  return { text: lines[i]!, ...(i > 0 ? { previous: lines[i - 1] } : {}), ...(i < lines.length - 1 ? { next: lines[i + 1] } : {}) };
}

/** The storage key changes with the voice and model, so switching voice re-records. */
export const clipKey = (cfg: VoiceConfig, text: string) =>
  createHash('sha256').update(`${cfg.voiceId}|${cfg.modelId}|${text}`).digest('hex').slice(0, 32);

/**
 * Voices one line. v4 has no Style or Speed settings, so it gets stability and similarity only.
 * If the API rejects the request shape (400/422), retry once with just the text and model:
 * newer models don't all accept the continuity fields, and a plain read beats no voice.
 */
export async function synthesise(cfg: VoiceConfig, line: { text: string; previous?: string; next?: string }, fetchImpl: typeof fetch = fetch): Promise<ArrayBuffer> {
  const full = {
    text: line.text,
    model_id: cfg.modelId,
    ...(cfg.stability !== undefined ? { voice_settings: { stability: cfg.stability, similarity_boost: 0.75 } } : {}),
    ...(line.previous ? { previous_text: line.previous } : {}),
    ...(line.next ? { next_text: line.next } : {}),
  };
  const call = (body: object) =>
    fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': cfg.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify(body),
    });
  let res = await call(full);
  if (res.status === 400 || res.status === 422) {
    console.error('ElevenLabs rejected the full request, retrying plain:', (await res.text()).slice(0, 200));
    res = await call({ text: line.text, model_id: cfg.modelId });
  }
  if (!res.ok) throw new Error(`ElevenLabs failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.arrayBuffer();
}

// ---------------------------------------------------------------- clip cache

export interface ClipStore {
  /** A URL the browser can fetch the cached clip from, or null if it isn't cached. */
  url(key: string): Promise<string | null>;
  put(key: string, mp3: ArrayBuffer): Promise<void>;
  get?(key: string): ArrayBuffer | undefined;
}

const BUCKET = 'narration';

/** Supabase Storage, public bucket `narration` (created by migration 0002). */
export class SupabaseClipStore implements ClipStore {
  constructor(
    private readonly base: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private publicUrl(key: string) {
    return `${this.base.replace(/\/$/, '')}/storage/v1/object/public/${BUCKET}/${key}.mp3`;
  }
  async url(key: string) {
    const u = this.publicUrl(key);
    const res = await this.fetchImpl(u, { method: 'HEAD', cache: 'no-store' });
    return res.ok ? u : null;
  }
  async put(key: string, mp3: ArrayBuffer) {
    const res = await this.fetchImpl(`${this.base.replace(/\/$/, '')}/storage/v1/object/${BUCKET}/${key}.mp3`, {
      method: 'POST',
      headers: {
        apikey: this.key,
        ...(this.key.startsWith('eyJ') ? { Authorization: `Bearer ${this.key}` } : {}),
        'Content-Type': 'audio/mpeg',
        'x-upsert': 'true',
        'Cache-Control': 'max-age=31536000',
      },
      body: mp3,
    });
    if (!res.ok) throw new Error(`Storage upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

const g = globalThis as unknown as { __reckonClips?: Map<string, ArrayBuffer> };

/** Without Supabase: keep clips in this server's memory. */
export class MemoryClipStore implements ClipStore {
  private m = (g.__reckonClips ??= new Map());
  async url() {
    return null;
  }
  get(key: string) {
    return this.m.get(key);
  }
  async put(key: string, mp3: ArrayBuffer) {
    this.m.set(key, mp3);
  }
}

export function clipStore(env: Record<string, string | undefined> = process.env): ClipStore {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? new SupabaseClipStore(url, key) : new MemoryClipStore();
}

export type ClipResult = { redirect: string } | { audio: ArrayBuffer } | { missing: string };

/** The line every candidate voice reads on /voices. */
export async function sampleLine(): Promise<string> {
  return (await demoScript())[1]!;
}

/** A candidate voice reading the sample line, cached like any other clip. */
export async function sampleFor(voiceId: string, deps: { cfg: VoiceConfig | null; store: ClipStore; fetchImpl?: typeof fetch }): Promise<ClipResult> {
  if (!deps.cfg) return { missing: 'no voice configured' };
  if (!CANDIDATES.some((c) => c.id === voiceId) && voiceId !== deps.cfg.voiceId) return { missing: 'not a voice on the shortlist' };
  const cfg = { ...deps.cfg, voiceId };
  const text = await sampleLine();
  const key = clipKey(cfg, text);
  const mem = deps.store.get?.(key);
  if (mem) return { audio: mem };
  const cached = await deps.store.url(key).catch(() => null);
  if (cached) return { redirect: cached };
  const audio = await synthesise(cfg, { text }, deps.fetchImpl);
  await deps.store.put(key, audio).catch((err) => console.error('narration cache', (err as Error).message));
  return { audio };
}

/** Cached clip if there is one; otherwise voice it now and cache it. */
export async function clipFor(id: string, deps: { cfg: VoiceConfig | null; store: ClipStore; fetchImpl?: typeof fetch }): Promise<ClipResult> {
  const line = await findLine(id);
  if (!line) return { missing: 'not a line from the guided demo' };
  if (!deps.cfg) return { missing: 'no voice configured' };
  const key = clipKey(deps.cfg, line.text);
  const mem = deps.store.get?.(key);
  if (mem) return { audio: mem };
  const cached = await deps.store.url(key).catch(() => null);
  if (cached) return { redirect: cached };
  const audio = await synthesise(deps.cfg, line, deps.fetchImpl);
  await deps.store.put(key, audio).catch((err) => console.error('narration cache', (err as Error).message));
  return { audio };
}

/**
 * Live runs say different numbers (real sandbox rates), so their lines can't be on the demo
 * allowlist. They're voiced on request instead, but only for whoever holds a live run, and a
 * live run needs RECKON_LIVE_CODE to start. Still cached, so a re-run costs nothing.
 */
export async function liveClip(text: string, deps: { cfg: VoiceConfig | null; store: ClipStore; fetchImpl?: typeof fetch }): Promise<ClipResult> {
  if (!deps.cfg) return { missing: 'no voice configured' };
  const t = text.trim();
  if (!t || t.length > 700) return { missing: 'not a narration line' };
  const key = clipKey(deps.cfg, t);
  const mem = deps.store.get?.(key);
  if (mem) return { audio: mem };
  const cached = await deps.store.url(key).catch(() => null);
  if (cached) return { redirect: cached };
  const audio = await synthesise(deps.cfg, { text: t }, deps.fetchImpl);
  await deps.store.put(key, audio).catch((err) => console.error('narration cache', (err as Error).message));
  return { audio };
}
