// The demo story, shared by the offline and live runners.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { defaultPolicy, seedBalances, seedRates } from '../src/domain/seed.js';
import type { Email } from '../src/domain/types.js';
import type { AirwallexPort, SandboxSimulator } from '../src/airwallex/port.js';
import type { EmailReader } from '../src/agent/reader.js';
import { Reckon } from '../src/agent/reckon.js';
import { initialState } from '../src/policy/state.js';
import type { Plan } from '../src/policy/plan.js';
import type { DecisionChange } from '../src/policy/diff.js';
import { fmt } from '../src/policy/money.js';
import { replay } from '../src/policy/replay.js';
import { reconcile } from '../src/recon/match.js';
import type { ReconFixture } from '../src/recon/types.js';
import { readBook, writeBook } from '../src/sheet/workbook.js';
import { setupReturnedInstalment } from '../src/demo/incident.js';

export const AS_OF = '2026-11-02';

export interface StoryOptions {
  awx: AirwallexPort & SandboxSimulator & { calls?: string[] };
  reader: EmailReader;
  /** Called when the customer needs to pay the early-pay link. Resolves once it's paid. */
  payLink: (linkId: string, url: string) => Promise<void>;
  newId: () => string;
  clock: () => string;
  outDir: string;
}

const h = (title: string) => console.log(`\n\x1b[1m== ${title} ==\x1b[0m`);
const email = async (file: string) => JSON.parse(await readFile(`data/emails/${file}`, 'utf8')) as Email;

export async function runStory(o: StoryOptions): Promise<Reckon> {
  const { awx } = o;
  const book = await readBook('data/finance.xlsx', AS_OF);
  const reckon = new Reckon(initialState(book, seedBalances, seedRates), defaultPolicy, awx, o.reader, o.clock, o.newId);

  const showPlan = (p: Plan) => {
    const s = p.summary;
    console.log(
      `cash ${fmt(s.cashUSD, 'USD')} | floor ${fmt(s.reserveFloorUSD, 'USD')} | due ${fmt(s.dueInHorizonUSD, 'USD')} | held ${fmt(s.heldUSD, 'USD')} | ` +
        `trusted receipts ${fmt(s.expectedReceiptsUSD, 'USD')} | gap ${fmt(s.gapUSD, 'USD')} | levers cost ${fmt(s.leversCostUSD, 'USD')} | confidence ${s.forecastConfidence}`,
    );
    for (const d of p.decisions) console.log(`  ${d.id.padEnd(28)} ${d.execution.padEnd(8)} ${d.status.padEnd(7)} ${d.reason}`);
  };
  const showDiff = (changes: DecisionChange[]) => {
    if (!changes.length) return console.log('  (no decisions changed)');
    for (const c of changes) {
      const detail = c.fields.map((f) => `${f.field}: ${JSON.stringify(f.before)} -> ${JSON.stringify(f.after)}`).join('; ');
      // A decision that vanished because it was carried out is done, not dropped.
      const label = c.change === 'removed' && reckon.ledger.executed.has(c.id) ? 'done' : c.change;
      console.log(`  ${label.padEnd(8)} ${c.id}${detail ? `  (${detail})` : ''}`);
    }
  };

  await reckon.refreshBalances();

  h("1. Morning read: the finance team's sheet, balances and overnight receipts");
  const remittance = await reckon.ingestEmail(await email('04-harbour-remittance.json'));
  const recon = reconcile(JSON.parse(await readFile('data/recon.json', 'utf8')) as ReconFixture, [remittance]);
  const counts = recon.reduce<Record<string, number>>((m, r) => ((m[r.kind] = (m[r.kind] ?? 0) + 1), m), {});
  console.log(`Reconciled ${recon.length} bank lines:`, counts);
  for (const r of recon.filter((x) => x.kind !== 'exact')) console.log(`  ${r.lineId} ${r.kind.padEnd(13)} ${r.needsPerson ? 'PERSON' : 'auto  '} ${r.explanation}`);

  h('2. 08:30 plan (executes at the 09:00 cut-off)');
  showPlan(reckon.plan().plan);

  h('3. 08:42 email: Westfield milestone slips a week');
  await reckon.ingestEmail(await email('01-westfield-delay.json'));
  const v2 = reckon.plan();
  showPlan(v2.plan);
  console.log('What changed:');
  showDiff(v2.changes);

  h('4. 09:00 execute what policy allows');
  const run1 = await reckon.execute(v2.plan);
  console.log('Executed:', run1.executed);
  console.log('\nMD brief:\n' + reckon.brief());
  console.log('\nOutbox:');
  for (const m of reckon.outbox) console.log(`  to ${m.to}: ${m.subject}`);

  h('5. MD approves the EUR conversion as shown; the deposit stays held');
  reckon.approve('convert:EUR', 'MD');
  const run2 = await reckon.run();
  console.log('Executed:', run2.executed);
  console.log('Still with the MD:', run2.awaitingApproval.map((d) => d.id));

  h('6. Customer pays the early-pay link; supplier agrees to split');
  const linkId = reckon.links.get('REC-121-INV');
  if (!linkId) throw new Error('No early-pay link was sent');
  const link = await awx.getPaymentLink(linkId);
  await o.payLink(linkId, link.url);
  console.log('Paid links:', await reckon.checkLinks());
  showDiff(reckon.plan().changes);
  await reckon.ingestEmail(await email('02-pennine-split-yes.json'));
  const run3 = await reckon.run();
  console.log('After the split reply:');
  showDiff(run3.changes);
  console.log('Executed:', run3.executed);
  const after = await awx.balances();
  console.log(`Operating balances now: ${fmt(after.USD, 'USD')}, ${fmt(after.EUR, 'EUR')}, ${fmt(after.GBP, 'GBP')}`);
  const final = reckon.plan().plan;
  console.log(`Cash ${fmt(final.summary.cashUSD, 'USD')} vs floor ${fmt(final.summary.reserveFloorUSD, 'USD')}: ${final.summary.cashUSD >= final.summary.reserveFloorUSD ? 'floor holds' : 'FLOOR BREACHED'}`);

  h("7. Supplier chases last week's instalment");
  try {
    const prior = await setupReturnedInstalment(reckon, awx);
    console.log(`Last week's instalment 2: ${prior.id}, sent, then returned by the beneficiary's bank (account closed).`);
    await reckon.ingestEmail(await email('03-brightline-not-received.json'));
    const incident = await reckon.handleNotReceived('PAY-109-SUB-I2');
    console.log('Outcome:', incident.outcome, incident.outcome === 'replaced' ? `${incident.original.id} -> ${incident.replacement.id}` : incident.outcome === 'blocked' ? incident.reason : '');
    const again = await reckon.handleNotReceived('PAY-109-SUB-I2');
    console.log('Second chase:', again.outcome, '(no second payment)');
    console.log('Attempts:', reckon.paymentAttempts().filter((a) => a.payableId === 'PAY-109-SUB-I2').map((a) => `${a.transferId} ${a.status}`).join(' | '));
  } catch (err) {
    console.log(`Step 7 could not complete against the sandbox: ${(err as Error).message}`);
    console.log('Carrying on with steps 8 and 9.');
  }

  h("8. Decisions written back to the finance team's sheet");
  await mkdir(o.outDir, { recursive: true });
  const rows = reckon.ledger.records.map((r) => ({
    decisionId: r.decisionId,
    kind: r.decision.kind,
    target: r.decision.target,
    amount: fmt(r.decision.amount, r.decision.currency),
    execution: reckon.ledger.executed.has(r.decisionId) ? 'done' : r.decision.execution,
    reason: r.decision.reason,
    replayHash: r.hash.slice(0, 16),
  }));
  await writeBook(`${o.outDir}/finance-after.xlsx`, book, rows);
  console.log(`Wrote ${o.outDir}/finance-after.xlsx with ${rows.length} decision rows.`);

  h('9. Replay');
  for (const id of ['convert:EUR', 'early_pay_link:REC-121-INV', 'hold:PAY-117-DEPOSIT']) {
    const r = reckon.replay(id);
    console.log(`  ${id.padEnd(28)} ${r.ok ? 'identical decision from stored inputs' : `${r.reason}: ${r.detail}`}`);
  }
  console.log('  ledger chain:', reckon.ledger.verifyChain().ok ? 'intact' : 'BROKEN');
  const tampered = structuredClone(reckon.ledger.latestRecord('convert:EUR')!);
  tampered.policy.autonomousFxLimitUSD.low = 10000;
  const t = replay(tampered);
  console.log('  tampered copy:', t.ok ? 'accepted (BAD)' : t.reason);

  await writeFile(
    `${o.outDir}/run.json`,
    JSON.stringify({ log: reckon.log, outbox: reckon.outbox, attempts: reckon.paymentAttempts(), calls: awx.calls ?? [] }, null, 2),
  );
  console.log(`\nFull log in ${o.outDir}/run.json`);
  return reckon;
}
