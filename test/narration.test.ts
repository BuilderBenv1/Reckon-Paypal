import { describe, expect, it } from 'vitest';
import { Session } from '../src/demo/session.js';
import { buildView, type RunView } from '../src/web/view.js';
import { after, afterTamper, before, intro, outro, presenterName, say, spoken, TOUR_STEPS, type Beat, type Opts } from '../src/web/narration.js';

async function tour(o: Opts = {}) {
  const s = await Session.create('demo', { claude: false });
  let v: RunView = buildView('t', s);
  const script: { step: string; beats: Beat[] }[] = [{ step: 'intro', beats: intro(v, o) }];
  for (const step of TOUR_STEPS) {
    script.push({ step: `before:${step}`, beats: before(step, v, o) });
    const prev = v;
    await s.act(v.steps.find((x) => x.id === step)!.action!);
    v = buildView('t', s);
    script.push({ step: `after:${step}`, beats: after(step, prev, v, o) });
  }
  await s.act({ type: 'replay', decisionId: 'pay:PAY-114-FREIGHT', tamper: true });
  v = buildView('t', s);
  script.push({ step: 'tamper', beats: afterTamper(v, o) }, { step: 'outro', beats: outro(v, o) });
  return script;
}

const text = (script: Awaited<ReturnType<typeof tour>>, step: string) => script.find((x) => x.step === step)!.beats.map((b) => b.text).join(' ');
const all = (script: Awaited<ReturnType<typeof tour>>) => script.flatMap((x) => x.beats.map((b) => b.text)).join(' ');

describe('guided demo narration', () => {
  it('says company names without legal suffixes', () => {
    expect(spoken('Rheinfracht Logistik GmbH')).toBe('Rheinfracht Logistik');
    expect(spoken('Calder & Finch LLP')).toBe('Calder & Finch');
  });

  it('says money the way a person would', () => {
    expect(say(5770.99)).toBe('5,771 dollars');
    expect(say(3412.85, 'EUR', true)).toBe('3,412.85 euros');
    expect(say(1600, 'GBP', true)).toBe('1,600 pounds');
  });

  it('reads every number from the run, at every step', async () => {
    const script = await tour();
    for (const { step, beats } of script) {
      expect(beats.length, step).toBeGreaterThan(0);
      for (const b of beats) expect(b.text, step).not.toMatch(/undefined|NaN|null|\$\{|\. so|,,/);
    }
    expect(text(script, 'intro')).toContain('5,780 dollars to spare');
    expect(text(script, 'intro')).toContain('25 of the 26');
    expect(text(script, 'intro')).toContain('5,890-dollar bill is first, because paying it unlocks 24,000 dollars on the same job');
    expect(text(script, 'intro')).toContain("One payment, for 8,175 dollars, is on hold. That job has no budget yet and it's a new supplier, so");
    const late = text(script, 'after:delay_email');
    expect(late).toContain('counting on that 9,000 dollars');
    expect(late).toContain('3,220 dollars short');
    expect(late).toContain('covers the gap for 200 dollars');
    expect(late).toContain('over what Reckon may send alone while things are less certain');
    expect(text(script, 'after:run_0900')).toContain("That's 4 jobs done");
    expect(text(script, 'after:approve')).toContain('pays Rheinfracht Logistik straight away');
    expect(text(script, 'after:customer_pays')).toContain('covered again');
    expect(text(script, 'after:chase')).toContain('because the account was closed');
    expect(text(script, 'after:replay')).toContain('exactly the same answer');
    expect(text(script, 'tamper')).toContain('spots it straight away');
  });

  it('names PayPal by default but never mentions the hackathon', async () => {
    const words = all(await tour());
    expect(words).toContain('PayPal');
    expect(words).not.toMatch(/hackathon/i);
    expect(text(await tour(), 'outro')).toMatch(/Thanks for watching\.$/);
  });

  it('event mode leaves PayPal out, credits the presenter and hands over', async () => {
    const script = await tour({ paypal: false, presenter: 'Ben' });
    expect(all(script)).not.toMatch(/paypal|hackathon/i);
    expect(text(script, 'intro')).toContain("I'm going to show you Reckon, something Ben has just built.");
    expect(text(script, 'outro')).toMatch(/I'll hand you over to Ben\.$/);
    expect(text(script, 'after:chase')).toContain('checks with the bank first');
  });

  it('keeps names speakable', () => {
    expect(presenterName('Ben & Kieron')).toBe('Ben & Kieron');
    expect(presenterName('<script>x</script>')).toBe('scriptxscript');
    expect(presenterName('  ')).toBeNull();
  });

  it('has a short cut that drops only the longer introduction', async () => {
    const s = await Session.create('demo', { claude: false });
    const beats = intro(buildView('t', s));
    expect(beats.filter((b) => b.extra)).toHaveLength(3);
    expect(beats.filter((b) => !b.extra)[0]!.text).toMatch(/^Let's see it run on a Monday morning/);
  });
});
