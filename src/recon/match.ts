import type { EmailSignal } from '../domain/types.js';
import type { BankLine, MatchResult, OpenInvoice, ReconFixture } from './types.js';

const PENNY = 0.005;
/** Bank-charge shortfall on a foreign-currency receipt we accept without a person. */
const FX_TOLERANCE_SHARE = 0.01;
const FX_TOLERANCE_ABS = 50;

const eq = (a: number, b: number) => Math.abs(a - b) < PENNY;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Deterministic reconciliation. Every rule is code; the model's only input is
 * structured signals extracted from emails (e.g. a remittance note explaining a short payment).
 */
export function reconcile(fixture: ReconFixture, signals: EmailSignal[] = []): MatchResult[] {
  const open = new Map(fixture.invoices.map((i) => [i.id, i]));
  const results: MatchResult[] = [];
  const explained = new Map(
    signals.filter((s) => s.kind === 'short_payment_explained').map((s) => [s.receivableId, s.reason] as const),
  );

  // Oldest lines first so instalments are matched in order.
  const lines = [...fixture.lines].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  for (const line of lines) {
    const result =
      matchByReference(line, open, explained) ??
      matchInstalment(line, open) ??
      matchCombination(line, open) ?? {
        lineId: line.id,
        kind: 'unmatched' as const,
        invoiceIds: [],
        difference: line.amount,
        needsPerson: true,
        explanation: line.reference
          ? `No open invoice matches reference "${line.reference}" or amount ${line.amount.toFixed(2)} ${line.currency}.`
          : `No reference and no open invoice from "${line.payer}" for ${line.amount.toFixed(2)} ${line.currency}. Left for a person.`,
      };
    for (const id of result.invoiceIds) open.delete(id);
    results.push(result);
  }
  return results;
}

function matchByReference(line: BankLine, open: Map<string, OpenInvoice>, explained: Map<string, string>): MatchResult | null {
  const inv = line.reference ? open.get(line.reference.trim()) : undefined;
  if (!inv || inv.currency !== line.currency) return null;
  const diff = round2(line.amount - inv.amount);
  if (eq(diff, 0)) {
    return { lineId: line.id, kind: 'exact', invoiceIds: [inv.id], difference: 0, needsPerson: false, explanation: `Matches ${inv.id} exactly.` };
  }
  if (diff < 0 && line.currency !== 'USD' && -diff <= Math.min(inv.amount * FX_TOLERANCE_SHARE, FX_TOLERANCE_ABS)) {
    return {
      lineId: line.id,
      kind: 'fx_difference',
      invoiceIds: [inv.id],
      difference: diff,
      needsPerson: false,
      explanation: `${inv.id} settled with ${(-diff).toFixed(2)} ${line.currency} short, within the bank-charge tolerance; written off to FX and charges.`,
    };
  }
  if (diff < 0) {
    const reason = explained.get(inv.id);
    return {
      lineId: line.id,
      kind: 'short',
      invoiceIds: [inv.id],
      difference: diff,
      needsPerson: !reason,
      explanation: reason
        ? `${inv.id} paid ${(-diff).toFixed(2)} ${line.currency} short. Customer's remittance says: ${reason}. Balance left open as a disputed item.`
        : `${inv.id} paid ${(-diff).toFixed(2)} ${line.currency} short with no explanation. Needs a person.`,
    };
  }
  return null;
}

function matchInstalment(line: BankLine, open: Map<string, OpenInvoice>): MatchResult | null {
  const candidates = [...open.values()]
    .filter((i) => i.instalment && line.reference.includes(i.instalment.plan) && i.currency === line.currency && eq(i.amount, line.amount))
    .sort((a, b) => a.instalment!.n - b.instalment!.n);
  const inv = candidates[0];
  if (!inv || !inv.instalment) return null;
  const looksDuplicate = inv.instalment.n > 1;
  return {
    lineId: line.id,
    kind: 'instalment',
    invoiceIds: [inv.id],
    difference: 0,
    needsPerson: false,
    explanation: looksDuplicate
      ? `Same payer, amount and reference as an earlier payment, but it is instalment ${inv.instalment.n} of ${inv.instalment.of} on ${inv.instalment.plan}, not a duplicate.`
      : `Instalment ${inv.instalment.n} of ${inv.instalment.of} on ${inv.instalment.plan}.`,
  };
}

function matchCombination(line: BankLine, open: Map<string, OpenInvoice>): MatchResult | null {
  const mine = [...open.values()].filter((i) => i.customer === line.payer && i.currency === line.currency && !i.instalment);
  // Pairs and triples are enough for real remittances; anything bigger goes to a person.
  for (let a = 0; a < mine.length; a++) {
    for (let b = a + 1; b < mine.length; b++) {
      const pair = [mine[a]!, mine[b]!];
      if (eq(pair[0]!.amount + pair[1]!.amount, line.amount)) return combo(line, pair);
      for (let c = b + 1; c < mine.length; c++) {
        const triple = [...pair, mine[c]!];
        if (eq(triple.reduce((s, i) => s + i.amount, 0), line.amount)) return combo(line, triple);
      }
    }
  }
  return null;
}

function combo(line: BankLine, invs: OpenInvoice[]): MatchResult {
  return {
    lineId: line.id,
    kind: 'multi',
    invoiceIds: invs.map((i) => i.id),
    difference: 0,
    needsPerson: false,
    explanation: `One payment settles ${invs.map((i) => i.id).join(' + ')} (${invs.map((i) => i.amount.toFixed(2)).join(' + ')}).`,
  };
}
