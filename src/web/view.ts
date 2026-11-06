import type { Balances, Currency } from '../domain/types.js';
import type { Action, ActionResult, Mode, ReplayView, Session, StepId } from '../demo/session.js';
import { plan as purePlan, type Decision, type Plan } from '../policy/plan.js';
import { mdBrief } from '../agent/messages.js';
import type { MatchResult } from '../recon/types.js';
import { CHASED_PAYABLE } from '../demo/incident.js';

// What the page needs, built on the server from a run. The browser never sees the ledger's
// stored state copies, only the facts the MD looks at.

export interface DecisionView {
  id: string;
  kind: Decision['kind'];
  label: string;
  target: string;
  job: string | null;
  project: string | null;
  amount: number;
  currency: Currency;
  amountUSD: number;
  execution: Decision['execution'];
  status: Decision['status'];
  done: boolean;
  approved: boolean;
  rule: string;
  reason: string;
}

export interface StepView {
  id: StepId;
  title: string;
  detail: string;
  state: 'done' | 'next' | 'later';
  action: Action | null;
  /** Live runs: the customer pays a real link. */
  link?: string;
}

export interface RunView {
  id: string;
  mode: Mode;
  asOf: string;
  claude: boolean;
  summary: Plan['summary'];
  balances: Balances;
  brief: string;
  needsYou: DecisionView[];
  decisions: DecisionView[];
  /** Decisions carried out that are no longer part of the plan (paid, converted). */
  doneToday: DecisionView[];
  last: ActionResult | null;
  steps: StepView[];
  payments: { payableId: string; supplier: string; amount: number; currency: Currency; method: string; status: string; transferId: string | null; failureType?: string; replaces?: boolean }[];
  links: { receivableId: string; customer: string; amount: number; currency: Currency; url: string | null; status: 'sent' | 'paid' }[];
  outbox: { to: string; subject: string; body: string; by: 'claude' | 'template'; rejected?: string }[];
  recon: { total: number; auto: number; person: number; notable: MatchResult[] };
  signals: { from: string; kind: string; evidence: string }[];
  replays: ReplayView[];
  ledger: { records: number; chainOk: boolean; head: string };
  incident: Session['snap']['view']['incident'];
  log: { at: string; kind: string; text: string }[];
}

const KIND_LABEL: Record<Decision['kind'], string> = {
  pay: 'Pay',
  hold: 'Hold for the MD',
  defer: 'Defer',
  ask_split: 'Ask to split',
  early_pay_link: 'Early-pay link',
  convert: 'Convert',
  escalate_gap: 'Escalate',
};

export function buildView(id: string, session: Session): RunView {
  const r = session.reckon;
  // Show the plan as it stands now. It's pure, so this records nothing.
  const plan = purePlan(r.state, r.policy);
  const book = r.state.book;
  const projects = new Map(book.projects.map((p) => [p.job, p.name]));
  const jobOf = (target: string): string | null =>
    book.payables.find((p) => target.startsWith(p.id))?.job ?? book.receivables.find((x) => x.id === target)?.job ?? null;

  const toView = (d: Decision): DecisionView => {
    const job = jobOf(d.target);
    return {
      id: d.id,
      kind: d.kind,
      label: KIND_LABEL[d.kind],
      target: d.target,
      job,
      project: job ? (projects.get(job) ?? null) : null,
      amount: d.amount,
      currency: d.currency,
      amountUSD: d.amountUSD,
      execution: d.execution,
      status: d.status,
      done: r.ledger.executed.has(d.id),
      approved: r.ledger.isApproved(d),
      rule: d.rule,
      reason: d.reason,
    };
  };
  const decisions = plan.decisions.map(toView);
  const inPlan = new Set(plan.decisions.map((d) => d.id));
  const doneToday = [...r.ledger.executed]
    .filter((id) => !inPlan.has(id))
    .map((id) => r.ledger.latestRecord(id)?.decision)
    .filter((d): d is Decision => !!d)
    .map(toView);

  const done = new Set(session.snap.done);
  const linkUrl = (receivableId: string) => {
    const m = r.outbox.find((o) => o.decisionId === `early_pay_link:${receivableId}`);
    return m?.body.match(/https?:\/\/\S+/)?.[0] ?? null;
  };
  const convertPending = decisions.find((d) => d.kind === 'convert' && d.execution === 'approval' && !d.approved && !d.done);

  const steps: StepView[] = [
    { id: 'morning', title: 'Morning read', detail: "Reads the finance team's sheet, balances and overnight bank lines.", action: null },
    { id: 'delay_email', title: 'A customer says payment will be late', detail: "Westfield's $9,000 milestone slips a week. Claude reads the email; the plan changes.", action: { type: 'delay_email' } },
    { id: 'run_0900', title: '09:00 cut-off', detail: 'Reckon does everything policy allows on its own and sends the rest to the MD.', action: { type: 'run' } },
    {
      id: 'approve',
      title: 'MD approves the conversion',
      detail: 'Approval is tied to the exact amount shown. If anything changes, it needs approving again.',
      action: convertPending ? { type: 'approve', decisionId: convertPending.id } : null,
    },
    session.mode === 'demo'
      ? { id: 'customer_pays', title: 'Customer takes the early-pay offer', detail: 'They pay the Airwallex payment link at the 1.5% discount. Reckon replans by itself.', action: { type: 'customer_pays' } }
      : {
          id: 'customer_pays',
          title: 'Pay the customer link yourself',
          detail: 'Open it and pay with test card 4035501000000008, any future expiry and CVC. The webhook replans the agent.',
          action: { type: 'check_links' },
          ...(linkUrl('REC-121-INV') ? { link: linkUrl('REC-121-INV')! } : {}),
        },
    { id: 'split_reply', title: 'Supplier agrees to split', detail: 'Half now, half in two weeks. Reckon converts only the GBP it needs and pays.', action: { type: 'split_reply' } },
    { id: 'chase', title: "Supplier chases last week's payment", detail: 'Reckon checks Airwallex before paying again. Never pays twice.', action: { type: 'chase' } },
    { id: 'replay', title: 'Prove a decision', detail: 'Re-run the EUR conversion from its stored inputs, then try a tampered copy.', action: { type: 'replay', decisionId: 'convert:EUR' } },
  ].map((s) => ({ ...s, state: 'later' as const })) as StepView[];
  let nextSet = false;
  for (const s of steps) {
    if (done.has(s.id)) s.state = 'done';
    else if (!nextSet) {
      s.state = 'next';
      nextSet = true;
    }
  }

  const payments = r.ledger.attempts.map((a) => ({
    payableId: a.payableId,
    supplier: a.details?.supplier ?? a.payableId,
    amount: a.details?.amount ?? 0,
    currency: (a.details?.currency ?? 'USD') as Currency,
    method: a.details?.method ?? '',
    status: a.status,
    transferId: a.transferId,
    ...(a.failureType ? { failureType: a.failureType } : {}),
    ...(a.replaces ? { replaces: true } : {}),
  }));

  const links = [...r.links.keys()].map((receivableId) => {
    const rec = book.receivables.find((x) => x.id === receivableId)!;
    const d = r.ledger.latestRecord(`early_pay_link:${receivableId}`)?.decision;
    return {
      receivableId,
      customer: rec.customer,
      amount: d?.amount ?? rec.amount,
      currency: rec.currency,
      url: linkUrl(receivableId),
      status: (r.state.earlyPayLinks[receivableId] ?? 'sent') as 'sent' | 'paid',
    };
  });

  const recon = session.snap.view.recon;
  const chain = r.ledger.verifyChain();

  return {
    id,
    mode: session.mode,
    asOf: book.asOf,
    claude: session.claudeOn,
    summary: plan.summary,
    balances: r.state.balances,
    brief: mdBrief(plan, plan.decisions.filter((d) => d.execution === 'approval' && !r.ledger.isApproved(d))),
    needsYou: decisions.filter((d) => d.execution === 'approval' && !d.done && !d.approved),
    decisions,
    doneToday,
    last: session.snap.view.last,
    steps,
    payments,
    links,
    outbox: r.outbox.map((m, i) => {
      const d = session.snap.view.drafts[i];
      return { to: m.to, subject: m.subject, body: m.body, by: d?.by ?? 'template', ...(d?.rejected ? { rejected: d.rejected } : {}) };
    }),
    recon: { total: recon.length, auto: recon.filter((x) => !x.needsPerson).length, person: recon.filter((x) => x.needsPerson).length, notable: recon.filter((x) => x.kind !== 'exact') },
    signals: session.snap.view.signals.map((s) => ({ from: s.from, kind: s.signal.kind, evidence: s.signal.evidence })),
    replays: session.snap.view.replays,
    ledger: { records: r.ledger.records.length, chainOk: chain.ok, head: r.ledger.head.slice(0, 12) },
    incident: session.snap.view.incident,
    log: r.log.slice(-30).reverse(),
  };
}

export { CHASED_PAYABLE };
