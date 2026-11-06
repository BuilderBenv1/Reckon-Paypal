import type { AirwallexPort, SandboxSimulator } from '../airwallex/port.js';
import type { Reckon } from '../agent/reckon.js';

export const CHASED_PAYABLE = 'PAY-109-SUB-I2';

/**
 * Sets up "last week's instalment 2" and has the beneficiary's bank return it. Done right before
 * the chase, not at the start: a real sandbox settles a SENT transfer within minutes, and a
 * settled transfer can't be failed. The opening deposit and the payment cancel out, so the
 * rest of the story sees the same balances.
 */
export async function setupReturnedInstalment(reckon: Reckon, sim: SandboxSimulator & { getTransfer: AirwallexPort['getTransfer'] }) {
  await sim.deposit(2500, 'USD', 'Opening balance');
  const prior = await reckon.pay({
    id: CHASED_PAYABLE, job: '109', supplier: 'Brightline Electrical Inc', description: 'Subcontractor instalment 2',
    amount: 2500, currency: 'USD', dueDay: -6, method: 'LOCAL', newPayee: false, acceptsSplit: false, deferPenaltyUSD: 0,
  });
  await sim.transitionTransfer(prior.id, 'SENT');
  await failTransfer(sim, prior.id);
  return prior;
}

/** Fails a SENT transfer with a bank-return reason, retrying once if the sandbox hiccups. */
export async function failTransfer(sim: SandboxSimulator & { getTransfer: AirwallexPort['getTransfer'] }, id: string) {
  try {
    await sim.transitionTransfer(id, 'FAILED', 'ACCOUNT_CLOSED');
  } catch {
    await new Promise((r) => setTimeout(r, 3000));
    const t = await sim.getTransfer(id);
    if (t.status === 'FAILED' || t.status === 'CANCELLED') return;
    if (t.status === 'PAID') throw new Error(`the sandbox settled ${id} before it could be failed`);
    await sim.transitionTransfer(id, 'FAILED', 'ACCOUNT_CLOSED');
  }
}
