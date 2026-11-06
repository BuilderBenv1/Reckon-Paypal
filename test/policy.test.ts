import { describe, expect, it } from 'vitest';
import { defaultPolicy, seedBalances, seedBook, seedRates } from '../src/domain/seed.js';
import { plan } from '../src/policy/plan.js';
import { diffPlans } from '../src/policy/diff.js';
import { initialState, type CashState } from '../src/policy/state.js';
import { replay, recordDecision } from '../src/policy/replay.js';

const fresh = (): CashState => initialState(structuredClone(seedBook), { ...seedBalances }, { ...seedRates });
const delayed = (): CashState => {
  const s = fresh();
  s.signals.push({ kind: 'receipt_delayed', receivableId: 'REC-109-M3', newExpectedDay: 8, evidence: 'next Tuesday' });
  return s;
};
const ids = (s: CashState) => plan(s, defaultPolicy).decisions.map((d) => d.id);

describe('budget guard', () => {
  it('holds a bill on a job with no quoted budget for the MD, whatever the cash position', () => {
    const p = plan(fresh(), defaultPolicy);
    const hold = p.decisions.find((d) => d.id === 'hold:PAY-117-DEPOSIT');
    expect(hold?.execution).toBe('approval');
    expect(hold?.reason).toMatch(/no quoted budget/);
    expect(ids(fresh())).not.toContain('pay:PAY-117-DEPOSIT');
  });

  it('holds a bill that would take a job over its budget', () => {
    const s = fresh();
    s.book.projects.find((p) => p.job === '109')!.committedCostUSD = 84000;
    const hold = plan(s, defaultPolicy).decisions.find((d) => d.id === 'hold:PAY-109-SUB');
    expect(hold?.reason).toMatch(/against a USD 85,000 budget/);
  });
});

describe('ranking by unlock value', () => {
  it('ranks the freight first because paying it releases a $24,000 milestone', () => {
    const p = plan(fresh(), defaultPolicy);
    expect(p.ranking[0]).toMatchObject({ payableId: 'PAY-114-FREIGHT', unlockUSD: 24000 });
  });

  it('never offers to defer a payment that unlocks cash elsewhere', () => {
    expect(ids(delayed())).not.toContain('defer:PAY-114-FREIGHT');
  });

  it('funds strictly in rank order: nothing jumps the queue', () => {
    const p = plan(fresh(), defaultPolicy);
    const status = Object.fromEntries(p.decisions.filter((d) => d.kind === 'pay').map((d) => [d.target, d.status]));
    expect(status).toEqual({ 'PAY-114-FREIGHT': 'now', 'PAY-109-SUB': 'now', 'PAY-121-COMP': 'waiting', 'PAY-OH-SAAS': 'waiting' });
  });
});

describe('closing the gap', () => {
  it('needs no levers while the customer receipt is trusted', () => {
    const p = plan(fresh(), defaultPolicy);
    expect(p.summary.gapUSD).toBeLessThan(0);
    expect(p.decisions.some((d) => ['defer', 'ask_split', 'early_pay_link'].includes(d.kind))).toBe(false);
  });

  it('picks the cheapest levers once the receipt slips, and closes the gap', () => {
    const p = plan(delayed(), defaultPolicy);
    expect(p.summary.gapUSD).toBeCloseTo(3229.01, 2);
    expect(p.decisions.filter((d) => ['defer', 'ask_split', 'early_pay_link'].includes(d.kind)).map((d) => d.id)).toEqual([
      'defer:PAY-OH-SAAS', 'ask_split:PAY-121-COMP', 'early_pay_link:REC-121-INV',
    ]);
    expect(p.summary.leversCostUSD).toBe(200);
    expect(p.summary.gapAfterLeversUSD).toBeLessThanOrEqual(0);
  });

  it('uses at most one lever per bill or invoice', () => {
    const targets = plan(delayed(), defaultPolicy)
      .decisions.filter((d) => ['defer', 'ask_split', 'early_pay_link'].includes(d.kind))
      .map((d) => d.target);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('escalates to the MD when no lever can close the gap', () => {
    const s = delayed();
    s.balances = { USD: 2000, EUR: 0, GBP: 0 };
    const gap = plan(s, defaultPolicy).decisions.find((d) => d.kind === 'escalate_gap');
    expect(gap?.execution).toBe('approval');
  });

  it('sends the discount offer for approval when it exceeds the autonomous limit', () => {
    const p = plan(delayed(), { ...defaultPolicy, autonomousDiscountLimitUSD: 100 });
    expect(p.decisions.find((d) => d.kind === 'early_pay_link')?.execution).toBe('approval');
  });
});

describe('FX', () => {
  it('converts only what today\'s payments need, SWIFT fee included', () => {
    const c = plan(fresh(), defaultPolicy).decisions.find((d) => d.id === 'convert:EUR')!;
    expect(c.amount).toBeCloseTo(5400 + 12.85 - 2000, 2);
  });

  it('lowers the autonomous FX limit when forecast confidence drops', () => {
    expect(plan(fresh(), defaultPolicy).decisions.find((d) => d.id === 'convert:EUR')?.execution).toBe('auto');
    expect(plan(delayed(), defaultPolicy).decisions.find((d) => d.id === 'convert:EUR')?.execution).toBe('approval');
  });
});

describe('diff and replay', () => {
  it('shows exactly which decisions the delay email changed', () => {
    const changes = diffPlans(plan(fresh(), defaultPolicy), plan(delayed(), defaultPolicy));
    expect(changes.map((c) => `${c.change}:${c.id}`)).toEqual([
      'added:ask_split:PAY-121-COMP',
      'changed:convert:EUR',
      'added:defer:PAY-OH-SAAS',
      'added:early_pay_link:REC-121-INV',
      'changed:pay:PAY-121-COMP',
      'removed:pay:PAY-OH-SAAS',
    ]);
  });

  it('is deterministic: the same inputs always produce the same plan', () => {
    expect(plan(delayed(), defaultPolicy)).toEqual(plan(delayed(), defaultPolicy));
  });

  it('replays a stored decision to the identical answer and detects tampering', () => {
    const s = delayed();
    const d = plan(s, defaultPolicy).decisions.find((x) => x.id === 'convert:EUR')!;
    const rec = recordDecision(s, defaultPolicy, d, 'genesis', '2026-11-02T09:00:00Z');
    expect(replay(rec).ok).toBe(true);
    const tampered = structuredClone(rec);
    tampered.policy.autonomousFxLimitUSD.low = 10000;
    expect(replay(tampered)).toMatchObject({ ok: false, reason: 'tampered' });
  });
});
