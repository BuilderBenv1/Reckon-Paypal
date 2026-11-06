# Reckon on PayPal: notes for Claude Code

Entry for the PayPal AI Hackathon (Devpost). Submission due Thu 12 Nov 2026, 12:00pm PST (8:00pm UK).
Needs: project that meaningfully uses PayPal (sandbox) and AI; hosted demo URL or run instructions; this public repo with README and MIT licence; public YouTube video under 3 minutes.

## Commands

- `npm run dev` / `npm run build`: the Next.js web app (MD brief, approvals, diff, replay, story steps)
- `npm test`: vitest suite; must stay green
- `npm run typecheck`
- `npm run seed:sheet`: rebuild `data/finance.xlsx` and `data/recon.json` from `src/domain/seed.ts` and `src/recon/fixture.ts`. Run it after any seed change; `demo:offline` reads the workbook.
- `npm run demo:offline`: the full story against `FakeBank`, no keys
- `npm run sandbox:smoke`: every PayPal call against the real sandbox (needs `.env`). Not yet run against a real sandbox.

## Rules

- **Money logic lives in code, never in the model.** Amounts, limits, ordering and approvals are in `src/policy/`. The model only reads emails into typed `EmailSignal`s (validated in `src/agent/reader.ts`) and drafts message wording.
- **`plan(state, policy)` must stay pure and deterministic.** No I/O, no clocks, no randomness. Replay depends on it.
- **Never pay twice.** Every payout goes through `Ledger.beginPayment`. The request id is the payout's `sender_batch_id`, which PayPal refuses to reuse. On an ambiguous failure, look the payout up before doing anything else. New UUID per new operation; reuse it only for a retry of the same one.
- **Synthetic data only.** No real client, customer or supplier names or figures anywhere in the repo, the video or the README. The origin story is "a UK project-based business", unnamed.
- **One currency on PayPal.** PayPal has no conversion API, so the story books are USD only and the planner never emits `convert`. `PayPalRest.quote/convert` throw. The autonomous payment limit drops with forecast confidence (`autonomousPaymentLimitUSD.{high,low}`), which is what sends the freight payout to the MD after the delay email.
- **Live runs plan from story-sized balances.** `src/bank/envelope.ts` sends every call to the real sandbox but reports an operating balance that starts at `seedBalances` and moves with each real payout, returned payout and paid invoice.
- **Payout states** (`payoutStatus` in `src/paypal/rest.ts`): SUCCESS → PAID; UNCLAIMED → SENT; PENDING/ONHOLD → PROCESSING; FAILED/BLOCKED → FAILED; RETURNED/REFUNDED/REVERSED → CANCELLED. Only FAILED or CANCELLED allows a replacement.
- **Returned payment on the real sandbox:** payouts to the invented supplier emails sit UNCLAIMED; `transitionTransfer(id, 'FAILED')` cancels the unclaimed item, which returns it. Leave `PAYPAL_SANDBOX_RECEIVER` unset for the full story.
- **Never commit keys.** `.env` is gitignored; use `.env.example` for new variables.
- PayPal field names in `src/paypal/rest.ts` follow the REST reference but have not been confirmed against a live sandbox yet. `npm run sandbox:smoke` is that check.

## Web app

- `app/` is thin: pages and API routes call `src/web/server.ts`. All behaviour lives in `src/demo/session.ts` (one run, saved as a snapshot between requests) and `src/web/view.ts` (what the page shows, from a fresh pure plan).
- Runs are stored by `src/store/runs.ts`: Supabase over REST with an optimistic `version` check, or memory without Supabase env vars. `withRun` retries on conflict.
- Webhooks: `app/api/webhooks/paypal` checks the five `paypal-*` signature headers (cert URL must be on paypal.com), verifies the delivery with `POST /v1/notifications/verify-webhook-signature` using `PAYPAL_WEBHOOK_ID`, dedupes on event id, then `src/webhooks/paypal.ts` applies it: `INVOICING.INVOICE.PAID` → check invoices and replan; `PAYMENT.PAYOUTS-ITEM.*` / `PAYMENT.PAYOUTSBATCH.*` → sync that payout.
- Demo runs never call PayPal. Live runs need `RECKON_LIVE_CODE`. Public demo runs use Claude only with `RECKON_DEMO_CLAUDE=1`, capped at `CLAUDE_CALL_LIMIT` calls a run.
- Guided demo: `src/web/narration.ts` builds the voice-over from the run view (pure, no hard-coded numbers); `app/components/narrator.ts` speaks it. The video must be under 3 minutes, so record with `?short`. With `ELEVENLABS_API_KEY`, `src/web/voice.ts` voices each line once and caches it in the public Supabase bucket `narration`; any wording change re-records that line. Narration wording is plain spoken English for non-technical owners: no AI-style flourishes.
- Engine files import each other with `.js` extensions; `next.config.mjs` maps them to `.ts`. JSON fixtures the server needs are imported statically so Vercel bundles them.

## Next up

- Run `npm run sandbox:smoke` against a real sandbox app and fix any field names
- New Vercel project + Supabase; add the PayPal webhook; run a guided live run from the hosted page
- Record the video (under 3 minutes)
