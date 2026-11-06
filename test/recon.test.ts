import { describe, expect, it } from 'vitest';
import { buildReconFixture } from '../src/recon/fixture.js';
import { reconcile } from '../src/recon/match.js';

const byLine = (signals = [] as Parameters<typeof reconcile>[1]) =>
  Object.fromEntries(reconcile(buildReconFixture(), signals).map((r) => [r.lineId, r]));

describe('reconciliation', () => {
  it('matches ordinary payments exactly', () => {
    const results = reconcile(buildReconFixture());
    expect(results.filter((r) => r.kind === 'exact')).toHaveLength(20);
  });

  it('finds one payment settling two invoices', () => {
    expect(byLine()['BL-201']).toMatchObject({ kind: 'multi', invoiceIds: ['INV-5101', 'INV-5102'], needsPerson: false });
  });

  it('flags an unexplained short payment for a person', () => {
    expect(byLine()['BL-202']).toMatchObject({ kind: 'short', difference: -250, needsPerson: true });
  });

  it('accepts a short payment the customer explained in their remittance email', () => {
    const r = byLine([{ kind: 'short_payment_explained', receivableId: 'HLH-INV-0381', reason: 'snagging item withheld', evidence: 'withheld 250.00' }])['BL-202'];
    expect(r).toMatchObject({ kind: 'short', needsPerson: false });
    expect(r?.explanation).toMatch(/snagging/);
  });

  it('writes off a small EUR bank-charge difference', () => {
    expect(byLine()['BL-203']).toMatchObject({ kind: 'fx_difference', difference: -15, needsPerson: false });
  });

  it('treats a look-alike duplicate as the next instalment, not a double payment', () => {
    const r = byLine();
    expect(r['BL-204']?.invoiceIds).toEqual(['PLAN-77-1']);
    expect(r['BL-205']).toMatchObject({ kind: 'instalment', invoiceIds: ['PLAN-77-2'] });
    expect(r['BL-205']?.explanation).toMatch(/not a duplicate/);
  });

  it('leaves an unreferenced deposit for a person', () => {
    expect(byLine()['BL-206']).toMatchObject({ kind: 'unmatched', needsPerson: true });
  });
});
