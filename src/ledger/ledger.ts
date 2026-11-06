import type { Policy } from '../domain/types.js';
import type { TransferStatus } from '../airwallex/port.js';
import type { Decision } from '../policy/plan.js';
import { canonical, recordDecision, sha256, type DecisionRecord } from '../policy/replay.js';
import type { CashState } from '../policy/state.js';

export interface Approval {
  decisionId: string;
  termsHash: string;
  terms: ApprovalTerms;
  approvedBy: string;
  at: string;
}

/** What the approver saw. An approval is only valid while these stay identical. */
export interface ApprovalTerms {
  id: string;
  kind: Decision['kind'];
  target: string;
  amount: number;
  currency: Decision['currency'];
  amountUSD: number;
  reason: string;
}

export interface PaymentAttempt {
  payableId: string;
  requestId: string;
  /** What was sent, so a replacement uses identical terms. */
  details?: { supplier: string; beneficiaryId: string; amount: number; currency: Decision['currency']; method: 'LOCAL' | 'SWIFT'; reference: string };
  transferId: string | null;
  status: TransferStatus | 'REQUESTED';
  failureType?: string;
  replaces?: string;
  at: string;
}

export class DuplicatePaymentError extends Error {
  constructor(readonly payableId: string, readonly existing: PaymentAttempt) {
    super(`Refusing to pay ${payableId} again: attempt ${existing.requestId} is ${existing.status}.`);
  }
}

const TERMINAL_FAILED: PaymentAttempt['status'][] = ['FAILED', 'CANCELLED'];

export const termsOf = (d: Decision): ApprovalTerms => ({
  id: d.id, kind: d.kind, target: d.target, amount: d.amount, currency: d.currency, amountUSD: d.amountUSD, reason: d.reason,
});

export interface LedgerSnapshot {
  records: DecisionRecord[];
  approvals: [string, Approval][];
  attempts: PaymentAttempt[];
  executed: string[];
}

/** Decision ledger, approvals bound to exact terms, and the never-pay-twice lock. */
export class Ledger {
  records: DecisionRecord[] = [];
  approvals = new Map<string, Approval>();
  attempts: PaymentAttempt[] = [];
  executed = new Set<string>();

  snapshot(): LedgerSnapshot {
    return structuredClone({ records: this.records, approvals: [...this.approvals], attempts: this.attempts, executed: [...this.executed] });
  }

  static restore(s: LedgerSnapshot): Ledger {
    const l = new Ledger();
    const c = structuredClone(s);
    l.records = c.records;
    l.approvals = new Map(c.approvals);
    l.attempts = c.attempts;
    l.executed = new Set(c.executed);
    return l;
  }

  get head(): string {
    return this.records.at(-1)?.hash ?? 'genesis';
  }

  record(state: CashState, policy: Policy, decision: Decision, at: string): DecisionRecord {
    const rec = recordDecision(state, policy, decision, this.head, at);
    this.records.push(rec);
    return rec;
  }

  latestRecord(decisionId: string): DecisionRecord | undefined {
    return [...this.records].reverse().find((r) => r.decisionId === decisionId);
  }

  /** Checks every record's hash and the chain between them. */
  verifyChain(): { ok: boolean; brokenAt?: number } {
    let prev = 'genesis';
    for (let i = 0; i < this.records.length; i++) {
      const r = this.records[i]!;
      const expected = sha256(canonical({ state: r.state, policy: r.policy, decision: r.decision, prevHash: r.prevHash }));
      if (r.prevHash !== prev || r.hash !== expected) return { ok: false, brokenAt: i };
      prev = r.hash;
    }
    return { ok: true };
  }

  approve(decision: Decision, approvedBy: string, at: string): Approval {
    const terms = termsOf(decision);
    const a = { decisionId: decision.id, termsHash: sha256(canonical(terms)), terms, approvedBy, at };
    this.approvals.set(decision.id, a);
    return a;
  }

  /** True only if this exact decision, with these exact terms, was approved. */
  isApproved(decision: Decision): boolean {
    const a = this.approvals.get(decision.id);
    return !!a && a.termsHash === sha256(canonical(termsOf(decision)));
  }

  attemptsFor(payableId: string): PaymentAttempt[] {
    return this.attempts.filter((a) => a.payableId === payableId);
  }

  /**
   * Takes the payment lock. Refuses while any earlier attempt is in flight or paid; a
   * replacement is allowed only after the previous attempt has definitely failed.
   */
  beginPayment(payableId: string, requestId: string, at: string, replaces?: string): PaymentAttempt {
    const live = this.attemptsFor(payableId).find((a) => !TERMINAL_FAILED.includes(a.status));
    if (live) throw new DuplicatePaymentError(payableId, live);
    const attempt: PaymentAttempt = { payableId, requestId, transferId: null, status: 'REQUESTED', at };
    if (replaces) attempt.replaces = replaces;
    this.attempts.push(attempt);
    return attempt;
  }

  updateAttempt(requestId: string, patch: Partial<Pick<PaymentAttempt, 'transferId' | 'status' | 'failureType' | 'details'>>) {
    const a = this.attempts.find((x) => x.requestId === requestId);
    if (!a) throw new Error(`No payment attempt ${requestId}`);
    Object.assign(a, patch);
    return a;
  }
}
