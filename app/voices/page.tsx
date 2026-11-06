import type { Metadata } from 'next';
import { CANDIDATES, sampleLine, voiceConfig } from '../../src/web/voice';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Reckon: pick a narrator voice', robots: { index: false } };

export default async function Voices() {
  const cfg = voiceConfig();
  const line = await sampleLine();
  const current = cfg?.voiceId;
  const list = current && !CANDIDATES.some((c) => c.id === current) ? [{ id: current, name: 'Your current voice', accent: 'set in ELEVENLABS_VOICE_ID' }, ...CANDIDATES] : CANDIDATES;
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">Reckon</span>
          <span className="brand-sub">Pick a narrator voice</span>
        </div>
      </header>
      <section className="landing" style={{ maxWidth: 760 }}>
        {!cfg ? (
          <p className="muted">Add ELEVENLABS_API_KEY in Vercel first, then reload this page.</p>
        ) : (
          <>
            <p className="muted">
              Each voice reads the same line from the guided demo, on {cfg.modelId}. A voice is generated the first time you press play, so give it a few
              seconds. To use one, put its ID in <code>ELEVENLABS_VOICE_ID</code> in Vercel and redeploy.
            </p>
            <blockquote className="voice-line">&ldquo;{line}&rdquo;</blockquote>
            <ul className="voice-list">
              {list.map((v) => (
                <li key={v.id} className="voice-row">
                  <div>
                    <strong>{v.name}</strong>
                    {v.id === current && <span className="chip chip-ready" style={{ marginLeft: 8 }}>in use</span>}
                    <div className="faint">
                      {v.accent} · <code>{v.id}</code>
                    </div>
                  </div>
                  <audio controls preload="none" src={`/api/narration/sample/${v.id}`} />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
