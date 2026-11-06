# Reckon

**A finance agent for project businesses that closes a cash gap instead of just rationing it.**

Built on Airwallex APIs for the Agentic Banking Hackathon 2026 (Track 1, Adaptive Treasury Controller).

Most treasury agents decide who doesn't get paid. Reckon also goes and gets money. It works from the finance team's own spreadsheet. It ranks every payment by what paying it unlocks on its project, holds unbudgeted spend for the MD, and prices every way to close the gap: an early-payment discount sent as an Airwallex payment link, a split with a supplier who has agreed before, a deferral that costs nothing, FX timing. Then it does the cheapest combination, and replans when customers pay and suppliers reply.

Every decision can be replayed from its stored inputs to the identical answer.

## Try it

The hosted app walks through the whole story one step at a time: the MD's brief, approvals bound to exact terms, what each new fact changed, every decision with a replay button, and the money that moved. Demo runs use a simulated Airwallex, so anyone can click through; live runs make real Airwallex sandbox calls and receive webhooks.

**Watch the guided demo** plays the same story by itself: a narrator presses each button, highlights what changed and says what to notice. With `ELEVENLABS_API_KEY` set it uses a human ElevenLabs voice: each line is voiced once, cached in the Supabase `narration` bucket and served from there afterwards, and only lines the demo itself says can be voiced (`src/web/voice.ts`). To choose the voice, open `/voices`: each shortlisted voice reads the same line of the script, and its ID goes in `ELEVENLABS_VOICE_ID`. Without a key it falls back to the browser's own voices. Add `?short` to the page address to skip the spoken introduction, or `?handoff` for a live audience: it leaves Airwallex out, says the presenter (`RECKON_PRESENTER`) has just built it, and hands over to them at the end. **Guided live run** (on the start page, with the live access code) plays the same tour on the real Airwallex sandbox: it pauses at the payment link for you to pay it with test card 4035501000000008, then carries on by itself once the payment lands.

```
npm install
npm run dev            # http://localhost:3000
```

## The story in one run (terminal)

```
npm run seed:sheet     # builds the synthetic finance workbook and reconciliation fixture
npm run demo:offline   # replays the whole story against an in-memory Airwallex
npm test
```

1. **Morning read.** Reads the finance team's workbook and reconciles 26 bank lines. It catches one payment covering two invoices, a short payment the customer explained by email, an EUR bank-charge difference, and a look-alike duplicate that is really instalment 2 of 3. One unreferenced deposit is left for a person.
2. **Plan.** It holds an EUR 7,500 deposit because Job 117 has no quoted budget and the payee is new. The EUR 5,400 freight bill ranks first because paying it releases a $24,000 milestone on Job 114.
3. **New information.** A customer email says a $9,000 milestone slips a week. Forecast confidence drops, the gap opens at $3,229, and the autonomous FX limit falls from $5,000 to $2,000. The screen shows exactly the six decisions that moved.
4. **Close the gap for $200.** Reckon defers a renewal that's in its grace period, asks a supplier who has agreed before to split, and sends a 1.5% early-payment link for a $12,000 invoice due in 21 days.
5. **MD brief.** One paragraph and two decisions. The MD approves the exact EUR conversion as shown; the approval is void if any term changes.
6. **The world answers.** The customer pays the link and the supplier agrees to split. Reckon replans, pays in rank order, converts only what each payment needs (SWIFT fees included), and the reserve floor holds.
7. **Never pay twice.** A supplier chases last week's payment. Reckon checks Airwallex first. The original was cancelled (account closed), so it sends one replacement under a duplicate lock with a new request id. A second chase finds the replacement in flight and pays nothing.
8. **Back to the sheet.** Decisions are written to a new tab in the finance team's workbook, where they already work.
9. **Prove it.** Any decision replays from its stored inputs to the identical answer; a tampered record is detected; the ledger is hash-chained.

## Where literal entrants go wrong, and what Reckon does instead

| The literal approach | Reckon |
| --- | --- |
| Hand-label one bill "critical" | Priority comes from what a payment unlocks on its project |
| Only decide who waits | Prices every lever, including pulling cash in with a payment link |
| Five loose invoices | Jobs, budgets, milestones and payment plans |
| A new dashboard to edit | Reads the finance team's workbook and writes back to it |
| Approve/deny buttons | Approval bound to amount, currency, target and the reason shown |
| Model does the maths | Money in code; the model reads emails and drafts messages |
| Recompute everything | Shows a diff of exactly which decisions moved |
| "Trust me" logs | Replayable, hash-chained decisions |

## How it's built

```
app/           Next.js page and API routes: run, action, Airwallex webhook
src/
  domain/      types, synthetic seed data, synthetic payees
  policy/      the planner (pure), diff, replay and hashing
  recon/       deterministic reconciliation and its fixture
  sheet/       read and write the finance team's workbook
  airwallex/   one port: REST client for the sandbox, plus an in-memory fake
  ledger/      decision ledger, approvals bound to terms, never-pay-twice lock
  agent/       the loop: plan, record, execute what policy allows, react to emails and payments;
               Claude email reader and message drafter, both checked by code
  demo/        the story as a saved session, shared by the web app and the scripts
  store/       run storage between requests (Supabase, or memory locally)
  webhooks/    Airwallex signature check and event handling
  web/         what the page shows, built server-side
scripts/       seed, offline demo, sandbox smoke test
data/          synthetic workbook, emails and reconciliation fixture
```

- **The planner is pure.** `plan(state, policy)` has no I/O, so the same inputs always give the same plan. That's what makes replay possible.
- **The model is narrow.** Claude reads an email and returns one typed signal (a delay, a split accepted, a payment not received). Every id and number it returns is validated against the book, and the planner decides what the signal means. Without an API key, a deterministic fixture reader stands in.
- **Money moves only through the Airwallex port,** and only for decisions the planner made and the ledger allows.
- **Claude drafts the supplier and customer emails, but the numbers are code's.** A draft is used only if it keeps every amount, percentage and link from the template exactly and adds none; otherwise the template goes out.
- **Serverless-safe.** Each request restores the run from its saved snapshot, acts, and saves it with an optimistic version check, so a webhook landing mid-request is retried rather than overwritten.

## Running against the Airwallex sandbox

1. Create a sandbox account at sandbox.airwallex.com, then go to **Account > Developer > API keys**.
2. Copy `.env.example` to `.env` and add the keys. Never commit `.env`.
3. Run `npm run sandbox:smoke`. It exercises every call Reckon makes, one step at a time, and prints the exact API error for any that fail. Field names were checked against the Airwallex API reference; the smoke test confirms them against your sandbox.
4. Run `npm run demo:live` for the whole story against the sandbox. Every conversion, beneficiary, transfer, simulated failure and payment link is a real sandbox call. Midway, the customer's early-pay link opens in your browser: pay it with test card 4035501000000008 (any future expiry, any CVC) and the story carries on.

A new sandbox starts with millions in every currency, so a real cash gap would never appear. The live run plans from the business's own operating balance instead: every call goes to Airwallex, and an operating envelope moves the story-sized balance with each real conversion, transfer, cancellation, deposit and paid link.

Use a **scoped API key** with read and write on Core Resources, Simulations, Payment Acceptance, Payouts and Transactional FX. Admin keys are disabled on new sandbox accounts.

## Hosting on Vercel

1. **Supabase.** Create a free project, then run `supabase/migrations/0001_reckon.sql` in its SQL editor. Copy the project URL and the service role key (Project settings > API).
2. **Vercel.** Import the GitHub repo. It's detected as Next.js; no build settings to change. Add these environment variables:

| Variable | Needed for | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | Everything on Vercel | Without it, runs are kept in server memory and reset between requests |
| `SUPABASE_SERVICE_ROLE_KEY` | Everything on Vercel | Server-side only; never exposed to the browser |
| `AWX_CLIENT_ID`, `AWX_API_KEY` | Live runs | Sandbox scoped key; without them only demo runs are offered |
| `RECKON_LIVE_CODE` | Live runs | Access code people must enter to start a live run |
| `AIRWALLEX_WEBHOOK_SECRET` | Live runs | The webhook's secret from Airwallex (step 3) |
| `ANTHROPIC_API_KEY` | Claude | Live runs use Claude to read emails and draft messages |
| `RECKON_DEMO_CLAUDE` | Optional | Set to `1` to let public demo runs use Claude too (capped at 40 calls a run) |
| `ELEVENLABS_API_KEY` | Optional | Human voice for the guided demo; about 3,800 characters to voice the whole tour once |
| `ELEVENLABS_VOICE_ID` | Optional | Defaults to George (`JBFqnCBsd6RMkjVDRZzb`) |
| `CRON_SECRET` | Optional | Locks the daily keep-alive ping to Vercel's scheduler |

3. **Airwallex webhook.** In the sandbox web app, go to Developer > Webhooks and add `https://<your-app>.vercel.app/api/webhooks/airwallex` for `payment_intent.succeeded`, `payout.transfer.paid`, `payout.transfer.failed` and `payout.transfer.cancelled`. Copy its secret into `AIRWALLEX_WEBHOOK_SECRET` and redeploy. Paying the customer's link then replans the agent on its own; without the webhook, the page checks the link every few seconds instead.

All data is synthetic. No real business, customer or supplier appears anywhere in this repo.

## Licence

MIT
