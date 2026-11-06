import { describe, expect, it } from 'vitest';
import { checkDraft, ClaudeDrafter, numbersIn } from '../src/agent/drafter.js';

const template =
  'Hi,\n\nYour invoice for stage 2 (USD 12,000) is due in 21 days. If it suits you to settle early, you can pay USD 11,820 today through this secure link and keep the difference:\n\nhttps://pay.sandbox.airwallex.com/abc123\n\nThanks,\nAccounts';

const client = (text: string) => ({ messages: { create: async () => ({ content: [{ type: 'text', text }] }) } }) as never;

describe('number guard on drafted messages', () => {
  it('reads numbers as written, ignoring the ones inside links', () => {
    expect(numbersIn(template).sort()).toEqual(['11820', '12000', '2', '21'].sort());
  });

  it('accepts a rewording that keeps every number and the link', () => {
    const draft =
      'Hello,\n\nStage 2 (USD 12,000) falls due in 21 days. Should you prefer to settle now, USD 11,820 paid today through the link below closes it:\n\nhttps://pay.sandbox.airwallex.com/abc123\n\nBest,\nAccounts';
    expect(checkDraft(template, draft)).toBeNull();
  });

  it('rejects a draft that changes an amount', () => {
    const draft = template.replace('11,820', '11,800');
    expect(checkDraft(template, draft)).toMatch(/dropped or changed 11820/);
  });

  it('rejects a draft that invents a number', () => {
    expect(checkDraft(template, `${template}\nWe can also offer 2.5% next month.`)).toMatch(/added/);
  });

  it('rejects a draft that alters the link', () => {
    expect(checkDraft(template, template.replace('abc123', 'abc124'))).toMatch(/link/);
  });

  it('falls back to the template when Claude changes a number', async () => {
    const out = await new ClaudeDrafter('m', client(template.replace('21 days', '3 weeks'))).draft({ to: 'x', subject: 's', body: template });
    expect(out).toMatchObject({ by: 'template', body: template });
    expect(out.rejected).toMatch(/21/);
  });

  it('uses the Claude draft when it passes', async () => {
    const draft = template.replace('If it suits you to settle early', 'If it helps to settle early');
    expect(await new ClaudeDrafter('m', client(draft)).draft({ to: 'x', subject: 's', body: template })).toMatchObject({ by: 'claude', body: draft });
  });
});
