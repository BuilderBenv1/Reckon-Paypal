import type { BankLine, OpenInvoice, ReconFixture } from './types.js';

// Deterministic synthetic reconciliation fixture: ordinary exact matches plus five planted
// cases that real finance teams hit every week. No randomness, so judges can rerun it.

const FILLER_CUSTOMERS = [
  'Ashby Dental Group', 'Bramley Foods Ltd', 'Carrow Estates', 'Dunmore Leisure', 'Elmfield Care Homes',
  'Fenwick Retail', 'Greyhaven Studios', 'Holloway Motors', 'Ironbridge Clinics', 'Juniper Housing',
];

export function buildReconFixture(): ReconFixture {
  const invoices: OpenInvoice[] = [];
  const lines: BankLine[] = [];

  // 20 ordinary invoices paid in full with the invoice number as reference.
  for (let i = 0; i < 20; i++) {
    const customer = FILLER_CUSTOMERS[i % FILLER_CUSTOMERS.length]!;
    const id = `INV-${(5001 + i).toString()}`;
    const amount = 850 + ((i * 1373) % 6100) + (i % 3) * 0.5;
    invoices.push({ id, customer, amount, currency: 'USD' });
    lines.push({ id: `BL-${(101 + i).toString()}`, date: '2026-11-01', payer: customer, amount, currency: 'USD', reference: id });
  }

  // Planted 1: one payment settling two invoices; reference names only the customer account.
  invoices.push({ id: 'INV-5101', customer: 'Kestrel Facilities', amount: 3120, currency: 'USD' });
  invoices.push({ id: 'INV-5102', customer: 'Kestrel Facilities', amount: 1880, currency: 'USD' });
  lines.push({ id: 'BL-201', date: '2026-11-01', payer: 'Kestrel Facilities', amount: 5000, currency: 'USD', reference: 'KESTREL ACC 0042' });

  // Planted 2: short payment with a remittance email explaining the withheld amount.
  invoices.push({ id: 'HLH-INV-0381', customer: 'Harbour Lane Hotels', amount: 4900, currency: 'USD' });
  lines.push({ id: 'BL-202', date: '2026-11-01', payer: 'Harbour Lane Hotels', amount: 4650, currency: 'USD', reference: 'HLH-INV-0381' });

  // Planted 3: EUR receipt slightly short after the payer's bank charges.
  invoices.push({ id: 'INV-5103', customer: 'Lumen Bau GmbH', amount: 6400, currency: 'EUR' });
  lines.push({ id: 'BL-203', date: '2026-11-01', payer: 'Lumen Bau GmbH', amount: 6385, currency: 'EUR', reference: 'INV-5103' });

  // Planted 4: look-alike duplicate that is really the next instalment of a plan.
  invoices.push({ id: 'PLAN-77-1', customer: 'Marston Schools', amount: 2750, currency: 'USD', instalment: { plan: 'PLAN-77', n: 1, of: 3 } });
  invoices.push({ id: 'PLAN-77-2', customer: 'Marston Schools', amount: 2750, currency: 'USD', instalment: { plan: 'PLAN-77', n: 2, of: 3 } });
  lines.push({ id: 'BL-204', date: '2026-10-25', payer: 'Marston Schools', amount: 2750, currency: 'USD', reference: 'PLAN-77' });
  lines.push({ id: 'BL-205', date: '2026-11-01', payer: 'Marston Schools', amount: 2750, currency: 'USD', reference: 'PLAN-77' });

  // Planted 5: deposit with no reference and an unknown payer.
  lines.push({ id: 'BL-206', date: '2026-11-01', payer: 'TRF 88213', amount: 1200, currency: 'USD', reference: '' });

  return { invoices, lines };
}
