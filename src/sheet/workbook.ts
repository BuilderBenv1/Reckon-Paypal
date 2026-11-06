import ExcelJS from 'exceljs';
import type { Currency, FinanceBook, Payable, Project, Receivable, TransferMethod } from '../domain/types.js';

// The finance team's own cashflow workbook is Reckon's main input and output.
// Lesson from a real project business: finance won't double-key into a new dashboard,
// so the agent reads their sheet and writes its decisions back as a new tab.

const PROJECTS = 'Projects';
const CREDITORS = 'Creditors';
const DEBTORS = 'Debtors';
export const DECISIONS = 'Reckon decisions';

const projectCols = ['Job', 'Name', 'Customer', 'Quoted budget (USD)', 'Committed cost (USD)'] as const;
const creditorCols = [
  'ID', 'Job', 'Supplier', 'Description', 'Amount', 'Currency', 'Due (days)', 'Method',
  'New payee', 'Accepts split', 'Defer cost per week (USD)', 'Unlocks', 'Notes',
] as const;
const debtorCols = [
  'ID', 'Job', 'Customer', 'Milestone', 'Amount', 'Currency', 'Status', 'Expected (days)',
  'On-time rate', 'Early-pay eligible', 'Customer email',
] as const;

export interface DecisionRow {
  decisionId: string;
  kind: string;
  target: string;
  amount: string;
  execution: string;
  reason: string;
  replayHash: string;
}

export async function writeBook(path: string, book: FinanceBook, decisions: DecisionRow[] = []): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Reckon';
  wb.created = new Date(`${book.asOf}T08:00:00Z`);

  addSheet(wb, PROJECTS, [...projectCols], book.projects.map((p) => [p.job, p.name, p.customer, p.budgetUSD ?? '', p.committedCostUSD]));
  addSheet(
    wb,
    CREDITORS,
    [...creditorCols],
    book.payables.map((p) => [
      p.id, p.job ?? '', p.supplier, p.description, p.amount, p.currency, p.dueDay, p.method,
      yn(p.newPayee), yn(p.acceptsSplit), p.deferPenaltyUSD, p.unlocksReceivableId ?? '', p.note ?? '',
    ]),
  );
  addSheet(
    wb,
    DEBTORS,
    [...debtorCols],
    book.receivables.map((r) => [
      r.id, r.job, r.customer, r.milestone, r.amount, r.currency, r.status, r.expectedDay,
      r.onTimeRate, yn(r.earlyPayEligible), r.customerEmail,
    ]),
  );
  if (decisions.length) {
    addSheet(
      wb,
      DECISIONS,
      ['Decision', 'Kind', 'Target', 'Amount', 'Execution', 'Reason', 'Replay hash'],
      decisions.map((d) => [d.decisionId, d.kind, d.target, d.amount, d.execution, d.reason, d.replayHash]),
    );
  }
  await wb.xlsx.writeFile(path);
}

export async function readBook(path: string, asOf: string): Promise<FinanceBook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const rows = (name: string) => {
    const ws = wb.getWorksheet(name);
    if (!ws) throw new Error(`Workbook has no "${name}" sheet`);
    const header = (ws.getRow(1).values as unknown[]).slice(1).map(String);
    const out: Record<string, unknown>[] = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const vals = (row.values as unknown[]).slice(1);
      out.push(Object.fromEntries(header.map((h, i) => [h, vals[i] ?? ''])));
    });
    return out;
  };

  const projects: Project[] = rows(PROJECTS).map((r) => ({
    job: str(r['Job']),
    name: str(r['Name']),
    customer: str(r['Customer']),
    budgetUSD: r['Quoted budget (USD)'] === '' ? null : num(r['Quoted budget (USD)']),
    committedCostUSD: num(r['Committed cost (USD)']),
  }));
  const payables: Payable[] = rows(CREDITORS).map((r) => {
    const p: Payable = {
      id: str(r['ID']),
      job: r['Job'] === '' ? null : str(r['Job']),
      supplier: str(r['Supplier']),
      description: str(r['Description']),
      amount: num(r['Amount']),
      currency: str(r['Currency']) as Currency,
      dueDay: num(r['Due (days)']),
      method: str(r['Method']) as TransferMethod,
      newPayee: str(r['New payee']) === 'Yes',
      acceptsSplit: str(r['Accepts split']) === 'Yes',
      deferPenaltyUSD: num(r['Defer cost per week (USD)']),
    };
    if (r['Unlocks'] !== '') p.unlocksReceivableId = str(r['Unlocks']);
    if (r['Notes'] !== '') p.note = str(r['Notes']);
    return p;
  });
  const receivables: Receivable[] = rows(DEBTORS).map((r) => ({
    id: str(r['ID']),
    job: str(r['Job']),
    customer: str(r['Customer']),
    milestone: str(r['Milestone']),
    amount: num(r['Amount']),
    currency: str(r['Currency']) as Currency,
    status: str(r['Status']) as Receivable['status'],
    expectedDay: num(r['Expected (days)']),
    onTimeRate: num(r['On-time rate']),
    earlyPayEligible: str(r['Early-pay eligible']) === 'Yes',
    customerEmail: str(r['Customer email']),
  }));
  return { asOf, projects, payables, receivables };
}

function addSheet(wb: ExcelJS.Workbook, name: string, header: string[], data: unknown[][]) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.addRow(header).font = { bold: true };
  for (const row of data) ws.addRow(row);
  ws.columns.forEach((c, i) => {
    const longest = Math.max(header[i]?.length ?? 8, ...data.map((r) => String(r[i] ?? '').length));
    c.width = Math.min(60, longest + 2);
  });
}

const yn = (b: boolean) => (b ? 'Yes' : 'No');
const str = (v: unknown) => (typeof v === 'object' && v !== null && 'text' in v ? String((v as { text: unknown }).text) : String(v));
const num = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Expected a number, got "${String(v)}"`);
  return n;
};
