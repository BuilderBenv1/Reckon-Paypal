import type { Email, EmailSignal, Payable, Policy } from '../domain/types.js';
import { payees } from '../domain/payees.js';
import { isDeadTransfer, type AirwallexPort, type TransferView } from '../airwallex/port.js';
import { Ledger, DuplicatePaymentError, type LedgerSnapshot, type PaymentAttempt } from '../ledger/ledger.js';
import { plan as buildPlan, type Decision, type Plan } from '../policy/plan.js';
import { diffPlans, type DecisionChange } from '../policy/diff.js';
import { replay, type ReplayResult } from '../policy/replay.js';
import { resolveBook, type CashState } from '../policy/state.js';
import { canonical } from '../policy/replay.js';
import { fmt } from '../policy/money.js';
import type { EmailReader } from './reader.js';
import { earlyPayOffer, mdBrief, splitAsk } from './messages.js';

export interface OutboxMessage {
  decisionId: string;
  to: string;
  subject: string;
  body: string;
}

export interface LogEntry {
  at: string;
  kind: 'plan' | 'execute' | 'skip' | 'email' | 'approve' | 'incident' | 'link';
  text: string;
}

export interface ReckonSnapshot {
  state: CashState;
  ledger: LedgerSnapshot;
  outbox: OutboxMessage[];
  log: LogEntry[];
  links: [string, string][];
  lastPlan: Plan | null;
}

export type IncidentOutcome =
  | { outcome: 'already_paid'; transfer: TransferView }
  | { outcome: 'in_flight'; transfer: TransferView }
  | { outcome: 'replaced'; original: TransferView; replacement: TransferView }
  | { outcome: 'blocked'; reason: string };

/**
 * The agent loop: plan (pure), record, execute what policy allows, and react to the world.
 * Every money movement goes through the ledger's lock and the policy engine's decision.
 */
export class Reckon {
  ledger = new Ledger();
  outbox: OutboxMessage[] = [];
  log: LogEntry[] = [];
  links = new Map<string, string>();
  lastPlan: Plan | null = null;

  constructor(
    public state: CashState,
    readonly policy: Policy,
    private readonly awx: AirwallexPort,
    private readonly reader: EmailReader,
    private readonly clock: () => string,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** Everything needed to carry on later in another process (serverless requests). */
  snapshot(): ReckonSnapshot {
    return structuredClone({
      state: this.state,
      ledger: this.ledger.snapshot(),
      outbox: this.outbox,
      log: this.log,
      links: [...this.links],
      lastPlan: this.lastPlan,
    });
  }

  static restore(
    s: ReckonSnapshot,
    policy: Policy,
    awx: AirwallexPort,
    reader: EmailReader,
    clock: () => string,
    newId?: () => string,
  ): Reckon {
    const c = structuredClone(s);
    const r = new Reckon(c.state, policy, awx, reader, clock, newId);
    r.ledger = Ledger.restore(c.ledger);
    r.outbox = c.outbox;
    r.log = c.log;
    r.links = new Map(c.links);
    r.lastPlan = c.lastPlan;
    return r;
  }

  /** Re-reads one transfer (e.g. after a webhook) and records its latest status. */
  async syncTransfer(transferId: string): Promise<TransferView | null> {
    const attempt = this.ledger.attempts.find((a) => a.transferId === transferId);
    if (!attempt) return null;
    const t = await this.awx.getTransfer(transferId);
    if (t.status !== attempt.status) {
      this.ledger.updateAttempt(attempt.requestId, { status: t.status, ...(t.failureType ? { failureType: t.failureType } : {}) });
      this.note('execute', `${attempt.payableId}: Airwallex reports ${t.status}${t.failureType ? ` (${t.failureType})` : ''}.`);
    }
    if (t.status === 'PAID' || isDeadTransfer(t.status)) await this.refreshBalances();
    return t;
  }

  private note(kind: LogEntry['kind'], text: string) {
    this.log.push({ at: this.clock(), kind, text });
  }

  async refreshBalances() {
    this.state.balances = await this.awx.balances();
  }

  /** Plans from the current state, records every decision, and returns what changed. */
  plan(): { plan: Plan; changes: DecisionChange[] } {
    const next = buildPlan(this.state, this.policy);
    const changes = this.lastPlan ? diffPlans(this.lastPlan, next) : [];
    for (const d of next.decisions) {
      const prev = this.ledger.latestRecord(d.id);
      if (!prev || canonical(prev.decision) !== canonical(d)) this.ledger.record(this.state, this.policy, d, this.clock());
    }
    this.lastPlan = next;
    this.note('plan', `Planned ${next.decisions.length} decisions; gap ${fmt(next.summary.gapUSD, 'USD')}, confidence ${next.summary.forecastConfidence}.`);
    return { plan: next, changes };
  }

  /**
   * Replans from the current state, then executes. Approvals carry over only if the
   * decision's terms are still identical; anything that moved needs approving again.
   */
  async run(): Promise<{ plan: Plan; changes: DecisionChange[]; executed: string[]; awaitingApproval: Decision[] }> {
    const { plan, changes } = this.plan();
    return { plan, changes, ...(await this.execute(plan)) };
  }

  /** Executes every decision in this plan that is due now and allowed, in a safe order. */
  async execute(p: Plan): Promise<{ executed: string[]; awaitingApproval: Decision[] }> {
    if (p !== this.lastPlan) throw new Error('Refusing to execute a stale plan; call run() to replan first.');
    const executed: string[] = [];
    const awaitingApproval: Decision[] = [];
    const done = new Set(this.ledger.executed);
    const order: Decision['kind'][] = ['convert', 'pay', 'ask_split', 'early_pay_link', 'defer'];
    const runnable = p.decisions
      .filter((d) => d.status === 'now' && order.includes(d.kind))
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

    for (const d of runnable) {
      if (d.execution === 'approval' && !this.ledger.isApproved(d)) {
        awaitingApproval.push(d);
        this.note('skip', `${d.id} needs approval.`);
        continue;
      }
      const blockedBy = d.dependsOn.filter((dep) => dep.startsWith('convert:') && !done.has(dep));
      if (blockedBy.length) {
        this.note('skip', `${d.id} waits for ${blockedBy.join(', ')}.`);
        continue;
      }
      await this.carryOut(d);
      done.add(d.id);
      this.ledger.executed.add(d.id);
      executed.push(d.id);
    }
    await this.refreshBalances();
    for (const d of p.decisions) {
      if (d.kind === 'hold' || d.kind === 'escalate_gap') {
        if (!this.ledger.isApproved(d)) awaitingApproval.push(d);
      }
    }
    return { executed, awaitingApproval };
  }

  private async carryOut(d: Decision) {
    const book = resolveBook(this.state, this.policy.splitShareNow);
    switch (d.kind) {
      case 'convert': {
        const quote = await this.awx.quote('USD', d.currency, d.amount);
        await this.awx.convert({ requestId: this.newId(), quote });
        await this.refreshBalances();
        this.note('execute', `Converted to ${fmt(d.amount, d.currency)} at ${quote.clientRate.toFixed(4)}.`);
        return;
      }
      case 'pay': {
        const payable = book.payables.find((x) => x.id === d.target);
        if (!payable) throw new Error(`Unknown payable ${d.target}`);
        await this.pay(payable);
        this.state.paid.push(payable.id);
        return;
      }
      case 'ask_split': {
        const payable = book.payables.find((x) => x.id === d.target)!;
        this.outbox.push({ decisionId: d.id, ...splitAsk(payable, this.policy) });
        this.state.splitAsks.push(payable.id);
        this.note('execute', `Asked ${payable.supplier} to split ${fmt(payable.amount, payable.currency)}.`);
        return;
      }
      case 'early_pay_link': {
        const r = book.receivables.find((x) => x.id === d.target)!;
        const link = await this.awx.createPaymentLink({ title: `${r.customer}: ${r.milestone}`, amount: d.amount, currency: d.currency, reference: r.id });
        try {
          await this.awx.notifyShopper(link.id, r.customerEmail);
        } catch (err) {
          // The link still works; the offer email in the outbox carries it either way.
          this.note('link', `Airwallex could not email ${r.customerEmail} (${(err as Error).message.slice(0, 80)}); link sent in our own email.`);
        }
        this.links.set(r.id, link.id);
        this.outbox.push({ decisionId: d.id, ...earlyPayOffer(r, d.amount, link.url, this.policy) });
        this.state.earlyPayLinks[r.id] = 'sent';
        this.note('link', `Payment link for ${fmt(d.amount, d.currency)} sent to ${r.customer}.`);
        return;
      }
      case 'defer':
        this.note('execute', d.reason);
        return;
      default:
        return;
    }
  }

  /** Sends one payment under the duplicate lock. Never retries blind. */
  async pay(p: Payable, replaces?: string): Promise<TransferView> {
    const payee = payees[p.supplier];
    if (!payee) throw new Error(`No bank details for ${p.supplier}`);
    const requestId = this.newId();
    this.ledger.beginPayment(p.id, requestId, this.clock(), replaces);
    const beneficiaryId = await this.awx.ensureBeneficiary(payee);
    const reference = p.id;
    this.ledger.updateAttempt(requestId, { details: { supplier: p.supplier, beneficiaryId, amount: p.amount, currency: p.currency, method: p.method, reference } });
    let t: TransferView;
    try {
      t = await this.awx.createTransfer({ requestId, beneficiaryId, amount: p.amount, currency: p.currency, method: p.method, reference, reason: payee.reason });
    } catch (err) {
      // Ambiguous failure: look the request up before anything else, so a retry can't pay twice.
      const found = await this.awx.findTransferByRequestId(requestId);
      if (!found) {
        this.ledger.updateAttempt(requestId, { status: 'CANCELLED', failureType: 'NOT_CREATED' });
        throw err;
      }
      t = found;
    }
    this.ledger.updateAttempt(requestId, { transferId: t.id, status: t.status });
    this.note('execute', `Paid ${fmt(p.amount, p.currency)} to ${p.supplier} (${t.id}, ${t.status}).`);
    return t;
  }

  /** Reads an email into one typed signal; the planner decides what it means. */
  async ingestEmail(email: Email): Promise<EmailSignal> {
    const signal = await this.reader.read(email, this.state.book);
    this.note('email', `${email.from}: ${signal.kind}${'evidence' in signal ? ` ("${signal.evidence}")` : ''}`);
    if (signal.kind !== 'none') this.state.signals.push(signal);
    return signal;
  }

  approve(decisionId: string, by: string) {
    const d = this.lastPlan?.decisions.find((x) => x.id === decisionId);
    if (!d) throw new Error(`No decision ${decisionId} in the current plan`);
    this.ledger.approve(d, by, this.clock());
    this.note('approve', `${by} approved ${decisionId} as shown: ${d.reason}`);
  }

  /** Polls sent payment links (the live build uses the payment_intent.succeeded webhook). */
  async checkLinks(): Promise<string[]> {
    const paid: string[] = [];
    for (const [receivableId, linkId] of this.links) {
      if (this.state.earlyPayLinks[receivableId] !== 'sent') continue;
      const link = await this.awx.getPaymentLink(linkId);
      if (link.status === 'PAID') {
        this.state.earlyPayLinks[receivableId] = 'paid';
        paid.push(receivableId);
        this.note('link', `${receivableId} paid ${fmt(link.amount, link.currency)} by payment link.`);
      }
    }
    if (paid.length) await this.refreshBalances();
    return paid;
  }

  /**
   * A supplier says a payment never arrived. Check the real transfer state before doing
   * anything; replace only a payment Airwallex has definitely cancelled, and record both.
   */
  async handleNotReceived(payableId: string): Promise<IncidentOutcome> {
    const attempts = this.ledger.attemptsFor(payableId);
    const last = attempts.at(-1);
    if (!last?.transferId || !last.details) return { outcome: 'blocked', reason: `No record of a payment for ${payableId}; needs a person.` };
    const t = await this.awx.getTransfer(last.transferId);
    this.ledger.updateAttempt(last.requestId, { status: t.status, ...(t.failureType ? { failureType: t.failureType } : {}) });
    if (t.status === 'PAID') {
      this.note('incident', `${payableId}: Airwallex shows PAID; replied with the transfer reference, no new payment.`);
      return { outcome: 'already_paid', transfer: t };
    }
    if (!isDeadTransfer(t.status)) {
      this.note('incident', `${payableId}: still ${t.status}; not paying again while it's in flight.`);
      return { outcome: 'in_flight', transfer: t };
    }
    const d = last.details;
    const replacementPayable: Payable = {
      id: payableId, job: null, supplier: d.supplier, description: `Replacement for ${t.id}`, amount: d.amount, currency: d.currency,
      dueDay: 0, method: d.method, newPayee: false, acceptsSplit: false, deferPenaltyUSD: 0,
    };
    try {
      const replacement = await this.pay(replacementPayable, last.requestId);
      this.note('incident', `${payableId}: original ${t.id} was ${t.failureType ?? 'cancelled'}; sent replacement ${replacement.id} with a new request id.`);
      return { outcome: 'replaced', original: t, replacement };
    } catch (err) {
      if (err instanceof DuplicatePaymentError) return { outcome: 'blocked', reason: err.message };
      throw err;
    }
  }

  replay(decisionId: string): ReplayResult {
    const rec = this.ledger.latestRecord(decisionId);
    if (!rec) return { ok: false, reason: 'missing', detail: `No record of ${decisionId}` };
    return replay(rec);
  }

  brief(): string {
    if (!this.lastPlan) return 'No plan yet.';
    const pending = this.lastPlan.decisions.filter((d) => d.execution === 'approval' && !this.ledger.isApproved(d));
    return mdBrief(this.lastPlan, pending);
  }

  paymentAttempts(): PaymentAttempt[] {
    return [...this.ledger.attempts];
  }
}
