import Anthropic from '@anthropic-ai/sdk';
import type { MessagesClient } from './reader.js';

// Claude may reword an outgoing email, but the numbers come from code. A draft is accepted only
// if it keeps every amount, percentage and link from the template exactly and adds none of its own.

export interface DraftInput {
  to: string;
  subject: string;
  body: string;
}

export interface DraftResult {
  body: string;
  by: 'claude' | 'template';
  /** Why a Claude draft was rejected, when it was. */
  rejected?: string;
}

const URL_RE = /https?:\/\/\S+/g;
const NUM_RE = /\d[\d,]*(?:\.\d+)?/g;

/** Numbers as written, normalised (commas removed, trailing .00 dropped). URLs are excluded. */
export function numbersIn(text: string): string[] {
  const withoutUrls = text.replace(URL_RE, ' ');
  return (withoutUrls.match(NUM_RE) ?? []).map((n) => {
    const plain = n.replace(/,/g, '');
    return plain.includes('.') ? String(Number(plain)) : plain;
  });
}

const urlsIn = (text: string) => text.match(URL_RE) ?? [];

/** Accepts a draft only if its numbers and links are exactly the template's. */
export function checkDraft(template: string, draft: string): string | null {
  const want = numbersIn(template).sort();
  const got = numbersIn(draft).sort();
  const missing = want.filter((n) => !got.includes(n));
  const extra = got.filter((n) => !want.includes(n));
  if (missing.length) return `dropped or changed ${missing.join(', ')}`;
  if (extra.length) return `added ${extra.join(', ')}`;
  for (const u of urlsIn(template)) if (!draft.includes(u)) return 'changed the payment link';
  if (draft.length > template.length * 3 + 400) return 'too long';
  return null;
}

export interface Drafter {
  draft(input: DraftInput): Promise<DraftResult>;
}

export class TemplateDrafter implements Drafter {
  async draft(input: DraftInput): Promise<DraftResult> {
    return { body: input.body, by: 'template' };
  }
}

const SYSTEM = [
  'You rewrite short business emails for the finance team of a UK project-based business.',
  'Write plainly and warmly, like a person who knows the supplier or customer. British English. No sign-off name other than "Accounts".',
  'Keep every amount, percentage, currency code and link exactly as given. Do not add any number, date, promise or fact that is not in the original.',
  'Reply with the email body only.',
].join(' ');

export class ClaudeDrafter implements Drafter {
  private client: MessagesClient;
  constructor(private model = process.env.RECKON_MODEL ?? 'claude-sonnet-5-5', client?: MessagesClient) {
    this.client = client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async draft(input: DraftInput): Promise<DraftResult> {
    try {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 1200,
        system: SYSTEM,
        messages: [{ role: 'user', content: `To: ${input.to}\nSubject: ${input.subject}\n\n${input.body}` }],
      });
      const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n').trim();
      if (!text) return { body: input.body, by: 'template', rejected: 'empty draft' };
      const problem = checkDraft(input.body, text);
      if (problem) return { body: input.body, by: 'template', rejected: problem };
      return { body: text, by: 'claude' };
    } catch (err) {
      return { body: input.body, by: 'template', rejected: (err as Error).message.slice(0, 120) };
    }
  }
}
