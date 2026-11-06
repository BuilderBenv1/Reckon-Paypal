import delayEmail from '../../data/emails/01-westfield-delay.json' with { type: 'json' };
import splitEmail from '../../data/emails/02-pennine-split-yes.json' with { type: 'json' };
import chaseEmail from '../../data/emails/03-brightline-not-received.json' with { type: 'json' };
import remittanceEmail from '../../data/emails/04-harbour-remittance.json' with { type: 'json' };
import { defaultPolicy, seedBalances, seedBook, seedRates } from '../domain/seed.js';
import type { Email, EmailSignal } from '../domain/types.js';
import { FakeAirwallex, type FakeSnapshot } from '../airwallex/fake.js';
import { OperatingEnvelope, type EnvelopeSnapshot } from '../airwallex/envelope.js';
import type { AirwallexPort, SandboxSimulator, TransferView } from '../airwallex/port.js';
import { AirwallexRest } from '../airwallex/rest.js';
import { ClaudeReader, FixtureReader, type EmailReader } from '../agent/reader.js';
import { ClaudeDrafter, TemplateDrafter, type Drafter } from '../agent/drafter.js';
import { Reckon, type ReckonSnapshot } from '../agent/reckon.js';
import { initialState } from '../policy/state.js';
import type { DecisionChange } from '../policy/diff.js';
import { replay as replayRecord } from '../policy/replay.js';
import { reconcile } from '../recon/match.js';
import { buildReconFixture } from '../recon/fixture.js';
import type { MatchResult } from '../recon/types.js';
import { CHASED_PAYABLE, setupReturnedInstalment } from './incident.js';

// One run of the Reckon story, saved between requests. Demo runs use an in-memory Airwallex and
// can be clicked through by anyone; live runs make real sandbox calls through the operating
// envelope and receive Airwallex webhooks.

export type Mode = 'demo' | 'live';

export type StepId = 'morning' | 'delay_email' | 'run_0900' | 'approve' | 'customer_pays' | 'split_reply' | 'chase' | 'replay';

export type Action =
  | { type: 'delay_email' }
  | { type: 'run' }
  | { type: 'approve'; decisionId: string }
  | { type: 'customer_pays' }
  | { type: 'check_links' }
  | { type: 'split_reply' }
  | { type: 'chase' }
  | { type: 'replay'; decisionId: string; tamper?: boolean }
  | { type: 'custom_email'; from: string; subject: string; body: string }
  | { type: 'sync_transfer'; transferId: string };

export interface ReplayView {
  decisionId: string;
  tampered: boolean;
  ok: boolean;
  reason?: string;
  detail?: string;
  hash: string;
}

export interface ActionResult {
  action: Action['type'];
  at: string;
  headline: string;
  executed: string[];
  changes: DecisionChange[];
}

export interface SessionView {
  recon: MatchResult[];
  last: ActionResult | null;
  incident: { outcome: string; original?: TransferView; replacement?: TransferView; reason?: string } | null;
  replays: ReplayView[];
  signals: { from: string; signal: EmailSignal }[];
  drafts: Record<number, { by: 'claude' | 'template'; rejected?: string }>;
}

export interface SessionSnapshot {
  version: 1;
  mode: Mode;
  createdAt: string;
  done: StepId[];
  reckon: ReckonSnapshot;
  awx: { kind: 'fake'; s: FakeSnapshot } | { kind: 'envelope'; s: EnvelopeSnapshot };
  view: SessionView;
  claudeCalls: number;
}

/** Most Claude calls one run may make, so a public demo can't run up a bill. */
export const CLAUDE_CALL_LIMIT = 40;

const EMAILS = { delay: delayEmail, split: splitEmail, chase: chaseEmail, remittance: remittanceEmail } satisfies Record<string, Email>;

export function loadEmail(which: keyof typeof EMAILS): Email {
  return structuredClone(EMAILS[which]);
}

export interface SessionDeps {
  /** Override the live Airwallex client (tests). */
  live?: () => AirwallexPort & SandboxSimulator;
  claude?: boolean;
  reader?: EmailReader;
  drafter?: Drafter;
  clock?: () => string;
}

const claudeConfigured = () => !!process.env.ANTHROPIC_API_KEY;
export const liveConfigured = () => !!process.env.AWX_CLIENT_ID && !!process.env.AWX_API_KEY;

type AwxAdapter = (FakeAirwallex | OperatingEnvelope) & AirwallexPort & SandboxSimulator;

export class Session {
  private constructor(
    public snap: Omit<SessionSnapshot, 'reckon' | 'awx'>,
    public reckon: Reckon,
    public awx: AwxAdapter,
    private readonly drafter: Drafter,
    private readonly usesClaude: boolean,
  ) {}

  static async create(mode: Mode, deps: SessionDeps = {}): Promise<Session> {
    const clock = deps.clock ?? (() => new Date().toISOString());
    const awx: AwxAdapter =
      mode === 'demo' ? new FakeAirwallex({ ...seedBalances }, seedRates) : new OperatingEnvelope((deps.live ?? AirwallexRest.fromEnv)(), seedBalances);
    const s = Session.wire(
      {
        version: 1,
        mode,
        createdAt: clock(),
        done: [],
        view: { recon: [], last: null, incident: null, replays: [], signals: [], drafts: {} },
        claudeCalls: 0,
      },
      (reader) => new Reckon(initialState(structuredClone(seedBook), { ...seedBalances }, seedRates), defaultPolicy, awx, reader, clock),
      awx,
      deps,
    );
    await s.morning();
    return s;
  }

  static restore(snap: SessionSnapshot, deps: SessionDeps = {}): Session {
    const clock = deps.clock ?? (() => new Date().toISOString());
    const awx: AwxAdapter =
      snap.awx.kind === 'fake'
        ? FakeAirwallex.restore(snap.awx.s, seedRates)
        : OperatingEnvelope.restore((deps.live ?? AirwallexRest.fromEnv)(), snap.awx.s);
    const { reckon: r, awx: _a, ...rest } = snap;
    return Session.wire(rest, (reader) => Reckon.restore(r, defaultPolicy, awx, reader, clock), awx, deps);
  }

  private static wire(
    snap: Omit<SessionSnapshot, 'reckon' | 'awx'>,
    makeReckon: (reader: EmailReader) => Reckon,
    awx: AwxAdapter,
    deps: SessionDeps,
  ): Session {
    const usesClaude = deps.claude ?? claudeConfigured();
    let session: Session | null = null;
    let claudeReader: ClaudeReader | null = null; // created on first use: it needs the API key
    // Count Claude calls and stop at the limit, so a public demo stays cheap.
    const reader: EmailReader = deps.reader ?? {
      read: async (email, book) => {
        if (!usesClaude || !session || session.snap.claudeCalls >= CLAUDE_CALL_LIMIT) return new FixtureReader().read(email, book);
        session.snap.claudeCalls += 1;
        claudeReader ??= new ClaudeReader();
        return claudeReader.read(email, book);
      },
    };
    const drafter = deps.drafter ?? (usesClaude ? new ClaudeDrafter() : new TemplateDrafter());
    session = new Session(snap, makeReckon(reader), awx, drafter, usesClaude);
    return session;
  }

  snapshot(): SessionSnapshot {
    return structuredClone({ ...this.snap, reckon: this.reckon.snapshot(), awx: this.awx instanceof FakeAirwallex ? { kind: 'fake' as const, s: this.awx.snapshot() } : { kind: 'envelope' as const, s: this.awx.snapshot() } });
  }

  get mode(): Mode {
    return this.snap.mode;
  }

  get claudeOn(): boolean {
    return this.usesClaude && this.snap.claudeCalls < CLAUDE_CALL_LIMIT;
  }

  /** Airwallex object ids this run owns, so webhooks can find it. */
  refs(): string[] {
    const ids = new Set<string>();
    for (const linkId of this.reckon.links.values()) ids.add(linkId);
    for (const a of this.reckon.ledger.attempts) if (a.transferId) ids.add(a.transferId);
    return [...ids];
  }

  private mark(step: StepId) {
    if (!this.snap.done.includes(step)) this.snap.done.push(step);
  }

  private result(action: Action['type'], headline: string, executed: string[], changes: DecisionChange[]) {
    this.snap.view.last = { action, at: new Date().toISOString(), headline, executed, changes };
  }

  private async ingest(email: Email) {
    const signal = await this.reckon.ingestEmail(email);
    this.snap.view.signals.push({ from: email.from, signal });
    return signal;
  }

  /** Has Claude reword any outgoing message not yet drafted; numbers stay the template's. */
  private async draftOutbox() {
    for (let i = 0; i < this.reckon.outbox.length; i++) {
      if (this.snap.view.drafts[i]) continue;
      const m = this.reckon.outbox[i]!;
      if (this.usesClaude && this.snap.claudeCalls < CLAUDE_CALL_LIMIT) this.snap.claudeCalls += 1;
      else {
        this.snap.view.drafts[i] = { by: 'template' };
        continue;
      }
      const d = await this.drafter.draft(m);
      m.body = d.body;
      this.snap.view.drafts[i] = d.rejected ? { by: d.by, rejected: d.rejected } : { by: d.by };
    }
  }

  private async morning() {
    await this.reckon.refreshBalances();
    const remittance = await this.ingest(loadEmail('remittance'));
    this.snap.view.recon = reconcile(buildReconFixture(), [remittance]);
    const { plan } = this.reckon.plan();
    this.mark('morning');
    const auto = this.snap.view.recon.filter((r) => !r.needsPerson).length;
    this.result(
      'run',
      `Morning read: ${auto} of ${this.snap.view.recon.length} bank lines reconciled automatically, gap ${plan.summary.gapUSD <= 0 ? 'covered' : `of USD ${plan.summary.gapUSD}`}.`,
      [],
      [],
    );
  }

  async act(action: Action): Promise<void> {
    switch (action.type) {
      case 'delay_email': {
        const signal = await this.ingest(loadEmail('delay'));
        const { plan, changes } = this.reckon.plan();
        this.mark('delay_email');
        this.result(
          action.type,
          signal.kind === 'receipt_delayed'
            ? `Westfield's milestone slips. Forecast confidence is now ${plan.summary.forecastConfidence}; ${changes.length} decisions changed.`
            : `Read the email but found no delay (${signal.kind}).`,
          [],
          changes,
        );
        return;
      }
      case 'run': {
        const r = await this.reckon.run();
        await this.draftOutbox();
        if (this.snap.done.includes('delay_email')) this.mark('run_0900');
        this.result(action.type, r.executed.length ? `Executed ${r.executed.length} decisions within policy.` : 'Nothing new to execute.', r.executed, r.changes);
        return;
      }
      case 'approve': {
        // Approve the decision as it stands now, which is what the MD is looking at.
        this.reckon.plan();
        this.reckon.approve(action.decisionId, 'MD');
        const r = await this.reckon.run();
        await this.draftOutbox();
        if (action.decisionId.startsWith('convert:')) this.mark('approve');
        this.result(action.type, `MD approved ${action.decisionId} exactly as shown. Executed ${r.executed.length} decisions.`, r.executed, r.changes);
        return;
      }
      case 'customer_pays': {
        if (!(this.awx instanceof FakeAirwallex)) throw new Error('In a live run the customer pays the real payment link.');
        const linkId = this.reckon.links.get('REC-121-INV');
        if (!linkId) throw new Error('No payment link has been sent yet.');
        await this.awx.payLink(linkId);
        await this.afterLinkCheck();
        return;
      }
      case 'check_links':
        await this.afterLinkCheck();
        return;
      case 'split_reply': {
        await this.ingest(loadEmail('split'));
        const r = await this.reckon.run();
        await this.draftOutbox();
        this.mark('split_reply');
        this.result(action.type, `Supplier agreed to split. Executed ${r.executed.length} decisions.`, r.executed, r.changes);
        return;
      }
      case 'chase': {
        if (this.reckon.ledger.attemptsFor(CHASED_PAYABLE).length === 0) await setupReturnedInstalment(this.reckon, this.awx);
        await this.ingest(loadEmail('chase'));
        const out = await this.reckon.handleNotReceived(CHASED_PAYABLE);
        const again = await this.reckon.handleNotReceived(CHASED_PAYABLE);
        this.snap.view.incident =
          out.outcome === 'replaced'
            ? { outcome: out.outcome, original: out.original, replacement: out.replacement }
            : out.outcome === 'blocked'
              ? { outcome: out.outcome, reason: out.reason }
              : { outcome: out.outcome, original: out.transfer };
        this.mark('chase');
        this.result(
          action.type,
          out.outcome === 'replaced'
            ? `The original transfer came back (account closed). Reckon sent one replacement; when the supplier chased again it found that replacement ${again.outcome === 'in_flight' ? 'already on its way' : again.outcome.replace(/_/g, ' ')} and paid nothing.`
            : `Checked Airwallex first: the payment is ${out.outcome.replace(/_/g, ' ')}. No new payment.`,
          [],
          [],
        );
        return;
      }
      case 'replay': {
        const rec = this.reckon.ledger.latestRecord(action.decisionId);
        if (!rec) throw new Error(`No record of ${action.decisionId}`);
        const target = action.tamper ? { ...structuredClone(rec), policy: { ...rec.policy, autonomousFxLimitUSD: { high: 50000, low: 50000 } } } : rec;
        const r = replayRecord(target);
        this.snap.view.replays = [
          { decisionId: action.decisionId, tampered: !!action.tamper, ok: r.ok, ...(r.ok ? {} : { reason: r.reason, detail: r.detail }), hash: rec.hash },
          ...this.snap.view.replays,
        ].slice(0, 6);
        this.mark('replay');
        return;
      }
      case 'custom_email': {
        if (!this.claudeOn) throw new Error('Reading your own email needs Claude, which is not available for this run.');
        const body = action.body.slice(0, 2000);
        const signal = await this.ingest({ id: `custom-${Date.now()}`, from: action.from.slice(0, 120) || 'unknown', subject: action.subject.slice(0, 200), body });
        const { changes } = this.reckon.plan();
        this.result(
          action.type,
          signal.kind === 'none' ? `Claude read it and found nothing that changes the plan.` : `Claude read it as ${signal.kind.replace(/_/g, ' ')}; ${changes.length} decisions changed.`,
          [],
          changes,
        );
        return;
      }
      case 'sync_transfer': {
        await this.reckon.syncTransfer(action.transferId);
        return;
      }
    }
  }

  private async afterLinkCheck() {
    const paid = await this.reckon.checkLinks();
    if (!paid.length) {
      this.result('check_links', 'Payment link not paid yet.', [], []);
      return;
    }
    const r = await this.reckon.run();
    await this.draftOutbox();
    this.mark('customer_pays');
    this.result('customer_pays', `Customer paid early by payment link. Replanned and executed ${r.executed.length} decisions.`, r.executed, r.changes);
  }
}
