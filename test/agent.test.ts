import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultPolicy, seedBalances, seedBook, seedRates } from '../src/domain/seed.js';
import { FakeBank } from '../src/bank/fake.js';
import { ClaudeReader, FixtureReader, validate } from '../src/agent/reader.js';
import { Reckon } from '../src/agent/reckon.js';
import { DuplicatePaymentError, Ledger } from '../src/ledger/ledger.js';
import { plan } from '../src/policy/plan.js';
import { initialState } from '../src/policy/state.js';
import { readBook, writeBook } from '../src/sheet/workbook.js';

const setup = () => {
  let t = 0;
  let n = 0;
  const bank = new FakeBank({ ...seedBalances }, seedRates);
  const reckon = new Reckon(
    initialState(structuredClone(seedBook), { ...seedBalances }, seedRates),
    defaultPolicy,
    bank,
    new FixtureReader(),
    () => `2026-11-02T09:${String(++t).padStart(2, '0')}:00Z`,
    () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  );
  return { bank, reckon };
};
const delayEmail = { id: 'EM-01', from: 'accounts@westfield-academy.example', subject: 'Re: Invoice', body: 'next Tuesday' };

describe('approvals are bound to exact terms', () => {
  it('does not send an approval-required payout until the MD approves it', async () => {
    const { reckon } = setup();
    await reckon.ingestEmail(delayEmail);
    const first = await reckon.run();
    expect(first.executed).not.toContain('pay:PAY-114-FREIGHT');
    expect(first.awaitingApproval.map((d) => d.id)).toContain('pay:PAY-114-FREIGHT');
    reckon.approve('pay:PAY-114-FREIGHT', 'MD');
    const second = await reckon.run();
    expect(second.executed).toContain('pay:PAY-114-FREIGHT');
  });

  it('voids an approval when the terms change', () => {
    const ledger = new Ledger();
    const d = plan(initialState(seedBook, seedBalances, seedRates), defaultPolicy).decisions.find((x) => x.id === 'pay:PAY-114-FREIGHT')!;
    ledger.approve(d, 'MD', 'now');
    expect(ledger.isApproved(d)).toBe(true);
    expect(ledger.isApproved({ ...d, amount: d.amount + 1 })).toBe(false);
  });

  it('refuses to execute a stale plan', async () => {
    const { reckon } = setup();
    const { plan: old } = reckon.plan();
    reckon.plan();
    await expect(reckon.execute(old)).rejects.toThrow(/stale/);
  });
});

describe('never pay twice', () => {
  it('locks a payable while an earlier attempt is in flight or paid', () => {
    const ledger = new Ledger();
    ledger.beginPayment('P1', 'req-1', 'now');
    expect(() => ledger.beginPayment('P1', 'req-2', 'now')).toThrow(DuplicatePaymentError);
    ledger.updateAttempt('req-1', { status: 'PAID' });
    expect(() => ledger.beginPayment('P1', 'req-3', 'now')).toThrow(DuplicatePaymentError);
  });

  it('does not pay again while the original transfer is still in flight', async () => {
    const { bank, reckon } = setup();
    const p = seedBook.payables.find((x) => x.id === 'PAY-109-SUB')!;
    const t = await reckon.pay(p);
    await bank.transitionTransfer(t.id, 'SENT');
    const outcome = await reckon.handleNotReceived('PAY-109-SUB');
    expect(outcome.outcome).toBe('in_flight');
    expect(reckon.paymentAttempts()).toHaveLength(1);
  });

  it('replaces a definitely-cancelled transfer once, with a new request id', async () => {
    const { bank, reckon } = setup();
    const p = seedBook.payables.find((x) => x.id === 'PAY-109-SUB')!;
    const t = await reckon.pay(p);
    await bank.transitionTransfer(t.id, 'SENT');
    await bank.transitionTransfer(t.id, 'FAILED', 'ACCOUNT_CLOSED');
    const outcome = await reckon.handleNotReceived('PAY-109-SUB');
    expect(outcome.outcome).toBe('replaced');
    const [orig, repl] = reckon.paymentAttempts();
    expect(repl?.requestId).not.toBe(orig?.requestId);
    expect(repl?.replaces).toBe(orig?.requestId);
    expect((await reckon.handleNotReceived('PAY-109-SUB')).outcome).toBe('in_flight');
  });
});

describe('model output is checked, never trusted', () => {
  it('drops a signal that names an id not in the book', () => {
    expect(validate({ kind: 'split_accepted', payableId: 'PAY-NOPE', evidence: 'ok' }, seedBook).kind).toBe('none');
  });
  it('drops an impossible date', () => {
    expect(validate({ kind: 'receipt_delayed', receivableId: 'REC-109-M3', newExpectedDay: -4, evidence: 'x' }, seedBook).kind).toBe('none');
  });
});

describe('the finance team\'s sheet', () => {
  it('round-trips through the workbook unchanged', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'reckon-')), 'book.xlsx');
    await writeBook(path, seedBook);
    expect(await readBook(path, seedBook.asOf)).toEqual(seedBook);
  });
});

describe('full offline story', () => {
  it('ends with the gap closed, the floor intact and the deposit still held', async () => {
    const { bank, reckon } = setup();
    await reckon.ingestEmail(delayEmail);
    await reckon.run();
    reckon.approve('pay:PAY-114-FREIGHT', 'MD');
    await reckon.run();
    await bank.payLink(reckon.links.get('REC-121-INV')!);
    await reckon.checkLinks();
    await reckon.ingestEmail({ id: 'EM-02', from: 'dave@penninejoinery.example', subject: 'Re', body: 'yes' });
    const last = await reckon.run();
    expect(last.executed).toEqual(expect.arrayContaining(['pay:PAY-121-COMP-A', 'pay:PAY-OH-SAAS']));
    const final = reckon.plan().plan;
    expect(final.summary.cashUSD).toBeGreaterThanOrEqual(defaultPolicy.reserveFloorUSD);
    expect(final.decisions.map((d) => d.id)).toContain('hold:PAY-117-DEPOSIT');
    expect(reckon.ledger.verifyChain().ok).toBe(true);
    const decisionIds = new Set(reckon.ledger.records.map((r) => r.decisionId));
    expect(decisionIds.size).toBeGreaterThan(5);
    for (const id of decisionIds) expect(reckon.replay(id), id).toMatchObject({ ok: true });
  });
});

describe('live sandbox quirks', () => {
  it('treats a transfer still reading FAILED (before auto-cancel) as dead, and replaces it once', async () => {
    const { bank, reckon } = setup();
    const p = seedBook.payables.find((x) => x.id === 'PAY-109-SUB')!;
    const t = await reckon.pay(p);
    const real = bank.getTransfer.bind(bank);
    bank.getTransfer = async (id: string) => ({ ...(await real(id)), ...(id === t.id ? { status: 'FAILED' as const, failureType: 'ACCOUNT_CLOSED' } : {}) });
    expect((await reckon.handleNotReceived('PAY-109-SUB')).outcome).toBe('replaced');
    expect((await reckon.handleNotReceived('PAY-109-SUB')).outcome).toBe('in_flight');
  });

  it('keeps going when PayPal cannot email the invoice', async () => {
    const { bank, reckon } = setup();
    bank.notifyShopper = async () => {
      throw new Error('invalid shopper_email');
    };
    await reckon.ingestEmail(delayEmail);
    const run = await reckon.run();
    expect(run.executed).toContain('early_pay_link:REC-121-INV');
    expect(reckon.outbox.some((m) => m.decisionId === 'early_pay_link:REC-121-INV')).toBe(true);
  });
});

describe('Claude email reader', () => {
  const email = { id: 'EM-01', from: 'accounts@westfield-academy.example', subject: 'Re: Invoice', body: 'next Tuesday' };
  const client = (content: unknown[]) => {
    const calls: Record<string, unknown>[] = [];
    return {
      calls,
      messages: {
        create: async (body: Record<string, unknown>) => {
          calls.push(body);
          return { content } as never;
        },
      },
    };
  };

  it('does not force a tool call (some models reject that) and reads the tool answer', async () => {
    const c = client([{ type: 'tool_use', id: 't1', name: 'record_signal', input: { kind: 'receipt_delayed', receivableId: 'REC-109-M3', newExpectedDay: 8, evidence: 'following Tuesday' } }]);
    const signal = await new ClaudeReader('test-model', c as never).read(email, seedBook);
    expect(signal).toMatchObject({ kind: 'receipt_delayed', newExpectedDay: 8 });
    expect(c.calls[0]?.tool_choice).toEqual({ type: 'auto' });
  });

  it('accepts a JSON answer in plain text, still validated', async () => {
    const c = client([{ type: 'text', text: 'Here: {"kind":"split_accepted","payableId":"PAY-121-COMP","evidence":"works for us"}' }]);
    expect(await new ClaudeReader('m', c as never).read(email, seedBook)).toMatchObject({ kind: 'split_accepted' });
  });

  it('returns none when the model gives nothing usable', async () => {
    const c = client([{ type: 'text', text: 'Not sure.' }]);
    expect((await new ClaudeReader('m', c as never).read(email, seedBook)).kind).toBe('none');
  });
});
