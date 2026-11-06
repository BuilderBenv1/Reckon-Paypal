import type { Balances, Currency, Payable, Policy, Rates } from '../domain/types.js';

export const round2 = (n: number) => Math.round(n * 100) / 100;

export const toUSD = (amount: number, currency: Currency, rates: Rates) => round2(amount * rates[currency]);

export const cashUSD = (balances: Balances, rates: Rates) =>
  round2((Object.keys(balances) as Currency[]).reduce((s, c) => s + balances[c] * rates[c], 0));

/** SWIFT payouts cost a flat EUR fee from the same wallet; LOCAL payouts are free. */
export const payoutFeeEUR = (p: Pick<Payable, 'method'>, policy: Policy) => (p.method === 'SWIFT' ? policy.swiftFeeEUR : 0);

/** Full USD cost of settling a payable now, including any SWIFT fee. */
export const obligationUSD = (p: Payable, rates: Rates, policy: Policy) =>
  round2(p.amount * rates[p.currency] + payoutFeeEUR(p, policy) * rates.EUR);

export const fmt = (amount: number, currency: Currency) =>
  `${currency} ${amount.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
