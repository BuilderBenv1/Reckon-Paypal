-- Reckon run store. One row per run (demo or live), saved after every action.
-- Access is server-side only, with the service role key; RLS is on with no policies,
-- so the anon key can read or write nothing.

create table if not exists public.reckon_runs (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('demo', 'live')),
  version integer not null default 1,
  refs text[] not null default '{}',
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists reckon_runs_refs_idx on public.reckon_runs using gin (refs);
create index if not exists reckon_runs_live_idx on public.reckon_runs (mode, updated_at desc);

-- Airwallex webhook events, deduplicated on the event id (delivery is at-least-once).
create table if not exists public.reckon_webhook_events (
  id text primary key,
  name text not null,
  received_at timestamptz not null default now(),
  payload jsonb not null,
  handled_runs uuid[] not null default '{}'
);

alter table public.reckon_runs enable row level security;
alter table public.reckon_webhook_events enable row level security;

-- Demo runs are disposable: anything untouched for 7 days can go.
create or replace function public.reckon_prune_demo_runs() returns integer
language sql security definer set search_path = public as $$
  with gone as (
    delete from public.reckon_runs where mode = 'demo' and updated_at < now() - interval '7 days' returning 1
  ) select count(*)::integer from gone;
$$;
revoke all on function public.reckon_prune_demo_runs() from public, anon, authenticated;
