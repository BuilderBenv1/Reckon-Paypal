import type { Currency, Payable, Policy, Receivable } from '../domain/types.js';
import { cashUSD, fmt, obligationUSD, payoutFeeEUR, round2, toUSD } from './money.js';
import { resolveBook, type CashState } from './state.js';

export type DecisionKind = 'pay' | 'hold' | 'defer' | 'ask_split' | 'early_pay_link' | 'convert' | 'escalate_gap';

export interface Decision {
  /** Stable key, e.g. "pay:PAY-114-FREIGHT", so plans can be diffed and replayed. */
  id: string;
  kind: DecisionKind;
  target: string;
  amount: number;
  currency: Currency;
  amountUSD: number;
  /** auto = within policy, the agent acts alone; approval = goes in the MD brief. */
  execution: 'auto' | 'approval';
  /** now = can run today; waiting = needs another decision or an outside event first. */
  status: 'now' | 'waiting';
  dependsOn: string[];
  /** Name of the policy rule that produced it. */
  rule: string;
  reason: string;
}

export interface RankedPayable {
  payableId: string;
  unlockUSD: number;
  delayCostUSD: number;
  scoreUSD: number;
}

export interface Plan {
  policyVersion: string;
  summary: {
    cashUSD: number;
    reserveFloorUSD: number;
    dueInHorizonUSD: number;
    heldUSD: number;
    expectedReceiptsUSD: number;
    gapUSD: number;
    leversCostUSD: number;
    gapAfterLeversUSD: number;
    forecastConfidence: 'high' | 'low';
  };
  ranking: RankedPayable[];
  decisions: Decision[];
}

interface Lever {
  decision: Decision;
  costUSD: number;
  freesUSD: number;
  inPlay: boolean;
}

/**
 * The planner. Pure: same state + policy in, same plan out. Money, limits and ordering
 * all live here; the model never does arithmetic or decides what is allowed.
 */
export function plan(state: CashState, policy: Policy): Plan {
  const { rates } = state;
  const book = resolveBook(state, policy.splitShareNow);
  const confidence: 'high' | 'low' = book.forecastShaken ? 'low' : 'high';
  const decisions: Decision[] = [];
  const projects = new Map(state.book.projects.map((p) => [p.job, p]));
  const receivables = new Map(book.receivables.map((r) => [r.id, r]));

  const inHorizon = book.payables.filter((p) => p.dueDay <= policy.horizonDays);

  // 1. Budget guard: no quoted budget, over budget, or a new payee -> hold for the MD.
  const held = new Set<string>();
  for (const p of inHorizon) {
    const reasons: string[] = [];
    const project = p.job ? projects.get(p.job) : undefined;
    const usd = obligationUSD(p, rates, policy);
    if (project && project.budgetUSD === null) reasons.push(`Job ${project.job} has no quoted budget`);
    if (project && project.budgetUSD !== null && project.committedCostUSD + usd > project.budgetUSD) {
      reasons.push(`it would take Job ${project.job} to ${fmt(round2(project.committedCostUSD + usd), 'USD')} against a ${fmt(project.budgetUSD, 'USD')} budget`);
    }
    if (p.newPayee) reasons.push(`${p.supplier} is a new payee`);
    if (reasons.length) {
      held.add(p.id);
      decisions.push({
        id: `hold:${p.id}`,
        kind: 'hold',
        target: p.id,
        amount: p.amount,
        currency: p.currency,
        amountUSD: usd,
        execution: 'approval',
        status: 'waiting',
        dependsOn: [],
        rule: 'budget_guard',
        reason: `Held for the MD: ${reasons.join('; ')}.`,
      });
    }
  }

  // 2. Rank what's left by what paying it unlocks, plus what delay would cost.
  const payable = inHorizon.filter((p) => !held.has(p.id));
  const ranking: RankedPayable[] = payable
    .map((p) => {
      const unlocked = p.unlocksReceivableId ? receivables.get(p.unlocksReceivableId) : undefined;
      const unlockUSD = unlocked && unlocked.status === 'blocked' ? toUSD(unlocked.amount, unlocked.currency, rates) : 0;
      return { payableId: p.id, unlockUSD, delayCostUSD: p.deferPenaltyUSD, scoreUSD: round2(unlockUSD + p.deferPenaltyUSD) };
    })
    .sort((a, b) => b.scoreUSD - a.scoreUSD || a.payableId.localeCompare(b.payableId));
  const byId = new Map(payable.map((p) => [p.id, p]));

  // 3. The gap: what's due, against cash above the floor plus receipts we trust.
  const cash = cashUSD(state.balances, rates);
  const dueUSD = round2(payable.reduce((s, p) => s + obligationUSD(p, rates, policy), 0));
  const heldUSD = round2(inHorizon.filter((p) => held.has(p.id)).reduce((s, p) => s + obligationUSD(p, rates, policy), 0));
  const trusted = book.receivables.filter(
    (r) => r.status === 'invoiced' && r.expectedDay <= policy.horizonDays && r.onTimeRate >= policy.receiptConfidenceThreshold && !r.delayed,
  );
  const expectedReceiptsUSD = round2(trusted.reduce((s, r) => s + toUSD(r.amount, r.currency, rates), 0));
  const gapUSD = round2(dueUSD - (cash - policy.reserveFloorUSD) - expectedReceiptsUSD);

  // 4. Close the gap with the cheapest levers. Levers already in play count first.
  const levers = candidateLevers(state, policy, payable, book.receivables, book.splitAgreed, book.splitDeclined, ranking);
  const chosen: Lever[] = [];
  const touched = new Set<string>();
  let remaining = gapUSD;
  const take = (l: Lever) => {
    chosen.push(l);
    touched.add(l.decision.target);
    remaining = round2(remaining - l.freesUSD);
  };
  levers.filter((l) => l.inPlay).forEach(take);
  for (const l of levers.filter((l) => !l.inPlay).sort(byCostPerDollar)) {
    if (remaining <= 0) break;
    if (touched.has(l.decision.target)) continue; // one lever per bill or invoice
    take(l);
  }
  const leversCostUSD = round2(chosen.reduce((s, l) => s + l.costUSD, 0));
  decisions.push(...chosen.map((l) => l.decision));
  if (remaining > 0) {
    decisions.push({
      id: 'escalate:gap',
      kind: 'escalate_gap',
      target: 'cash',
      amount: remaining,
      currency: 'USD',
      amountUSD: remaining,
      execution: 'approval',
      status: 'now',
      dependsOn: [],
      rule: 'unresolved_gap',
      reason: `Even after every lever, ${fmt(remaining, 'USD')} is still short of the reserve floor. The MD needs to choose what waits.`,
    });
  }

  // 5. Fund in rank order from cash we actually hold. Nothing jumps the queue.
  const deferred = new Set(chosen.filter((l) => l.decision.kind === 'defer').map((l) => l.decision.target));
  const splitPending = new Set(chosen.filter((l) => l.decision.kind === 'ask_split').map((l) => l.decision.target));
  const cashLevers = chosen.filter((l) => l.decision.kind === 'early_pay_link').map((l) => l.decision.id);
  const receiptWaits = trusted.map((r) => `receipt:${r.id}`);
  let spendable = round2(cash - policy.reserveFloorUSD);
  let blocked = false;
  const payNow: Payable[] = [];
  for (const r of ranking) {
    const p = byId.get(r.payableId)!;
    if (deferred.has(p.id)) continue;
    const usd = obligationUSD(p, rates, policy);
    const base = {
      id: `pay:${p.id}`,
      kind: 'pay' as const,
      target: p.id,
      amount: p.amount,
      currency: p.currency,
      amountUSD: usd,
      execution: usd > policy.autonomousPaymentLimitUSD ? ('approval' as const) : ('auto' as const),
      rule: 'fund_by_unlock_value',
    };
    const rank = ranking.indexOf(r) + 1;
    const why = r.unlockUSD > 0
      ? `ranked ${rank} because paying it releases ${fmt(r.unlockUSD, 'USD')} on Job ${p.job}`
      : r.delayCostUSD > 0
        ? `ranked ${rank}; delaying it costs ${fmt(r.delayCostUSD, 'USD')} a week`
        : `ranked ${rank}; nothing depends on it and delay costs nothing`;
    if (splitPending.has(p.id)) {
      // Keep its place in the queue: reserve the share we'll pay once they agree.
      const reserve = round2(usd * policy.splitShareNow);
      if (!blocked && reserve <= spendable) spendable = round2(spendable - reserve);
      else blocked = true;
      decisions.push({ ...base, status: 'waiting', dependsOn: [`ask_split:${p.id}`], reason: `Waiting for ${p.supplier} to reply to the split request; ${why}.` });
      continue;
    }
    if (!blocked && usd <= spendable) {
      spendable = round2(spendable - usd);
      payNow.push(p);
      decisions.push({ ...base, status: 'now', dependsOn: [], reason: `Pay ${fmt(p.amount, p.currency)} to ${p.supplier}: ${why}.` });
    } else {
      blocked = true;
      decisions.push({
        ...base,
        status: 'waiting',
        dependsOn: [...cashLevers, ...receiptWaits],
        reason: `Waiting for cash to land before paying ${p.supplier}; ${why}.`,
      });
    }
  }

  // 6. Convert only the currency today's payments need, fees included.
  const need: Partial<Record<Currency, number>> = {};
  for (const p of payNow) {
    if (p.currency === 'USD') continue;
    need[p.currency] = round2((need[p.currency] ?? 0) + p.amount + (p.currency === 'EUR' ? payoutFeeEUR(p, policy) : 0));
  }
  for (const cur of Object.keys(need).sort() as Currency[]) {
    const shortfall = round2(need[cur]! - state.balances[cur]);
    if (shortfall <= 0) continue;
    const usd = toUSD(shortfall, cur, rates);
    const limit = policy.autonomousFxLimitUSD[confidence];
    const convertId = `convert:${cur}`;
    decisions.push({
      id: convertId,
      kind: 'convert',
      target: cur,
      amount: shortfall,
      currency: cur,
      amountUSD: usd,
      execution: usd > limit ? 'approval' : 'auto',
      status: 'now',
      dependsOn: [],
      rule: 'convert_minimum',
      reason:
        `Buy ${fmt(shortfall, cur)} (about ${fmt(usd, 'USD')}), only what today's ${cur} payments need` +
        (cur === 'EUR' && payNow.some((p) => p.currency === 'EUR' && p.method === 'SWIFT') ? ', SWIFT fees included' : '') +
        `. Autonomous limit is ${fmt(limit, 'USD')} at ${confidence} forecast confidence` +
        (usd > limit ? ', so it needs approval.' : '.'),
    });
    for (const d of decisions) if (d.kind === 'pay' && d.status === 'now' && d.currency === cur) d.dependsOn.push(convertId);
  }

  return {
    policyVersion: policy.version,
    summary: {
      cashUSD: cash,
      reserveFloorUSD: policy.reserveFloorUSD,
      dueInHorizonUSD: dueUSD,
      heldUSD,
      expectedReceiptsUSD,
      gapUSD,
      leversCostUSD,
      gapAfterLeversUSD: remaining,
      forecastConfidence: confidence,
    },
    ranking,
    decisions,
  };
}

function candidateLevers(
  state: CashState,
  policy: Policy,
  payables: Payable[],
  receivables: (Receivable & { delayed: boolean })[],
  splitAgreed: Set<string>,
  splitDeclined: Set<string>,
  ranking: RankedPayable[],
): Lever[] {
  const { rates } = state;
  const levers: Lever[] = [];
  const unlocks = new Map(ranking.map((r) => [r.payableId, r.unlockUSD]));

  for (const p of payables) {
    const usd = obligationUSD(p, rates, policy);
    // Never defer something that unlocks cash elsewhere.
    if ((unlocks.get(p.id) ?? 0) === 0) {
      levers.push({
        costUSD: p.deferPenaltyUSD,
        freesUSD: usd,
        inPlay: false,
        decision: {
          id: `defer:${p.id}`, kind: 'defer', target: p.id, amount: p.amount, currency: p.currency, amountUSD: usd,
          execution: 'auto', status: 'now', dependsOn: [], rule: 'defer_cheapest',
          reason: p.deferPenaltyUSD === 0
            ? `Defer ${p.supplier} (${fmt(p.amount, p.currency)}): costs nothing to delay${p.note ? ` (${p.note.toLowerCase()})` : ''}.`
            : `Defer ${p.supplier} (${fmt(p.amount, p.currency)}): costs ${fmt(p.deferPenaltyUSD, 'USD')} for a week's delay.`,
        },
      });
    }
    if (p.acceptsSplit && !splitAgreed.has(p.id) && !splitDeclined.has(p.id)) {
      const frees = round2(usd * (1 - policy.splitShareNow));
      levers.push({
        costUSD: policy.splitAskCostUSD,
        freesUSD: frees,
        inPlay: state.splitAsks.includes(p.id),
        decision: {
          id: `ask_split:${p.id}`, kind: 'ask_split', target: p.id, amount: p.amount, currency: p.currency, amountUSD: usd,
          execution: 'auto', status: state.splitAsks.includes(p.id) ? 'waiting' : 'now', dependsOn: [], rule: 'ask_split',
          reason: state.splitAsks.includes(p.id)
            ? `Asked ${p.supplier} to split ${fmt(p.amount, p.currency)}; waiting for their reply.`
            : `Ask ${p.supplier} to take ${Math.round(policy.splitShareNow * 100)}% now and the rest in two weeks: frees about ${fmt(frees, 'USD')} this week. They have agreed before.`,
        },
      });
    }
  }

  for (const r of receivables) {
    if (r.status !== 'invoiced' || !r.earlyPayEligible || r.expectedDay <= policy.horizonDays) continue;
    const sent = state.earlyPayLinks[r.id] === 'sent';
    const usd = toUSD(r.amount, r.currency, rates);
    const discount = round2(usd * policy.earlyPayDiscount);
    const linkAmount = round2(r.amount * (1 - policy.earlyPayDiscount));
    levers.push({
      costUSD: discount,
      freesUSD: round2(usd - discount),
      inPlay: sent,
      decision: {
        id: `early_pay_link:${r.id}`, kind: 'early_pay_link', target: r.id, amount: linkAmount, currency: r.currency,
        amountUSD: round2(usd - discount),
        execution: discount > policy.autonomousDiscountLimitUSD ? 'approval' : 'auto',
        status: sent ? 'waiting' : 'now', dependsOn: [], rule: 'early_pay_discount',
        reason: sent
          ? `Payment link for ${fmt(linkAmount, r.currency)} sent to ${r.customer}; waiting for payment.`
          : `Offer ${r.customer} ${(policy.earlyPayDiscount * 100).toFixed(1)}% (${fmt(discount, 'USD')}) to pay ${fmt(r.amount, r.currency)} today by payment link instead of in ${r.expectedDay} days. They pay on time ${Math.round(r.onTimeRate * 100)}% of the time.`,
      },
    });
  }
  return levers;
}

const byCostPerDollar = (a: Lever, b: Lever) =>
  a.costUSD / a.freesUSD - b.costUSD / b.freesUSD || a.decision.id.localeCompare(b.decision.id);
