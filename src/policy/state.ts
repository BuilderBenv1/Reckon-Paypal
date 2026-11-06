import type { Balances, EmailSignal, FinanceBook, Payable, Rates, Receivable } from '../domain/types.js';

/**
 * Everything the planner is allowed to look at. A plan is a pure function of this
 * object plus the policy, which is what makes every decision replayable.
 */
export interface CashState {
  book: FinanceBook;
  balances: Balances;
  rates: Rates;
  /** Structured facts extracted from emails, in the order they arrived. */
  signals: EmailSignal[];
  /** Payables already paid in full (ids). */
  paid: string[];
  /** Early-pay payment links already sent, by receivable id. */
  earlyPayLinks: Record<string, 'sent' | 'paid'>;
  /** Split requests already sent to suppliers, by payable id. */
  splitAsks: string[];
}

export interface ResolvedBook {
  payables: Payable[];
  receivables: (Receivable & { delayed: boolean })[];
  /** Payable ids whose supplier has agreed to split. */
  splitAgreed: Set<string>;
  splitDeclined: Set<string>;
  /** True once any receipt in the horizon has been reported late. */
  forecastShaken: boolean;
}

const SPLIT_SECOND_PART_DAY = 14;

/** Applies email signals and settled items to the finance team's book. Pure. */
export function resolveBook(state: CashState, splitShareNow: number): ResolvedBook {
  const delays = new Map<string, number>();
  const splitAgreed = new Set<string>();
  const splitDeclined = new Set<string>();
  for (const s of state.signals) {
    if (s.kind === 'receipt_delayed') delays.set(s.receivableId, s.newExpectedDay);
    if (s.kind === 'split_accepted') splitAgreed.add(s.payableId);
    if (s.kind === 'split_declined') splitDeclined.add(s.payableId);
  }

  const payables: Payable[] = [];
  for (const p of state.book.payables) {
    if (splitAgreed.has(p.id)) {
      const now = Math.round(p.amount * splitShareNow * 100) / 100;
      for (const [suffix, amount, dueDay, label] of [
        ['A', now, p.dueDay, 'first part'],
        ['B', Math.round((p.amount - now) * 100) / 100, SPLIT_SECOND_PART_DAY, 'second part'],
      ] as const) {
        const part: Payable = { ...p, id: `${p.id}-${suffix}`, amount, dueDay, acceptsSplit: false, note: `Agreed split: ${label} of ${p.id}` };
        if (!state.paid.includes(part.id)) payables.push(part);
      }
      continue;
    }
    if (!state.paid.includes(p.id)) payables.push(p);
  }

  const receivables = state.book.receivables
    .filter((r) => state.earlyPayLinks[r.id] !== 'paid')
    .map((r) => {
      const newDay = delays.get(r.id);
      return newDay === undefined ? { ...r, delayed: false } : { ...r, expectedDay: newDay, delayed: true };
    });

  return { payables, receivables, splitAgreed, splitDeclined, forecastShaken: delays.size > 0 };
}

export function initialState(book: FinanceBook, balances: Balances, rates: Rates): CashState {
  return { book, balances, rates, signals: [], paid: [], earlyPayLinks: {}, splitAsks: [] };
}
