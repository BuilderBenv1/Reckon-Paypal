import type { Currency, TransferMethod } from './types.js';

// Synthetic beneficiaries. Names and account numbers are invented, but Airwallex validates
// routing codes and IBAN checksums, so these use well-known public test identifiers
// (ABA 021000021, sort code 20-20-15 / 55555555, IBAN DE89 3704 0044 0532 0130 00).
// Confirm required fields per corridor with POST /beneficiaries/schema before first use.

export interface PayeeDetails {
  supplier: string;
  country: 'US' | 'GB' | 'DE';
  currency: Currency;
  method: TransferMethod;
  /** Airwallex transfer reason (closed list in the transfers API). */
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
    supplier: 'Rheinfracht Logistik GmbH', country: 'DE', currency: 'EUR', method: 'SWIFT', reason: 'freight', email: 'buchhaltung@rheinfracht.example',
    address: { street_address: 'Hafenstrasse 12', city: 'Duisburg', postcode: '47119', country_code: 'DE' },
    bank: { kind: 'DE', iban: 'DE89370400440532013000', swift_code: 'COBADEFFXXX' },
  },
  'Klimatech Anlagen GmbH': {
    supplier: 'Klimatech Anlagen GmbH', country: 'DE', currency: 'EUR', method: 'SWIFT', reason: 'goods_purchased', email: 'info@klimatech.example',
    address: { street_address: 'Industrieweg 4', city: 'Kassel', postcode: '34123', country_code: 'DE' },
    bank: { kind: 'DE', iban: 'DE89370400440532013000', swift_code: 'COBADEFFXXX' },
  },
  'Brightline Electrical Inc': {
    supplier: 'Brightline Electrical Inc', country: 'US', currency: 'USD', method: 'LOCAL', reason: 'construction', email: 'office@brightline-electrical.example',
    address: { street_address: '410 Mercer Avenue', city: 'Newark', state: 'NJ', postcode: '07102', country_code: 'US' },
    bank: { kind: 'US', account_number: '700100200301', aba: '021000021', bank_account_category: 'Checking' },
  },
  'Pennine Joinery Supplies Ltd': {
    supplier: 'Pennine Joinery Supplies Ltd', country: 'GB', currency: 'GBP', method: 'LOCAL', reason: 'goods_purchased', email: 'dave@penninejoinery.example',
    address: { street_address: 'Unit 7, Calder Works', city: 'Halifax', postcode: 'HX1 5AB', country_code: 'GB' },
    bank: { kind: 'GB', account_number: '55555555', sort_code: '202015', bank_name: 'Barclays' },
  },
  'Planwise Software Inc': {
    supplier: 'Planwise Software Inc', country: 'US', currency: 'USD', method: 'LOCAL', reason: 'technical_services', email: 'billing@planwise.example',
    address: { street_address: '88 Harbor Drive', city: 'Boston', state: 'MA', postcode: '02210', country_code: 'US' },
    bank: { kind: 'US', account_number: '700100200302', aba: '021000021', bank_account_category: 'Checking' },
  },
};
