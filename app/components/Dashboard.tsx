'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Action } from '../../src/demo/session';
import type { DecisionView, RunView, StepView } from '../../src/web/view';
import type { AppInfo } from '../../src/web/server';
import { after, afterTamper, before, intro, outro, TOUR_STEPS, type Beat, type Focus, type Opts } from '../../src/web/narration';
import { Cancelled, englishVoices, Narrator, pickVoice } from './narrator';

type Ccy = 'USD' | 'EUR' | 'GBP';

const money = (n: number, c: Ccy | string = 'USD', dp = 0) =>
  `${c} ${n.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp === 0 ? 2 : dp })}`;
const whole = (n: number, c: Ccy | string = 'USD') => `${c} ${Math.round(n).toLocaleString('en-GB')}`;

const GITHUB = 'https://github.com/BuilderBenv1/RECKON';

export function Dashboard({ initialRun, info: initialInfo }: { initialRun: RunView | null; info: AppInfo }) {
  const [run, setRun] = useState<RunView | null>(initialRun);
  const [info, setInfo] = useState<AppInfo>(initialInfo);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(async (url: string, body: unknown, label: string, quiet = false): Promise<RunView | null> => {
    if (!quiet) {
      setBusy(label);
      setError(null);
    }
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = (await res.json()) as { run?: RunView; info?: AppInfo; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `Request failed (${res.status})`);
      if (json.run) setRun(json.run);
      if (json.info) setInfo(json.info);
      return json.run ?? null;
    } catch (err) {
      if (!quiet) setError((err as Error).message);
      return null;
    } finally {
      if (!quiet) setBusy(null);
    }
  }, []);

  const act = useCallback((action: Action, label: string) => call('/api/run/action', { action }, label), [call]);
  const start = useCallback((mode: 'demo' | 'live', code?: string) => call('/api/run', { mode, code }, `start-${mode}`), [call]);

  // ---- guided demo: a narrator plays the story, presses each button and says what to notice
  const [tour, setTour] = useState<{ caption: string; paused: boolean; muted: boolean; link?: string | null } | null>(null);
  const narrator = useRef<Narrator | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceName, setVoiceName] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const load = () => setVoices(englishVoices());
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    try {
      setVoiceName(window.localStorage.getItem('reckon-voice'));
    } catch {
      /* storage unavailable: use the default voice */
    }
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);
  const chosenVoice = pickVoice(voices, voiceName);
  useEffect(() => {
    if (narrator.current) narrator.current.voice = chosenVoice;
  }, [chosenVoice]);

  const play = useCallback(async (n: Narrator, beats: Beat[]) => {
    n.prefetch(beats.map((b) => b.text));
    for (const b of beats) {
      await n.gate();
      await new Promise((r) => setTimeout(r, 120)); // let React paint the new state first
      spotlight(b.focus);
      setTour((t) => (t ? { ...t, caption: b.text } : t));
      await n.speak(b.text);
      await n.wait(250);
    }
  }, []);

  /** The guided demo. With an access code it runs on the real PayPal sandbox instead. */
  const runTour = useCallback(async (liveCode?: string) => {
    const live = liveCode !== undefined;
    narrator.current?.stop();
    const n = new Narrator();
    n.voice = chosenVoice;
    n.human = info.voice;
    n.live = live;
    n.unlock();
    narrator.current = n;
    setTour({ caption: live ? 'Starting a live run on the PayPal sandbox…' : 'Starting a fresh demo run…', paused: false, muted: false });
    const working = () => live && setTour((t) => (t ? { ...t, caption: 'Working on the PayPal sandbox…' } : t));
    document.body.classList.add('touring');
    // ?short skips the longer spoken introduction. ?handoff is event mode: no PayPal, "Ben has
    // just built", and it hands over to the presenter at the end.
    const q = new URLSearchParams(window.location.search);
    const short = q.has('short');
    const o: Opts = q.has('handoff') ? { paypal: false, presenter: info.presenter } : {};
    try {
      let v = await start(live ? 'live' : 'demo', liveCode);
      if (!v) return;
      await play(n, intro(v, o).filter((b) => !short || !b.extra));
      for (const step of TOUR_STEPS) {
        n.prefetch(before(step, v, o).map((b) => b.text));
        await play(n, before(step, v, o));
        const action = v.steps.find((s) => s.id === step)?.action;
        if (!action) break;
        const prev = v;
        if (live && step === 'customer_pays') {
          // A person pays the real link with the test card; Reckon notices by itself (webhook, or this check).
          const link = v.steps.find((s) => s.id === step)?.link ?? v.links[0]?.url ?? null;
          setTour((t) => (t ? { ...t, link, caption: 'Waiting for the payment. Open the link and pay with test card 4035 5010 0000 0008, any future expiry and CVC.' } : t));
          const deadline = Date.now() + 10 * 60_000;
          let paid: RunView | null = null;
          while (!paid && Date.now() < deadline) {
            await n.wait(5000);
            const cur = await call('/api/run/action', { action: { type: 'check_links' } }, 'poll', true);
            if (cur?.steps.find((s) => s.id === step)?.state === 'done') paid = cur;
          }
          setTour((t) => (t ? { ...t, link: null } : t));
          if (!paid) throw new Error('No payment after 10 minutes, so the guided run has stopped. The run is still open.');
          v = paid;
        } else {
          await press(n, `[data-tour-step="${step}"]`);
          working();
          const next = await act(action, `step-${step}`);
          if (!next) return;
          v = next;
        }
        await play(n, after(step, prev, v, o));
      }
      await press(n, '[data-tour-step="tamper"]');
      working();
      const tampered = await act({ type: 'replay', decisionId: 'pay:PAY-114-FREIGHT', tamper: true }, 'replay-pay:PAY-114-FREIGHT-true');
      if (tampered) {
        v = tampered;
        await play(n, afterTamper(v, o));
      }
      await play(n, outro(v, o));
    } catch (err) {
      if (!(err instanceof Cancelled)) setError((err as Error).message);
    } finally {
      n.stop();
      if (narrator.current === n) {
        narrator.current = null;
        setTour(null);
        spotlight(null);
        document.body.classList.remove('touring');
      }
    }
  }, [act, call, start, play, chosenVoice, info.voice, info.presenter]);

  useEffect(() => () => narrator.current?.stop(), []);

  const tourBar = tour && (
    <TourBar
      caption={tour.caption}
      link={tour.link ?? null}
      paused={tour.paused}
      muted={tour.muted}
      voices={info.voice ? [] : voices}
      voice={chosenVoice?.name ?? ''}
      onVoice={(name) => {
        setVoiceName(name);
        try {
          window.localStorage.setItem('reckon-voice', name);
        } catch {
          /* fine: the choice just isn't remembered */
        }
      }}
      onPause={() => {
        const n = narrator.current;
        if (!n) return;
        if (n.isPaused) n.resume();
        else n.pause();
        setTour((t) => (t ? { ...t, paused: n.isPaused } : t));
      }}
      onMute={() => {
        const n = narrator.current;
        if (!n) return;
        n.setMuted(!n.muted);
        setTour((t) => (t ? { ...t, muted: n.muted } : t));
      }}
      onStop={() => narrator.current?.stop()}
    />
  );

  // Live runs: while the customer link is unpaid, check it every few seconds (the webhook usually wins).
  const waitingOnLink = run?.mode === 'live' && run.steps.find((s) => s.id === 'customer_pays')?.state === 'next' && run.links.some((l) => l.status === 'sent');
  const polling = useRef(false);
  useEffect(() => {
    if (!waitingOnLink) return;
    const t = setInterval(async () => {
      if (polling.current) return;
      polling.current = true;
      await call('/api/run/action', { action: { type: 'check_links' } }, 'poll', true);
      polling.current = false;
    }, 6000);
    return () => clearInterval(t);
  }, [waitingOnLink, call]);

  if (!run)
    return (
      <>
        <Landing info={info} busy={busy || (tour ? 'tour' : null)} error={error} onStart={start} onTour={() => runTour()} onLiveTour={(code) => runTour(code)} />
        {tourBar}
      </>
    );

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">Reckon</span>
          <span className="brand-sub">Morning cash brief for Monday 2 November</span>
        </div>
        <div className="topbar-actions">
          <span className="mode" data-mode={run.mode}>
            <span className="mode-dot" aria-hidden />
            {run.mode === 'live' ? 'Live PayPal sandbox' : 'Demo: simulated PayPal'}
          </span>
          {run.mode === 'demo' && !tour && (
            <button className="btn btn-agent" disabled={!!busy} onClick={() => runTour()}>
              Guided demo
            </button>
          )}
          <button className="btn btn-quiet" disabled={!!busy || !!tour} onClick={() => start(run.mode === 'live' ? 'live' : 'demo')}>
            Start again
          </button>
        </div>
      </header>

      <div className="grid">
        <main className="main">
          <Hero run={run} />
          <Brief run={run} busy={busy} onApprove={(id) => act({ type: 'approve', decisionId: id }, `approve-${id}`)} />
          {run.last && <Changes run={run} />}
          <Decisions run={run} busy={busy} onReplay={(id) => act({ type: 'replay', decisionId: id }, `replay-${id}`)} />
          <div className="two">
            <Payments run={run} />
            <Outbox run={run} />
          </div>
          <div className="two">
            <Recon run={run} />
            <Signals run={run} />
          </div>
          {run.claude && <CustomEmail busy={busy} onSend={(m) => act({ type: 'custom_email', ...m }, 'custom')} />}
          <Log run={run} />
        </main>

        <aside className="rail" aria-label="What happens next">
          {error && <div className="toast" role="alert">{error}</div>}
          <Steps run={run} busy={busy} onAct={act} />
          <Proof run={run} busy={busy} onReplay={(id, tamper) => act({ type: 'replay', decisionId: id, tamper }, `replay-${id}-${tamper}`)} />
          {!info.persistent && <div className="note">Runs are kept in server memory here, so they reset when the server restarts. Add Supabase to keep them.</div>}
        </aside>
      </div>

      <footer className="foot">
        <span>
          Ledger: {run.ledger.records} recorded decisions, hash chain {run.ledger.chainOk ? 'intact' : 'broken'}, head {run.ledger.head}
        </span>
        <span>
          Synthetic data only. <a href={GITHUB}>Source on GitHub</a>
        </span>
      </footer>
      {tourBar}
    </div>
  );
}

// ---------------------------------------------------------------- guided demo

function spotlight(focus: Focus | null) {
  document.querySelectorAll('.tour-focus').forEach((el) => el.classList.remove('tour-focus'));
  if (!focus) return;
  const el = document.querySelector(`[data-tour="${focus}"]`);
  if (!el) return;
  el.classList.add('tour-focus');
  el.scrollIntoView({ behavior: 'smooth', block: focus === 'steps' || focus === 'proof' ? 'nearest' : 'center' });
}

/** Shows the narrator pressing a button, so viewers see what triggered the change. */
async function press(n: Narrator, selector: string) {
  await n.gate();
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('tour-press');
  await n.wait(700);
  el.classList.remove('tour-press');
}

function TourBar(p: {
  caption: string;
  link: string | null;
  paused: boolean;
  muted: boolean;
  voices: SpeechSynthesisVoice[];
  voice: string;
  onVoice: (name: string) => void;
  onPause: () => void;
  onMute: () => void;
  onStop: () => void;
}) {
  return (
    <div className="tourbar" role="region" aria-label="Guided demo narration">
      <div className="tourbar-head">
        <span className="tourbar-who">
          <span className="tourbar-dot" data-paused={p.paused} aria-hidden />
          Guided demo
        </span>
        <div className="tourbar-controls">
          {p.voices.length > 1 && (
            <select className="tourbar-voice" aria-label="Narrator voice" value={p.voice} onChange={(e) => p.onVoice(e.target.value)}>
              {p.voices.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name.replace(/^Microsoft /, '').replace(/ Online \(Natural\)/, ' (natural)')}
                </option>
              ))}
            </select>
          )}
          <button className="tourbar-btn" onClick={p.onMute}>
            {p.muted ? 'Sound on' : 'Mute'}
          </button>
          <button className="tourbar-btn" onClick={p.onPause}>
            {p.paused ? 'Resume' : 'Pause'}
          </button>
          <button className="tourbar-btn" onClick={p.onStop}>
            Stop
          </button>
        </div>
      </div>
      <p className="tourbar-caption" aria-live="polite">
        {p.caption}
      </p>
      {p.link && (
        <a className="btn btn-agent tourbar-link" href={p.link} target="_blank" rel="noreferrer">
          Open the PayPal invoice
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- landing

function Landing({
  info,
  busy,
  error,
  onStart,
  onTour,
  onLiveTour,
}: {
  info: AppInfo;
  busy: string | null;
  error: string | null;
  onStart: (m: 'demo' | 'live', code?: string) => void;
  onTour: () => void;
  onLiveTour: (code: string) => void;
}) {
  const [code, setCode] = useState('');
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">Reckon</span>
          <span className="brand-sub">A treasury agent for project businesses, on PayPal</span>
        </div>
      </header>
      <section className="landing">
        <h1>Most cash agents decide who waits. Reckon closes the gap.</h1>
        <p className="landing-lede">
          It reads the finance team&apos;s own sheet, ranks every payment by what it unlocks on its project, holds spend that has no budget, and
          prices every way to close a shortfall, including getting a customer to pay early by PayPal invoice. Every decision can be replayed
          from its inputs.
        </p>
        <div className="landing-actions">
          <button className="btn btn-primary" disabled={!!busy} onClick={onTour}>
            {busy === 'tour' ? 'Starting…' : 'Watch the guided demo'}
          </button>
          <button className="btn" disabled={!!busy} onClick={() => onStart('demo')}>
            {busy === 'start-demo' ? 'Starting…' : 'Try it yourself'}
          </button>
          {info.liveAvailable && (
            <>
              {info.liveNeedsCode && (
                <input className="code-input" placeholder="Access code" aria-label="Access code for live runs" value={code} onChange={(e) => setCode(e.target.value)} />
              )}
              <button className="btn" disabled={!!busy} onClick={() => onStart('live', code)}>
                {busy === 'start-live' ? 'Starting…' : 'Start a live sandbox run'}
              </button>
              <button className="btn btn-agent" disabled={!!busy} onClick={() => onLiveTour(code)}>
                Guided live run
              </button>
            </>
          )}
        </div>
        {error && (
          <div className="toast" role="alert" style={{ marginTop: 16 }}>
            {error}
          </div>
        )}
        <div className="landing-points">
          <div>
            <h3>Ranks by what a payment unlocks</h3>
            <p>A freight bill that lets an install finish and releases a $24,000 milestone goes first. Nobody tags it critical.</p>
          </div>
          <div>
            <h3>Pulls cash in</h3>
            <p>Offers a reliable customer 1.5% to pay today by payment link, asks a supplier who has agreed before to split, defers what costs nothing to delay.</p>
          </div>
          <div>
            <h3>Proves every decision</h3>
            <p>Money logic is code. Claude only reads emails and drafts messages. Approvals are tied to exact terms, and nothing is ever paid twice.</p>
          </div>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- hero

function Hero({ run }: { run: RunView }) {
  const s = run.summary;
  const above = Math.max(0, s.cashUSD - s.reserveFloorUSD);
  const available = above + s.expectedReceiptsUSD;
  const scale = Math.max(available, s.dueInHorizonUSD + Math.max(0, s.heldUSD * 0), 1) * 1.04;
  const pct = (n: number) => `${(Math.max(0, n) / scale) * 100}%`;
  const short = s.gapUSD > 0;
  const closed = short && s.gapAfterLeversUSD <= 0;

  const headline = short
    ? closed
      ? `${whole(s.gapUSD)} short this week. Reckon closes it for ${whole(s.leversCostUSD)}.`
      : `${whole(s.gapUSD)} short this week. ${whole(s.gapAfterLeversUSD)} still needs the MD.`
    : `This week is covered, with ${whole(-s.gapUSD)} to spare above the reserve.`;

  return (
    <section className="hero" data-tour="hero" aria-labelledby="hero-title">
      <h1 id="hero-title">{headline}</h1>
      <p className="hero-lede">
        {short
          ? 'What is due in the next three days, against cash above the reserve floor and receipts Reckon trusts. Spend held for the MD is left out.'
          : 'Due in the next three days against cash above the reserve floor and receipts Reckon trusts.'}
      </p>
      <div className="bridge" role="img" aria-label={`Available ${whole(available)} against ${whole(s.dueInHorizonUSD)} due`}>
        <div className="bridge-row">
          <span className="bridge-label">Cash above reserve</span>
          <div className="bridge-track">
            <div className="bridge-bar bar-cash" style={{ left: 0, width: pct(above) }} />
            <div className="bridge-bar bar-receipts" style={{ left: pct(above), width: pct(s.expectedReceiptsUSD) }} />
          </div>
          <span className="bridge-value">{whole(available)}</span>
        </div>
        <div className="bridge-row">
          <span className="bridge-label">Due in 3 days</span>
          <div className="bridge-track">
            <div className="bridge-bar bar-due" style={{ left: 0, width: pct(Math.min(s.dueInHorizonUSD, available)) }} />
            {short && <div className="bridge-bar bar-gap" style={{ left: pct(available), width: pct(s.gapUSD) }} />}
          </div>
          <span className="bridge-value">{whole(s.dueInHorizonUSD)}</span>
        </div>
        {short && (
          <div className="bridge-row">
            <span className="bridge-label">Closed by levers</span>
            <div className="bridge-track">
              <div className="bridge-bar bar-levers" style={{ left: pct(available), width: pct(Math.min(s.gapUSD, s.gapUSD - s.gapAfterLeversUSD)) }} />
            </div>
            <span className="bridge-value">{whole(s.leversCostUSD)} cost</span>
          </div>
        )}
        <div className="bridge-foot">
          <span>
            Cash <strong>{whole(s.cashUSD)}</strong>
          </span>
          <span>
            Reserve floor <strong>{whole(s.reserveFloorUSD)}</strong>
          </span>
          <span>
            Trusted receipts <strong>{whole(s.expectedReceiptsUSD)}</strong>
          </span>
          {s.heldUSD > 0 && (
            <span>
              Held for the MD <strong>{whole(s.heldUSD)}</strong>
            </span>
          )}
          <span>
            Forecast confidence <strong>{s.forecastConfidence}</strong>
          </span>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- brief + approvals

function Brief({ run, busy, onApprove }: { run: RunView; busy: string | null; onApprove: (id: string) => void }) {
  const approvable = (d: DecisionView) => d.kind !== 'hold' && d.kind !== 'escalate_gap';
  return (
    <section data-tour="brief" aria-labelledby="brief-title">
      <div className="section-head">
        <h2 id="brief-title">The MD&apos;s brief</h2>
        <span className="section-note">One paragraph, and only what needs a person</span>
      </div>
      <div className="brief">
        <p className="brief-text">{run.brief.split('\n\nNeeds you:')[0]}</p>
        {run.needsYou.length > 0 && (
          <div className="approvals">
            {run.needsYou.map((d) => (
              <div className="approval" key={d.id}>
                <div>
                  <div className="approval-title">
                    {d.label} {money(d.amount, d.currency, 2)}
                    {d.project ? ` on Job ${d.job}, ${d.project}` : ''}
                  </div>
                  <p className="approval-reason">{d.reason}</p>
                  {approvable(d) && (
                    <p className="approval-terms">
                      Approves exactly {money(d.amount, d.currency, 2)} (about {whole(d.amountUSD)}). If any term changes, it comes back to you.
                    </p>
                  )}
                </div>
                {approvable(d) ? (
                  <button className="btn btn-primary" data-tour-step={d.kind === 'convert' || d.kind === 'pay' ? 'approve' : undefined} disabled={!!busy} onClick={() => onApprove(d.id)}>
                    {busy === `approve-${d.id}` ? 'Approving…' : 'Approve exactly this'}
                  </button>
                ) : (
                  <span className="chip chip-md">Stays held until there&apos;s a budget</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- what changed

function Changes({ run }: { run: RunView }) {
  const last = run.last!;
  const all = [...run.decisions, ...run.doneToday];
  const name = (id: string) => {
    const d = all.find((x) => x.id === id);
    return d ? `${d.label} ${money(d.amount, d.currency, 2)}${d.job ? `, Job ${d.job}` : ''}` : id;
  };
  const executed = new Set(last.executed);
  return (
    <section data-tour="changes" aria-labelledby="changes-title">
      <div className="section-head">
        <h2 id="changes-title">What just happened</h2>
        <span className="section-note">Only the decisions the new facts moved</span>
      </div>
      <p className="change-head">{last.headline}</p>
      {(last.changes.length > 0 || last.executed.length > 0) && (
        <ul className="changes">
          {last.executed.map((id) => (
            <li className="change" key={`x-${id}`}>
              <span className="change-kind" data-c="added">
                Done
              </span>
              <span className="change-detail">{name(id)}</span>
            </li>
          ))}
          {last.changes
            .filter((c) => !(c.change === 'removed' && executed.has(c.id)))
            .map((c) => (
              <li className="change" key={`${c.change}-${c.id}`}>
                <span className="change-kind" data-c={c.change}>
                  {c.change === 'added' ? 'New' : c.change === 'changed' ? 'Changed' : 'Dropped'}
                </span>
                <span className="change-detail">
                  {name(c.id)}
                  {c.fields.map((f) => (
                    <span key={f.field}>
                      {' '}
                      ({describeField(f.field, f.before, f.after)})
                    </span>
                  ))}
                </span>
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

function describeField(field: string, before: unknown, after: unknown): string {
  if (field === 'execution') return after === 'approval' ? 'now needs the MD' : 'can now run on its own';
  if (field === 'status') return after === 'now' ? 'ready to run' : 'now waiting';
  if (field === 'dependsOn') return 'waits on something different';
  if (field === 'amount') return `amount ${String(before)} to ${String(after)}`;
  return `${field} changed`;
}

// ---------------------------------------------------------------- decisions

function statusChip(d: DecisionView, run: RunView) {
  if (d.done && d.kind === 'early_pay_link') {
    const paid = run.links.find((l) => l.receivableId === d.target)?.status === 'paid';
    return <span className="chip chip-done">{paid ? 'Paid' : 'Sent'}</span>;
  }
  if (d.done && d.kind === 'ask_split') {
    const agreed = !run.decisions.some((x) => x.id === d.id);
    return <span className="chip chip-done">{agreed ? 'Agreed' : 'Sent'}</span>;
  }
  if (d.done) return <span className="chip chip-done">Done</span>;
  if (d.execution === 'approval' && !d.approved) return <span className="chip chip-md">Needs the MD</span>;
  if (d.status === 'now') return <span className="chip chip-ready">Ready</span>;
  return <span className="chip chip-wait">Waiting</span>;
}

function Decisions({ run, busy, onReplay }: { run: RunView; busy: string | null; onReplay: (id: string) => void }) {
  const rows = [...run.decisions, ...run.doneToday.map((d) => ({ ...d, done: true }))];
  return (
    <section data-tour="decisions" aria-labelledby="decisions-title">
      <div className="section-head">
        <h2 id="decisions-title">Decisions</h2>
        <span className="section-note">Money, limits and order are code. Each one replays from its stored inputs.</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Decision</th>
              <th style={{ textAlign: 'right' }}>Amount</th>
              <th>Status</th>
              <th>Why</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <td>
                  <div className="decision-name">{d.label}</div>
                  <div className="project">{d.project ? `Job ${d.job}, ${d.project}` : d.kind === 'convert' ? `Buy ${d.currency}` : d.kind === 'escalate_gap' ? 'Whole business' : 'Overheads'}</div>
                </td>
                <td className="num">{money(d.amount, d.currency, 2)}</td>
                <td>{statusChip(d, run)}</td>
                <td className="reason">{d.reason}</td>
                <td>
                  <button className="btn btn-quiet" disabled={!!busy} onClick={() => onReplay(d.id)} aria-label={`Replay ${d.label} ${d.target}`}>
                    Replay
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- payments, outbox, recon, signals

function Payments({ run }: { run: RunView }) {
  return (
    <section data-tour="payments" aria-labelledby="pay-title">
      <div className="section-head">
        <h2 id="pay-title">Money moved</h2>
        <span className="section-note">{run.mode === 'live' ? 'Real PayPal sandbox payouts' : 'Simulated payouts'}</span>
      </div>
      {run.payments.length === 0 && run.links.length === 0 ? (
        <p className="muted">Nothing has gone out yet.</p>
      ) : (
        <ul className="plain">
          {run.payments.map((p) => (
            <li key={`${p.payableId}-${p.transferId}`}>
              <div className="row-top">
                <strong>{p.supplier}</strong>
                <span>{money(p.amount, p.currency, 2)}</span>
              </div>
              <div className="row-top">
                <span className="faint">
                  {p.method}
                  {p.replaces ? ', replacement' : ''}
                  {p.failureType ? `, ${p.failureType.replace(/_/g, ' ').toLowerCase()}` : ''}
                </span>
                <span className={`chip ${p.status === 'CANCELLED' || p.status === 'FAILED' ? 'chip-bad' : p.status === 'PAID' ? 'chip-done' : 'chip-wait'}`}>
                  {p.status.toLowerCase()}
                </span>
              </div>
            </li>
          ))}
          {run.links.map((l) => (
            <li key={l.receivableId}>
              <div className="row-top">
                <strong>{l.customer}</strong>
                <span>{money(l.amount, l.currency, 2)} in</span>
              </div>
              <div className="row-top">
                <span className="faint">Early-pay link</span>
                <span className={`chip ${l.status === 'paid' ? 'chip-done' : 'chip-wait'}`}>{l.status === 'paid' ? 'paid' : 'sent'}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Outbox({ run }: { run: RunView }) {
  return (
    <section data-tour="outbox" aria-labelledby="outbox-title">
      <div className="section-head">
        <h2 id="outbox-title">Messages sent</h2>
      </div>
      {run.outbox.length === 0 ? (
        <p className="muted">No messages yet.</p>
      ) : (
        run.outbox.map((m, i) => (
          <details className="mail" key={i}>
            <summary>
              <span>
                <strong>{m.subject}</strong>
                <span className="faint" style={{ display: 'block' }}>
                  to {m.to}
                </span>
              </span>
              <span className={`chip ${m.by === 'claude' ? 'chip-ready' : 'chip-wait'}`}>{m.by === 'claude' ? 'Claude, numbers checked' : 'Template'}</span>
            </summary>
            <div className="mail-body">{m.body}</div>
            {m.rejected && <p className="faint" style={{ marginTop: 6 }}>Claude&apos;s draft was not used: it {m.rejected}.</p>}
          </details>
        ))
      )}
    </section>
  );
}

function Recon({ run }: { run: RunView }) {
  return (
    <section data-tour="recon" aria-labelledby="recon-title">
      <div className="section-head">
        <h2 id="recon-title">Overnight bank lines</h2>
        <span className="section-note">
          {run.recon.auto} of {run.recon.total} matched automatically
        </span>
      </div>
      <ul className="plain">
        {run.recon.notable.map((r) => (
          <li key={r.lineId}>
            <div className="row-top">
              <strong>{r.kind === 'multi' ? 'One payment, two invoices' : r.kind === 'instalment' ? 'Instalment, not a duplicate' : r.kind === 'fx_difference' ? 'Bank charges' : r.kind === 'short' ? 'Short payment' : 'Unknown deposit'}</strong>
              <span className={`chip ${r.needsPerson ? 'chip-md' : 'chip-done'}`}>{r.needsPerson ? 'needs a person' : 'matched'}</span>
            </div>
            <span className="muted">{r.explanation}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Signals({ run }: { run: RunView }) {
  return (
    <section data-tour="signals" aria-labelledby="signals-title">
      <div className="section-head">
        <h2 id="signals-title">What the emails said</h2>
        <span className="section-note">{run.claude ? 'Read by Claude, checked against the book' : 'Read from fixtures in this demo'}</span>
      </div>
      <ul className="plain">
        {run.signals.map((s, i) => (
          <li key={i}>
            <div className="row-top">
              <strong>{s.kind.replace(/_/g, ' ')}</strong>
              <span className="faint">{s.from}</span>
            </div>
            <span className="muted">&ldquo;{s.evidence}&rdquo;</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CustomEmail({ busy, onSend }: { busy: string | null; onSend: (m: { from: string; subject: string; body: string }) => void }) {
  const [from, setFrom] = useState('accounts@calderfinch.example');
  const [subject, setSubject] = useState('Stage 2 invoice');
  const [body, setBody] = useState('');
  return (
    <section aria-labelledby="custom-title">
      <div className="section-head">
        <h2 id="custom-title">Try your own email</h2>
        <span className="section-note">Claude reads it into one checked fact; code decides what it means</span>
      </div>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) onSend({ from, subject, body });
        }}
      >
        <input className="field" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input className="field" aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
        <textarea
          className="email"
          aria-label="Email body"
          placeholder="e.g. Sorry, we can't pay the stage 2 invoice until the end of the month."
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={2000}
        />
        <div>
          <button className="btn" disabled={!!busy || !body.trim()}>
            {busy === 'custom' ? 'Reading…' : 'Have Reckon read it'}
          </button>
        </div>
      </form>
    </section>
  );
}

function Log({ run }: { run: RunView }) {
  return (
    <details>
      <summary className="muted" style={{ cursor: 'pointer' }}>
        Activity log ({run.log.length} latest)
      </summary>
      <ul className="plain" style={{ marginTop: 12 }}>
        {run.log.map((l, i) => (
          <li key={i}>
            <span className="faint">{new Date(l.at).toLocaleTimeString('en-GB')}</span>
            <span className="muted">{l.text}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

// ---------------------------------------------------------------- rail

const BUTTON: Partial<Record<StepView['id'], string>> = {
  delay_email: 'Deliver the email',
  run_0900: 'Run the 09:00 cut-off',
  approve: 'Approve as shown',
  customer_pays: 'Customer pays the link',
  split_reply: 'Deliver the reply',
  chase: 'Deliver the chase',
  replay: 'Replay it',
};

function Steps({ run, busy, onAct }: { run: RunView; busy: string | null; onAct: (a: Action, label: string) => void }) {
  return (
    <section data-tour="steps" aria-labelledby="steps-title">
      <div className="section-head">
        <h2 id="steps-title">The story, one step at a time</h2>
      </div>
      <ol className="steps">
        {run.steps.map((s) => (
          <li className="step" data-state={s.state} key={s.id} aria-current={s.state === 'next' ? 'step' : undefined}>
            <div className="step-title">{s.title}</div>
            {s.state !== 'done' && <p className="step-detail">{s.detail}</p>}
            {s.state === 'next' && (
              <div className="step-actions">
                {s.link && (
                  <a className="btn btn-agent" href={s.link} target="_blank" rel="noreferrer">
                    Open the payment link
                  </a>
                )}
                {s.action && (
                  <button className={s.link ? 'btn' : 'btn btn-agent'} data-tour-step={s.id === 'approve' ? undefined : s.id} disabled={!!busy} onClick={() => onAct(s.action!, `step-${s.id}`)}>
                    {busy === `step-${s.id}` ? 'Working…' : s.link ? 'Check payment now' : (BUTTON[s.id] ?? 'Go')}
                  </button>
                )}
                {!s.action && s.id === 'approve' && <span className="faint">Approve in the MD&apos;s brief.</span>}
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Proof({ run, busy, onReplay }: { run: RunView; busy: string | null; onReplay: (id: string, tamper: boolean) => void }) {
  const target = [...run.doneToday, ...run.decisions].find((d) => d.id === 'pay:PAY-114-FREIGHT') ?? run.decisions[0];
  return (
    <section className="proof" data-tour="proof" aria-labelledby="proof-title">
      <div className="section-head">
        <h2 id="proof-title">Replay</h2>
      </div>
      <p className="muted">Re-runs the planner on a decision&apos;s stored inputs. A tampered copy fails the hash check.</p>
      {target && (
        <div className="step-actions">
          <button className="btn" data-tour-step="replay-proof" disabled={!!busy} onClick={() => onReplay(target.id, false)}>
            Replay {target.label.toLowerCase()}
          </button>
          <button className="btn btn-quiet" data-tour-step="tamper" disabled={!!busy} onClick={() => onReplay(target.id, true)}>
            Try a tampered copy
          </button>
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        {run.replays.map((r, i) => (
          <div className="replay-row" key={i}>
            <div className="row-top">
              <span>
                {r.decisionId}
                {r.tampered ? ' (tampered)' : ''}
              </span>
              <span className={`chip ${r.ok ? 'chip-done' : 'chip-bad'}`}>{r.ok ? 'identical' : r.reason}</span>
            </div>
            <span className="hash">{r.hash}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
