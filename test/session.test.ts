import { describe, expect, it } from 'vitest';
import { defaultPolicy } from '../src/domain/seed.js';
import { Session, type Action, type SessionSnapshot } from '../src/demo/session.js';

// Each action restores from a snapshot and saves a new one, as a serverless request would.
async function step(snap: SessionSnapshot, action: Action): Promise<SessionSnapshot> {
  const s = Session.restore(JSON.parse(JSON.stringify(snap)) as SessionSnapshot, { claude: false });
  await s.act(action);
  return s.snapshot();
}

describe('demo session across serverless requests', () => {
  it('plays the whole story with a save and restore between every action', async () => {
    let snap = (await Session.create('demo', { claude: false })).snapshot();
    expect(snap.done).toEqual(['morning']);
    expect(snap.view.recon.filter((r) => r.needsPerson)).toHaveLength(1);

    snap = await step(snap, { type: 'delay_email' });
    expect(snap.view.last?.changes.map((c) => c.id)).toContain('early_pay_link:REC-121-INV');

    snap = await step(snap, { type: 'run' });
    expect(snap.view.last?.executed).toEqual(['pay:PAY-109-SUB', 'ask_split:PAY-121-COMP', 'early_pay_link:REC-121-INV', 'defer:PAY-OH-SAAS']);

    snap = await step(snap, { type: 'approve', decisionId: 'convert:EUR' });
    expect(snap.view.last?.executed).toEqual(['convert:EUR', 'pay:PAY-114-FREIGHT']);

    snap = await step(snap, { type: 'customer_pays' });
    expect(snap.view.last?.executed).toEqual(['pay:PAY-OH-SAAS']);

    snap = await step(snap, { type: 'split_reply' });
    expect(snap.view.last?.executed).toEqual(['convert:GBP', 'pay:PAY-121-COMP-A']);

    snap = await step(snap, { type: 'chase' });
    expect(snap.view.incident?.outcome).toBe('replaced');

    snap = await step(snap, { type: 'replay', decisionId: 'convert:EUR' });
    expect(snap.view.replays[0]).toMatchObject({ ok: true, tampered: false });
    snap = await step(snap, { type: 'replay', decisionId: 'convert:EUR', tamper: true });
    expect(snap.view.replays[0]).toMatchObject({ ok: false, reason: 'tampered' });

    const final = Session.restore(snap, { claude: false });
    const p = final.reckon.plan().plan;
    expect(p.summary.cashUSD).toBeGreaterThanOrEqual(defaultPolicy.reserveFloorUSD);
    expect(final.reckon.ledger.verifyChain().ok).toBe(true);
    expect(snap.done).toEqual(['morning', 'delay_email', 'run_0900', 'approve', 'customer_pays', 'split_reply', 'chase', 'replay']);
  });

  it('a snapshot survives JSON round-trips unchanged', async () => {
    const snap = (await Session.create('demo', { claude: false })).snapshot();
    const again = Session.restore(JSON.parse(JSON.stringify(snap)) as SessionSnapshot, { claude: false }).snapshot();
    expect(again).toEqual(JSON.parse(JSON.stringify(snap)));
  });

  it('refuses to read a custom email without Claude', async () => {
    const s = await Session.create('demo', { claude: false });
    await expect(s.act({ type: 'custom_email', from: 'a', subject: 'b', body: 'c' })).rejects.toThrow(/needs Claude/);
  });

  it('live runs cannot fake a customer payment', async () => {
    const { FakeAirwallex } = await import('../src/airwallex/fake.js');
    const { seedRates } = await import('../src/domain/seed.js');
    const inner = new FakeAirwallex({ USD: 1e7, EUR: 1e7, GBP: 1e7 }, seedRates);
    const s = await Session.create('live', { claude: false, live: () => inner });
    await expect(s.act({ type: 'customer_pays' })).rejects.toThrow(/real payment link/);
  });
});
