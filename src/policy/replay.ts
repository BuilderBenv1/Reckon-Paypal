import { createHash } from 'node:crypto';
import type { Policy } from '../domain/types.js';
import { plan, type Decision } from './plan.js';
import type { CashState } from './state.js';

/** One stored decision with everything needed to reproduce it. */
export interface DecisionRecord {
  decisionId: string;
  recordedAt: string;
  state: CashState;
  policy: Policy;
  decision: Decision;
  /** sha256 over canonical JSON of state + policy + decision. Tamper-evident. */
  hash: string;
  /** Hash of the previous record, so the ledger is a chain. */
  prevHash: string;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function recordDecision(state: CashState, policy: Policy, decision: Decision, prevHash: string, recordedAt: string): DecisionRecord {
  const snapshot = structuredClone(state);
  const hash = sha256(canonical({ state: snapshot, policy, decision, prevHash }));
  return { decisionId: decision.id, recordedAt, state: snapshot, policy: structuredClone(policy), decision: structuredClone(decision), hash, prevHash };
}

export type ReplayResult =
  | { ok: true; decision: Decision }
  | { ok: false; reason: 'tampered' | 'missing' | 'different'; detail: string; replayed?: Decision };

/** Re-runs the planner on the stored inputs and checks it produces the identical decision. */
export function replay(record: DecisionRecord): ReplayResult {
  const expected = sha256(canonical({ state: record.state, policy: record.policy, decision: record.decision, prevHash: record.prevHash }));
  if (expected !== record.hash) return { ok: false, reason: 'tampered', detail: 'Stored inputs or decision no longer match the recorded hash.' };
  const replayed = plan(record.state, record.policy).decisions.find((d) => d.id === record.decisionId);
  if (!replayed) return { ok: false, reason: 'missing', detail: `The planner no longer produces ${record.decisionId} from these inputs.` };
  if (canonical(replayed) !== canonical(record.decision)) {
    return { ok: false, reason: 'different', detail: 'The planner produces a different decision from the same inputs.', replayed };
  }
  return { ok: true, decision: replayed };
}
