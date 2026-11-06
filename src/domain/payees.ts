import type { Currency, TransferMethod } from './types.js';

// Synthetic payees. Every name, email and account number is invented.
// On PayPal a payout goes to the payee's email; bank details are kept for the books only.
// In the sandbox, set PAYPAL_SANDBOX_RECEIVER to your sandbox personal account so payouts land
// somewhere real instead of sitting UNCLAIMED.

export interface PayeeDetails {
  supplier: string;
  country: 'US' | 'GB' | 'DE';
  currency: Currency;
  method: TransferMethod;
  /** Payment purpose, used as the payout note. */
  reason: 'freight' | 'construction' | 'goods_purchased' | 'technical_services' | 'professional_business_services';
  email: string;
  address: { street_address: string; city: string; postcode: string; country_code: string; state?: string };
  bank:
    | { kind: 'US'; account_number: string; aba: string; bank_account_category: 'Checking' | 'Savings' }
    | { kind: 'GB'; account_number: string; sort_code: string; bank_name: string }
    | { kind: 'DE'; iban: string; swift_code: string };
}

export const payees: Record<string, PayeeDetails> = {
  'Rheinfracht Logistik GmbH': {
    supplier: 'Rheinfracht Logistik GmbH', country: 'DE', currency: 'USD', method: 'LOCAL', reason: 'freight', email: 'buchhaltung@rheinfracht.example',
    address: { street_address: 'Hafenstrasse 12', city: 'Duisburg', postcode: '47119', country_code: 'DE' },
    bank: { kind: 'DE', iban: 'DE89370400440532013000', swift_code: 'COBADEFFXXX' },
  },
  'Klimatech Anlagen GmbH': {
    supplier: 'Klimatech Anlagen GmbH', country: 'DE', currency: 'USD', method: 'LOCAL', reason: 'goods_purchased', email: 'info@klimatech.example',
    address: { street_address: 'Industrieweg 4', city: 'Kassel', postcode: '34123', country_code: 'DE' },
    bank: { kind: 'DE', iban: 'DE89370400440532013000', swift_code: 'COBADEFFXXX' },
  },
  'Brightline Electrical Inc': {
    supplier: 'Brightline Electrical Inc', country: 'US', currency: 'USD', method: 'LOCAL', reason: 'construction', email: 'office@brightline-electrical.example',
    address: { street_address: '410 Mercer Avenue', city: 'Newark', state: 'NJ', postcode: '07102', country_code: 'US' },
    bank: { kind: 'US', account_number: '700100200301', aba: '021000021', bank_account_category: 'Checking' },
  },
  'Pennine Joinery Supplies Ltd': {
    supplier: 'Pennine Joinery Supplies Ltd', country: 'GB', currency: 'USD', method: 'LOCAL', reason: 'goods_purchased', email: 'dave@penninejoinery.example',
    address: { street_address: 'Unit 7, Calder Works', city: 'Halifax', postcode: 'HX1 5AB', country_code: 'GB' },
    bank: { kind: 'GB', account_number: '55555555', sort_code: '202015', bank_name: 'Barclays' },
  },
  'Planwise Software Inc': {
    supplier: 'Planwise Software Inc', country: 'US', currency: 'USD', method: 'LOCAL', reason: 'technical_services', email: 'billing@planwise.example',
    address: { street_address: '88 Harbor Drive', city: 'Boston', state: 'MA', postcode: '02210', country_code: 'US' },
    bank: { kind: 'US', account_number: '700100200302', aba: '021000021', bank_account_category: 'Checking' },
  },
};
