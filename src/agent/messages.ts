import type { Payable, Policy, Receivable } from '../domain/types.js';
import { fmt } from '../policy/money.js';
import type { Plan } from '../policy/plan.js';

// Outgoing messages. Templates keep the offline demo deterministic; in the live demo the
// model can rewrite these in the business's own voice, but the numbers come from here.

export function splitAsk(p: Payable, policy: Policy): { to: string; subject: string; body: string } {
  const now = Math.round(p.amount * policy.splitShareNow * 100) / 100;
  return {
    to: p.supplier,
    subject: `Invoice for ${p.description.toLowerCase()}: payment in two parts?`,
    body:
      `Hi,\n\nCould we pay this one in two parts, like we did last year? ` +
      `${fmt(now, p.currency)} goes out as soon as you confirm, and the remaining ` +
      `${fmt(Math.round((p.amount - now) * 100) / 100, p.currency)} two weeks later.\n\nThanks,\nAccounts`,
  };
}

export function earlyPayOffer(r: Receivable, linkAmount: number, url: string, policy: Policy) {
  return {
    to: r.customerEmail,
    subject: `${r.milestone}: ${(policy.earlyPayDiscount * 100).toFixed(1)}% off if paid today`,
    body:
      `Hi,\n\nYour invoice for ${r.milestone.toLowerCase()} (${fmt(r.amount, r.currency)}) is due in ${r.expectedDay} days. ` +
      `If it suits you to settle early, you can pay ${fmt(linkAmount, r.currency)} today through this secure link and keep the difference:\n\n${url}\n\n` +
      `No action needed if you'd rather pay on the usual terms.\n\nThanks,\nAccounts`,
  };
}

/** The MD's daily brief: one paragraph and only the decisions that need them. */
export function mdBrief(plan: Plan, pendingApprovals: { id: string; reason: string }[]): string {
  const s = plan.summary;
  const lines = [
    `Cash is ${fmt(s.cashUSD, 'USD')} against a reserve floor of ${fmt(s.reserveFloorUSD, 'USD')}. ` +
      `${fmt(s.dueInHorizonUSD, 'USD')} is due in the next three days` +
      (s.heldUSD ? `, plus ${fmt(s.heldUSD, 'USD')} I've held back` : '') +
      `. ` +
      (s.gapUSD > 0
        ? `That leaves us ${fmt(s.gapUSD, 'USD')} short; I can close it for ${fmt(s.leversCostUSD, 'USD')}` +
          (s.gapAfterLeversUSD > 0 ? `, but ${fmt(s.gapAfterLeversUSD, 'USD')} still needs your call.` : '.')
        : `We can cover it without touching the floor.`) +
      ` Forecast confidence is ${s.forecastConfidence}.`,
  ];
  if (pendingApprovals.length) {
    lines.push('', 'Needs you:');
    for (const a of pendingApprovals) lines.push(`- ${a.reason}`);
  } else {
    lines.push('', 'Nothing needs you today.');
  }
  return lines.join('\n');
}
