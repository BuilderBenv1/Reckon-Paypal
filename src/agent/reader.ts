import Anthropic from '@anthropic-ai/sdk';
import type { Email, EmailSignal, FinanceBook } from '../domain/types.js';

// The model's job here is narrow: read an unstructured email and return one typed fact.
// It never sees balances, never decides what is allowed and never moves money.

export interface EmailReader {
  read(email: Email, book: FinanceBook): Promise<EmailSignal>;
}

const SIGNAL_TOOL = {
  name: 'record_signal',
  description: 'Record the single finance-relevant fact in this email, tied to an id from the open items list.',
  input_schema: {
    type: 'object' as const,
    properties: {
      kind: { type: 'string', enum: ['receipt_delayed', 'split_accepted', 'split_declined', 'payment_not_received', 'short_payment_explained', 'none'] },
      receivableId: { type: 'string', description: 'For receipt_delayed or short_payment_explained: the receivable or invoice id.' },
      payableId: { type: 'string', description: 'For split_accepted, split_declined or payment_not_received: the payable id.' },
      newExpectedDay: { type: 'integer', description: 'For receipt_delayed: days from today when payment is now expected.' },
      reason: { type: 'string', description: 'For short_payment_explained: why the customer paid less, in a few words.' },
      evidence: { type: 'string', description: 'The exact short phrase from the email that supports this, under 20 words.' },
    },
    required: ['kind', 'evidence'],
  },
};

/** The part of the Anthropic client the reader uses, so tests can stand in for it. */
export interface MessagesClient {
  messages: { create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<{ content: Anthropic.ContentBlock[] }> };
}

const SYSTEM = [
  'You read one business email for a finance team and record the single finance-relevant fact in it.',
  'Always answer by calling the record_signal tool exactly once. If the email has no such fact, call it with kind "none".',
  'Use only ids from the open items list. Give dates as whole days from today.',
].join(' ');

/**
 * Uses Claude to extract the signal. Ids and numbers it returns are checked against the book.
 * Some models refuse a forced tool call, so the tool is offered with tool_choice "auto" and a
 * firm instruction; a JSON answer in plain text is accepted as a fallback.
 */
export class ClaudeReader implements EmailReader {
  private client: MessagesClient;
  constructor(
    private model = process.env.RECKON_MODEL ?? 'claude-sonnet-5-5',
    client?: MessagesClient,
  ) {
    this.client = client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async read(email: Email, book: FinanceBook): Promise<EmailSignal> {
    const openItems = [
      ...book.payables.map((p) => `payable ${p.id}: ${p.supplier}, ${p.description}${p.note ? ` (${p.note})` : ''}`),
      ...book.receivables.map((r) => `receivable ${r.id}: ${r.customer}, ${r.milestone}, expected in ${r.expectedDay} days`),
      'payable PAY-109-SUB-I2: Brightline Electrical Inc, subcontractor instalment 2 (sent last week)',
      'invoice HLH-INV-0381: Harbour Lane Hotels',
    ].join('\n');
    const weekday = new Date(`${book.asOf}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 2000,
      system: SYSTEM,
      tools: [SIGNAL_TOOL],
      tool_choice: { type: 'auto' },
      messages: [
        {
          role: 'user',
          content: `Today is ${weekday} ${book.asOf}. Open items:\n${openItems}\n\nEmail from ${email.from}\nSubject: ${email.subject}\n\n${email.body}`,
        },
      ],
    });
    const tool = res.content.find((b) => b.type === 'tool_use' && b.name === SIGNAL_TOOL.name);
    if (tool && tool.type === 'tool_use') return validate(tool.input as Record<string, unknown>, book);
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    const json = text.match(/\{[\s\S]*\}/);
    if (json) {
      try {
        return validate(JSON.parse(json[0]) as Record<string, unknown>, book);
      } catch {
        /* fall through */
      }
    }
    return { kind: 'none', evidence: 'model returned no signal' };
  }
}

/**
 * Deterministic stand-in for the model, keyed on the synthetic emails, so the offline demo
 * and tests run without an API key. Produces exactly what the model is expected to return.
 */
export class FixtureReader implements EmailReader {
  async read(email: Email, book: FinanceBook): Promise<EmailSignal> {
    const table: Record<string, Record<string, unknown>> = {
      'EM-01': { kind: 'receipt_delayed', receivableId: 'REC-109-M3', newExpectedDay: 8, evidence: "it won't go out this week. Expect it the following Tuesday" },
      'EM-02': { kind: 'split_accepted', payableId: 'PAY-121-COMP', evidence: 'Half now and the rest on the 16th works for us' },
      'EM-03': { kind: 'payment_not_received', payableId: 'PAY-109-SUB-I2', evidence: "We still haven't received instalment 2" },
      'EM-04': { kind: 'short_payment_explained', receivableId: 'HLH-INV-0381', reason: 'withheld 250.00 for a snagging item pending sign-off', evidence: 'withheld 250.00 for the snagging item' },
    };
    return validate(table[email.id] ?? { kind: 'none', evidence: 'no finance fact found' }, book);
  }
}

const KNOWN_EXTRA = new Set(['PAY-109-SUB-I2', 'HLH-INV-0381']);

/** Never trust ids or numbers from the model without checking them against the book. */
export function validate(raw: Record<string, unknown>, book: FinanceBook): EmailSignal {
  const evidence = String(raw.evidence ?? '').slice(0, 200);
  const payable = (id: unknown) => typeof id === 'string' && (book.payables.some((p) => p.id === id) || KNOWN_EXTRA.has(id));
  const receivable = (id: unknown) => typeof id === 'string' && (book.receivables.some((r) => r.id === id) || KNOWN_EXTRA.has(id));
  switch (raw.kind) {
    case 'receipt_delayed': {
      const day = Number(raw.newExpectedDay);
      if (!receivable(raw.receivableId) || !Number.isInteger(day) || day < 0 || day > 365) break;
      return { kind: 'receipt_delayed', receivableId: String(raw.receivableId), newExpectedDay: day, evidence };
    }
    case 'split_accepted':
    case 'split_declined':
    case 'payment_not_received':
      if (!payable(raw.payableId)) break;
      return { kind: raw.kind, payableId: String(raw.payableId), evidence };
    case 'short_payment_explained':
      if (!receivable(raw.receivableId)) break;
      return { kind: 'short_payment_explained', receivableId: String(raw.receivableId), reason: String(raw.reason ?? '').slice(0, 200), evidence };
  }
  return { kind: 'none', evidence: evidence || 'signal failed validation' };
}
