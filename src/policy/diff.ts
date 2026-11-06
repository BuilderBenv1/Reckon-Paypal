import type { Decision, Plan } from './plan.js';

export interface DecisionChange {
  id: string;
  change: 'added' | 'removed' | 'changed';
  fields: { field: keyof Decision; before: unknown; after: unknown }[];
  before?: Decision;
  after?: Decision;
}

const WATCHED: (keyof Decision)[] = ['kind', 'amount', 'currency', 'execution', 'status', 'dependsOn'];

/** What moved between two plans, so the screen can show only the decisions new facts changed. */
export function diffPlans(before: Plan, after: Plan): DecisionChange[] {
  const a = new Map(before.decisions.map((d) => [d.id, d]));
  const b = new Map(after.decisions.map((d) => [d.id, d]));
  const out: DecisionChange[] = [];
  for (const [id, d] of b) {
    const prev = a.get(id);
    if (!prev) {
      out.push({ id, change: 'added', fields: [], after: d });
      continue;
    }
    const fields = WATCHED.filter((f) => JSON.stringify(prev[f]) !== JSON.stringify(d[f])).map((f) => ({ field: f, before: prev[f], after: d[f] }));
    if (fields.length) out.push({ id, change: 'changed', fields, before: prev, after: d });
  }
  for (const [id, d] of a) if (!b.has(id)) out.push({ id, change: 'removed', fields: [], before: d });
  return out.sort((x, y) => x.id.localeCompare(y.id));
}
