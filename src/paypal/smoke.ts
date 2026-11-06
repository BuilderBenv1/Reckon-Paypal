import { PayPalRest, PayPalError, SANDBOX_BASE } from './rest.js';
import { payees } from '../domain/payees.js';

// Every PayPal call Reckon makes, one step at a time, each reported with PayPal's own error.
// Moves only sandbox test money: one $1 payout and one $1 invoice. Shared by
// `npm run sandbox:smoke` and the one-off /api/smoke check on the hosted app.

export interface SmokeStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SmokeReport {
  passed: number;
  total: number;
  steps: SmokeStep[];
  calls: string[];
  payerLink: string | null;
}

export async function runSmoke(pp: PayPalRest): Promise<SmokeReport> {
  const steps: SmokeStep[] = [];
  async function step<T>(name: string, fn: () => Promise<T>, show: (v: T) => string = (v) => JSON.stringify(v).slice(0, 200)): Promise<T | undefined> {
    try {
      const v = await fn();
      steps.push({ name, ok: true, detail: show(v) });
      return v;
    } catch (err) {
      const e = err as PayPalError;
      steps.push({ name, ok: false, detail: `${e.message}${e.debugId ? ` (debug_id ${e.debugId})` : ''}` });
      return undefined;
    }
  }

  const requestId = crypto.randomUUID();
  const pay = (beneficiaryId: string) =>
    pp.createTransfer({ requestId, beneficiaryId, amount: 1, currency: 'USD', method: 'LOCAL', reference: 'SMOKE-1', reason: 'technical_services' });

  await step('balances (Reporting API: needs Transaction Search on the app)', () => pp.balances());
  const payee = await step('payee', () => pp.ensureBeneficiary(payees['Planwise Software Inc']!), (v) => v);
  const payout = payee ? await step('create payout ($1 USD)', () => pay(payee)) : undefined;
  if (payout && payee) {
    await step('read payout', () => pp.getTransfer(payout.id), (t) => `${t.id} ${t.status}${t.failureType ? ` ${t.failureType}` : ''}${t.failureReason ? `: ${t.failureReason}` : ''}`);
    await step('find payout by request id', () => pp.findTransferByRequestId(requestId), (t) => (t ? `${t.id} ${t.status}` : 'not found'));
    await step(
      'same request id again is refused (never pay twice)',
      async () => {
        try {
          await pay(payee);
        } catch (err) {
          return `refused: ${(err as Error).message.slice(0, 160)}`;
        }
        throw new Error('PayPal accepted a repeated sender_batch_id');
      },
      (v) => v,
    );
  }
  const link = await step('create and send invoice ($1 USD)', () => pp.createPaymentLink({ title: 'Smoke test', amount: 1, currency: 'USD', reference: `SMOKE-${requestId.slice(0, 8)}`, customerEmail: 'smoke-buyer@example.com' }), (l) => `${l.id} ${l.url}`);
  if (link) {
    await step('read invoice', () => pp.getPaymentLink(link.id), (l) => `${l.id} ${l.status} ${l.amount} ${l.currency}`);
    await step('remind (PayPal emails the customer)', () => pp.notifyShopper(link.id, 'smoke-buyer@example.com'), () => 'sent');
  }
  return { passed: steps.filter((s) => s.ok).length, total: steps.length, steps, calls: [...pp.calls], payerLink: link?.url ?? null };
}

export const isSandbox = (base: string | undefined) => !base || base.replace(/\/$/, '') === SANDBOX_BASE;
