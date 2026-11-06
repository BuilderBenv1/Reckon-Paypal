import type { DecisionView, RunView } from './view.js';

// The guided demo's voice-over. Every number is read from the run as it stands, never typed in,
// so the narrator can't say something the page doesn't show. Pure: same view in, same words out.

export type Focus = 'hero' | 'brief' | 'changes' | 'decisions' | 'payments' | 'outbox' | 'recon' | 'signals' | 'steps' | 'proof';

export interface Beat {
  focus: Focus;
  text: string;
  /** Part of the longer spoken introduction; skipped in the short cut (?short). */
  extra?: true;
}

export type TourStep = 'delay_email' | 'run_0900' | 'approve' | 'customer_pays' | 'split_reply' | 'chase' | 'replay';
export const TOUR_STEPS: TourStep[] = ['delay_email', 'run_0900', 'approve', 'customer_pays', 'split_reply', 'chase', 'replay'];

const NAME: Record<string, [string, string]> = { USD: ['dollar', 'dollars'], EUR: ['euro', 'euros'], GBP: ['pound', 'pounds'] };

/** Money as it should be spoken: "5,771 dollars", or exact to the cent when `exact`. */
export function say(n: number, ccy = 'USD', exact = false): string {
  const v = exact ? Math.abs(n) : Math.round(Math.abs(n));
  const num = v.toLocaleString('en-GB', { minimumFractionDigits: exact && v % 1 ? 2 : 0, maximumFractionDigits: exact ? 2 : 0 });
  const [one, many] = NAME[ccy] ?? [ccy, ccy];
  return `${num} ${v === 1 ? one : many}`;
}

/** Money used as an adjective: "a 24,000-dollar milestone". */
export function sayAdj(n: number, ccy = 'USD'): string {
  const v = Math.round(Math.abs(n)).toLocaleString('en-GB');
  return `${v}-${(NAME[ccy] ?? [ccy])[0]}`;
}

/** Company names as a person would say them: no GmbH, Ltd, Inc or LLP. */
export const spoken = (name: string) => name.replace(/,?\s+(GmbH|Ltd|Limited|Inc|LLP|plc)\.?(?=\b|$)/gi, '').trim();

const num = (s: string | undefined) => (s ? Number(s.replace(/,/g, '')) : NaN);
const all = (v: RunView): DecisionView[] => [...v.decisions, ...v.doneToday];
const byId = (v: RunView, id: string) => all(v).find((d) => d.id === id);
const byKind = (v: RunView, kind: DecisionView['kind']) => all(v).find((d) => d.kind === kind);

/**
 * Who it's for. The default names PayPal (the hackathon judges want to see it). Event mode,
 * opened with ?handoff, keeps it generic, says the presenter has just built it, and hands over.
 */
export interface Opts {
  paypal?: boolean;
  presenter?: string | null;
}
const brand = (o: Opts) => o.paypal !== false;

export function intro(v: RunView, o: Opts = {}): Beat[] {
  const s = v.summary;
  const name = presenterName(o.presenter);
  const beats: Beat[] = [
    {
      focus: 'hero',
      extra: true,
      text:
        `Hi, I'm an AI voice, and I'm going to show you Reckon${name ? `, something ${name} has just built` : ''}. It's an AI agent that looks after a company's cash` +
        (brand(o) ? ', and it runs on PayPal.' : '.'),
    },
    {
      focus: 'hero',
      extra: true,
      text: "It's for businesses that work job by job, like builders and installers. Money comes in and goes out at different times, and some weeks there isn't enough to pay everyone. Normally someone sits with a spreadsheet every morning and decides who gets paid.",
    },
    {
      focus: 'hero',
      extra: true,
      text: "Reckon does that job for them. It pays what it safely can, and only asks the boss when a person needs to decide. The AI never decides how much to pay anyone. That's all fixed rules.",
    },
    {
      focus: 'hero',
      text:
        "Let's see it run on a Monday morning. " +
        (v.mode === 'demo'
          ? brand(o)
            ? 'This is a demo, so PayPal is simulated and no real money moves.'
            : 'This is a demo, so no real money moves.'
          : brand(o)
            ? 'This run is on the real PayPal sandbox, so every payout and invoice you see is real, just with test money.'
            : 'This run uses a real test bank account, so every payment you see really happens, just with test money.'),
    },
  ];
  beats.push({
    focus: 'hero',
    text: s.gapUSD <= 0 ? `First, it's checked the spreadsheet and the bank. This week is covered, with ${say(-s.gapUSD)} to spare.` : `First, it's checked the spreadsheet and the bank. This week is ${say(s.gapUSD)} short.`,
  });
  if (v.recon.total) {
    const person = v.recon.person;
    beats.push({
      focus: 'recon',
      text:
        `It's also matched ${v.recon.auto} of the ${v.recon.total} payments from overnight by itself` +
        (person ? (person === 1 ? ', and left the odd one out for a person to check.' : `, and left ${person} for a person to check.`) : '.'),
    });
  }
  const first = v.decisions.find((d) => d.kind === 'pay' && /ranked 1 because paying it releases/.test(d.reason));
  const releases = first?.reason.match(/releases USD ([\d,]+) on Job (\w+)/);
  if (first && releases) {
    beats.push({
      focus: 'decisions',
      text: `Look at the order. This ${sayAdj(first.amount, first.currency)} bill is first, because paying it unlocks ${say(num(releases[1]))} ${releases[2] === first.job ? 'on the same job' : `on job ${releases[2]}`}.`,
    });
  }
  const hold = v.needsYou.find((d) => d.kind === 'hold');
  if (hold) {
    const why: string[] = [];
    if (/no quoted budget/i.test(hold.reason)) why.push('that job has no budget yet');
    if (/new payee/i.test(hold.reason)) why.push("it's a new supplier");
    beats.push({
      focus: 'brief',
      text: `One payment, for ${say(hold.amount, hold.currency)}, is on hold.${why.length ? ` ${cap(listJoin(why))},` : ''} so Reckon won't pay it without the boss.`.replace('hold. so', 'hold, so'),
    });
  }
  return beats;
}

export function before(step: TourStep, v: RunView, o: Opts = {}): Beat[] {
  switch (step) {
    case 'delay_email':
      return [{ focus: 'steps', text: 'Now a customer emails to say their payment will be a week late.' }];
    case 'run_0900':
      return [{ focus: 'steps', text: "At nine o'clock, Reckon gets on with everything it's allowed to do." }];
    case 'approve':
      return [{ focus: 'brief', text: 'The boss approves it with one click. That approval only covers that exact amount.' }];
    case 'customer_pays':
      if (v.mode === 'live')
        return [{ focus: 'payments', text: `This is a real ${brand(o) ? 'PayPal ' : ''}invoice. Let's pay it as the customer, and Reckon will spot the payment by itself.` }];
      return [{ focus: 'payments', text: brand(o) ? 'Now the customer pays early, through the PayPal invoice.' : 'Now the customer pays early, through the invoice.' }];
    case 'split_reply':
      return [{ focus: 'steps', text: 'The supplier agrees to split their bill.' }];
    case 'chase':
      return [{ focus: 'steps', text: "Next, a supplier says they never got last week's payment." }];
    case 'replay':
      return [{ focus: 'proof', text: 'Last thing. Reckon keeps a record of every decision, and why it made it.' }];
  }
  void v;
}

export function after(step: TourStep, prev: RunView, v: RunView, o: Opts = {}): Beat[] {
  const s = v.summary;
  const beats: Beat[] = [];
  switch (step) {
    case 'delay_email': {
      beats.push({
        focus: 'signals',
        text: v.claude
          ? 'The AI reads the email and picks out what matters. The rules decide what to do about it.'
          : 'In the live version, the AI reads the email and picks out what matters. In this demo that part is pre-recorded. Either way, the rules decide what to do about it.',
      });
      const lost = prev.summary.expectedReceiptsUSD - s.expectedReceiptsUSD;
      beats.push({
        focus: 'hero',
        text: s.gapUSD > 0 ? `${lost > 0 ? `Reckon was counting on that ${say(lost)}, so now` : 'Now'} the week is ${say(s.gapUSD)} short.` : 'The week is still covered.',
      });
      const fixes: string[] = [];
      if (byKind(v, 'early_pay_link')) fixes.push('offers the customer a small discount to pay early');
      if (byKind(v, 'ask_split')) fixes.push('asks a supplier to split their bill');
      if (byKind(v, 'defer')) fixes.push('puts off a bill that can wait');
      if (fixes.length && s.gapUSD > 0) {
        beats.push({
          focus: 'decisions',
          text:
            `Instead of just deciding who doesn't get paid, Reckon finds ways to fix it. It ${listJoin(fixes)}.` +
            (s.gapAfterLeversUSD <= 0 ? ` That covers the gap for ${say(s.leversCostUSD)}.` : ''),
        });
      }
      const was = byId(prev, 'pay:PAY-114-FREIGHT');
      const now = byId(v, 'pay:PAY-114-FREIGHT');
      if (was?.execution === 'auto' && now?.execution === 'approval') {
        beats.push({
          focus: 'brief',
          text: "The freight payment is now over what Reckon may send alone while things are less certain, so it asks the boss first.",
        });
      }
      return beats;
    }
    case 'run_0900': {
      const n = v.last?.executed.length ?? 0;
      beats.push({ focus: 'payments', text: `That's ${n} job${n === 1 ? '' : 's'} done, without anyone lifting a finger.` });
      return beats;
    }
    case 'approve': {
      const paid = (v.last?.executed ?? []).filter((id) => id.startsWith('pay:')).map((id) => id.slice(4));
      const who = v.payments.filter((p) => paid.includes(p.payableId)).map((p) => spoken(p.supplier));
      beats.push({ focus: 'payments', text: who.length ? `Reckon pays ${listJoin(who)} straight away.` : 'Reckon carries it out straight away.' });
      return beats;
    }
    case 'customer_pays': {
      beats.push({
        focus: 'hero',
        text: s.gapUSD <= 0 ? 'The money comes in, Reckon re-plans by itself, and the week is covered again.' : `The money comes in and Reckon re-plans by itself. The week is still ${say(s.gapUSD)} short.`,
      });
      const paid = (v.last?.executed ?? []).filter((id) => id.startsWith('pay:')).map((id) => id.slice(4));
      const who = v.payments.filter((p) => paid.includes(p.payableId)).map((p) => spoken(p.supplier));
      if (who.length) beats.push({ focus: 'payments', text: `It also pays ${listJoin(who)}, which it had been holding back.` });
      return beats;
    }
    case 'split_reply':
      beats.push({ focus: 'payments', text: 'So Reckon pays the first half now, and the rest in two weeks.' });
      return beats;
    case 'chase': {
      const inc = v.incident;
      if (inc && inc.outcome === 'replaced' && inc.original) {
        const ft = inc.original.failureType ?? '';
        const why = ft === 'ACCOUNT_CLOSED' ? ', because the account was closed' : ft === 'RETURNED' ? ', unclaimed' : '';
        beats.push({ focus: 'payments', text: `Reckon checks with ${brand(o) ? 'PayPal' : 'the bank'} first. The payment came back${why}, so it sends a replacement.` });
        beats.push({ focus: 'payments', text: "When the supplier chases again, Reckon sees the replacement is already on its way, and doesn't pay twice." });
      } else if (v.last) {
        beats.push({ focus: 'payments', text: v.last.headline });
      }
      return beats;
    }
    case 'replay': {
      const r = v.replays[0];
      beats.push({ focus: 'proof', text: r?.ok ? 'If you re-run a decision, you get exactly the same answer.' : "Re-running that decision didn't give the same answer." });
      return beats;
    }
  }
}

export function afterTamper(v: RunView, _o: Opts = {}): Beat[] {
  const r = v.replays[0];
  return [{ focus: 'proof', text: r?.tampered && !r.ok ? 'And if anyone changes the record afterwards, Reckon spots it straight away.' : 'The altered copy was checked.' }];
}

/** A presenter's name as it can be spoken: letters, spaces, hyphens, apostrophes and "&" only. */
export const presenterName = (raw: string | null | undefined): string | null => {
  const n = (raw ?? '').replace(/[^\p{L} '&-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return n || null;
};

export function outro(_v: RunView, o: Opts = {}): Beat[] {
  const name = presenterName(o.presenter);
  return [
    {
      focus: 'hero',
      text:
        "So that's Reckon. It pays the right bills first, holds back anything risky, finds the cheapest way to cover a shortfall, and keeps a record of why. " +
        (name ? `Thanks for watching. I'll hand you over to ${name}.` : 'Thanks for watching.'),
    },
  ];
}

const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

function listJoin(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}
