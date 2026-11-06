# Reckon

**A finance agent for project businesses that closes a cash gap instead of just rationing it. Runs on PayPal.**

Most cash tools decide who doesn't get paid. Reckon also goes and gets money. It works from the finance team's own spreadsheet. It ranks every payment by what paying it unlocks on its project, holds unbudgeted spend for the MD, and prices every way to close the gap: an early-payment discount sent as a PayPal invoice, a split with a supplier who has agreed before, a deferral that costs nothing. Then it does the cheapest combination, pays suppliers by PayPal Payouts, and replans when PayPal tells it a customer has paid.

Every decision can be replayed from its stored inputs to the identical answer.

## How PayPal and AI are used

| Reckon does | PayPal | Claude |
| --- | --- | --- |
| Reads cash each morning | Reporting API, `GET /v1/reporting/balances` | |
| Pulls cash in early | Invoicing v2: creates and sends a discounted invoice, reminds, reads its status | Drafts the offer email; code checks every number and the link survive |
| Pays suppliers, including half of a split | Payouts, `POST /v1/payments/payouts` with the request id as `sender_batch_id`, so one decision can never pay twice | Drafts the split request to the supplier |
| Replans when the world answers | Webhooks: `INVOICING.INVOICE.PAID`, `PAYMENT.PAYOUTS-ITEM.*`, each verified with `POST /v1/notifications/verify-webhook-signature` | Reads customer and supplier emails into one typed signal (a delay, a split agreed, a payment not received) |
| Handles a returned payment | Reads the payout item state; a returned or failed payout is the only thing that allows a replacement | |

The model never decides an amount, a limit or what is allowed. Money logic is in `src/policy/`, which is pure and deterministic. Claude reads and writes words; code decides and PayPal moves the money.

## Try it

**Hosted demo: [reckon-paypal.vercel.app](https://reckon-paypal.vercel.app)**

Open it and press **Watch the guided demo**: a narrator plays the whole story by itself, pressing each button and saying what changed. Or click through it yourself, one step at a time: the MD's brief, approvals bound to exact terms, what each new fact changed, every decision with a replay button, and the money that moved.

Demo runs use an in-memory PayPal stand-in, so anyone can try them with no account. Live runs (behind an access code) make real PayPal sandbox calls: real payouts, a real invoice the customer pays, and PayPal webhooks that replan the agent on their own. Every PayPal call was checked against the real sandbox on 6 Nov 2026 (9/9, `npm run sandbox:smoke`).

To run it locally:

```
npm install
npm run dev            # http://localhost:3000
```

Without any keys it runs demo runs only. Add the PayPal and Supabase variables (below) for live runs.

## The story in one run (terminal, no keys)

```
npm run seed:sheet     # builds the synthetic finance workbook and reconciliation fixture
npm run demo:offline   # the whole story against the in-memory stand-in
npm test
```

1. **Morning read.** Reads the finance team's workbook and reconciles 26 bank lines. One unreferenced deposit is left for a person.
2. **Plan.** It holds an $8,175 deposit because Job 117 has no quoted budget and the payee is new. A $5,890 freight bill ranks first because paying it releases a $24,000 milestone on Job 114.
3. **New information.** A customer email says a $9,000 milestone slips a week. The gap opens at $3,220, forecast confidence drops, and the autonomous payment limit falls from $7,000 to $5,000, so the freight payout now needs the MD. The screen shows exactly which decisions moved.
4. **Close the gap for $200.** Reckon defers a renewal in its grace period, asks a supplier who has agreed before to split, and sends a PayPal invoice offering 1.5% off a $12,000 invoice due in 21 days.
5. **MD brief.** The MD approves the freight payout exactly as shown; the approval is void if any term changes.
6. **The world answers.** The customer pays the PayPal invoice; the webhook replans Reckon. The supplier agrees to split and the first half goes out by Payouts. The reserve floor holds.
7. **Never pay twice.** A supplier chases last week's payment. Reckon checks PayPal first. The original came back, so it sends one replacement with a new request id. A second chase finds the replacement in flight and pays nothing.
8. **Back to the sheet.** Decisions are written to a new tab in the finance team's workbook.
9. **Prove it.** Any decision replays to the identical answer; a tampered record is detected; the ledger is hash-chained.

## Running against the PayPal sandbox

1. At developer.paypal.com, create a sandbox **business** account (Reckon's business) and a sandbox **personal** account (the customer who pays the invoice). Under Apps & Credentials, create a sandbox REST app on the business account with **Invoicing, Payouts and Transaction Search** enabled.
2. Copy `.env.example` to `.env` and add `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`. Never commit `.env`.
3. Run `npm run sandbox:smoke`. It makes every call Reckon makes (balances, a $1 payout, a repeated request id that must be refused, a $1 invoice, a reminder) and prints the exact PayPal error for anything that fails.
4. For the paid-invoice step, open the invoice's payer link signed in as the sandbox personal account and pay it.

**Story-sized balances.** A sandbox business account can hold far more than the story's business, so a real cash gap would never appear. Live runs plan from the business's own operating balance instead: every call goes to PayPal, and an operating envelope (`src/bank/envelope.ts`) moves the story balance with each real payout, returned payout and paid invoice.

**Returned payments on the real sandbox.** Payouts to the invented supplier emails sit UNCLAIMED. Cancelling an unclaimed payout returns it, which is how the returned-payment incident runs live. Set `PAYPAL_SANDBOX_RECEIVER` only if you want every payout to settle into your sandbox personal account instead.

## Hosting on Vercel

1. **Supabase.** Create a free project (or reuse one: the tables are prefixed `reckon_pp_`) and run `supabase/migrations/0001_reckon.sql` (and `0002_narration.sql` for the cached narrator voice) in its SQL editor.
2. **Vercel.** Import this repo (detected as Next.js) and add:

| Variable | Needed for | Notes |
| --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Everything on Vercel | Without them, runs are kept in server memory |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Live runs | Sandbox REST app; without them only demo runs are offered |
| `RECKON_LIVE_CODE` | Live runs | Access code people must enter to start a live run |
| `PAYPAL_WEBHOOK_ID` | Live runs | Id of the webhook in step 3, used to verify each delivery |
| `ANTHROPIC_API_KEY` | Claude | Reads emails and drafts messages |
| `RECKON_DEMO_CLAUDE` | Optional | `1` lets public demo runs use Claude too (capped at 40 calls a run) |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | Optional | Human voice for the guided demo |
| `CRON_SECRET` | Optional | Locks the daily keep-alive ping |

3. **PayPal webhook.** On the sandbox app, add a webhook for `https://<your-app>.vercel.app/api/webhooks/paypal` with `INVOICING.INVOICE.PAID`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `PAYMENT.PAYOUTS-ITEM.FAILED`, `PAYMENT.PAYOUTS-ITEM.RETURNED`, `PAYMENT.PAYOUTS-ITEM.UNCLAIMED` and `PAYMENT.PAYOUTSBATCH.SUCCESS`. Copy its id into `PAYPAL_WEBHOOK_ID` and redeploy. Without the webhook, the page checks the invoice every few seconds instead.

## How it's built

```
app/           Next.js page and API routes: run, action, PayPal webhook
src/
  paypal/      the PayPal REST client
  bank/        the bank port, the in-memory stand-in and the operating envelope
  domain/      types, synthetic seed data, synthetic payees
  policy/      the planner (pure), diff, replay and hashing
  recon/       deterministic reconciliation and its fixture
  sheet/       read and write the finance team's workbook
  ledger/      decision ledger, approvals bound to terms, never-pay-twice lock
  agent/       the loop: plan, record, execute what policy allows, react to emails and payments;
               Claude email reader and message drafter, both checked by code
  demo/        the story as a saved session, shared by the web app and the scripts
  store/       run storage between requests (Supabase, or memory locally)
  webhooks/    PayPal event handling
  web/         what the page shows, built server-side
scripts/       seed, offline demo, sandbox smoke test
data/          synthetic workbook, emails and reconciliation fixture
```

- **The planner is pure.** `plan(state, policy)` has no I/O, so the same inputs always give the same plan. That's what makes replay possible.
- **The model is narrow.** Every id and number Claude returns is validated against the book. Without an API key, a deterministic fixture reader stands in.
- **Money moves only through the bank port,** and only for decisions the planner made and the ledger allows.
- **Serverless-safe.** Each request restores the run from its saved snapshot, acts, and saves it with an optimistic version check, so a webhook landing mid-request is retried rather than overwritten.
- **Policy in one place.** Thresholds and lever costs are `defaultPolicy` in `src/domain/seed.ts`.

All data is synthetic. No real business, customer or supplier appears anywhere in this repo.

## Licence

MIT
