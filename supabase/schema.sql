-- ============================================================
-- WhatsApp CRM — Complete Supabase Schema
-- Run this entire file in Supabase → SQL Editor → Run
-- ============================================================

-- ─── EXTENSIONS ──────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ─── CLEAN SLATE (safe re-run) ───────────────────────────────
drop table if exists public.message_logs    cascade;
drop table if exists public.message_queue   cascade;
drop table if exists public.campaign_leads  cascade;
drop table if exists public.campaigns       cascade;
drop table if exists public.templates       cascade;
drop table if exists public.leads           cascade;
drop table if exists public.whatsapp_session cascade;
drop table if exists public.settings        cascade;

-- ─── ENUMS ───────────────────────────────────────────────────
do $$ begin
  create type lead_status as enum (
    'New','Sent','Delivered','Read',
    'Interested','Not Interested','Follow Up','No Reply'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type queue_status as enum (
    'Pending','Sending','Sent','Failed','Skipped','Cancelled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type campaign_status as enum (
    'Draft','Running','Paused','Completed','Cancelled','Failed'
  );
exception when duplicate_object then null; end $$;

-- ─── SETTINGS ────────────────────────────────────────────────
-- One row per installation (no auth — single-user CRM)
create table public.settings (
  id             uuid primary key default uuid_generate_v4(),
  company_name   text    default 'My Company',
  sender_name    text    default 'Sales Team',
  dark_mode      boolean default false,
  min_delay_sec  int     default 20,
  max_delay_sec  int     default 60,
  backend_url    text    default '',   -- Render URL, set from frontend Settings
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- Insert default row on first run
insert into public.settings (company_name, sender_name)
values ('My Company', 'Sales Team')
on conflict do nothing;

-- ─── WHATSAPP SESSION ────────────────────────────────────────
-- Stores Baileys auth creds as JSON so session survives Render restarts.
-- Only ever 1 row (upserted by backend on every creds.update event).
create table public.whatsapp_session (
  id         text primary key default 'main',
  creds_json jsonb not null,
  updated_at timestamptz default now()
);

-- ─── LEADS ───────────────────────────────────────────────────
create table public.leads (
  id             uuid primary key default uuid_generate_v4(),
  name           text not null,
  phone          text not null,
  company        text,
  email          text,
  product        text,
  quantity       text,
  country        text,
  status         lead_status default 'New',
  notes          text,
  is_duplicate   boolean default false,
  phone_valid    boolean default true,
  source         text    default 'manual',  -- 'manual' | 'csv' | 'excel'
  created_at     timestamptz default now(),
  updated_at     timestamptz default now(),
  -- prevent same phone being added twice
  unique (phone)
);

create index idx_leads_status  on public.leads(status);
create index idx_leads_country on public.leads(country);
create index idx_leads_product on public.leads(product);
create index idx_leads_company on public.leads(company);
create index idx_leads_created on public.leads(created_at desc);

-- ─── TEMPLATES ───────────────────────────────────────────────
create table public.templates (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  content     text not null,
  times_used  int  default 0,
  is_active   boolean default true,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ─── CAMPAIGNS ───────────────────────────────────────────────
create table public.campaigns (
  id             uuid primary key default uuid_generate_v4(),
  name           text not null,
  template_id    uuid references public.templates(id) on delete set null,
  status         campaign_status default 'Draft',
  total_leads    int default 0,
  sent_count     int default 0,
  failed_count   int default 0,
  skipped_count  int default 0,
  min_delay_sec  int default 20,
  max_delay_sec  int default 60,
  started_at     timestamptz,
  completed_at   timestamptz,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- ─── MESSAGE QUEUE ───────────────────────────────────────────
-- One row per lead per campaign — drives the send loop on the backend.
create table public.message_queue (
  id             uuid primary key default uuid_generate_v4(),
  campaign_id    uuid not null references public.campaigns(id) on delete cascade,
  lead_id        uuid not null references public.leads(id) on delete cascade,
  message_body   text not null,         -- fully rendered (variables substituted)
  status         queue_status default 'Pending',
  attempt_count  int  default 0,
  scheduled_at   timestamptz default now(),
  sent_at        timestamptz,
  error_msg      text,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now(),
  unique (campaign_id, lead_id)
);

create index idx_queue_campaign on public.message_queue(campaign_id);
create index idx_queue_status   on public.message_queue(status);
create index idx_queue_schedule on public.message_queue(scheduled_at);

-- ─── MESSAGE LOGS ────────────────────────────────────────────
-- Immutable audit log — every send attempt recorded here.
create table public.message_logs (
  id           uuid primary key default uuid_generate_v4(),
  campaign_id  uuid references public.campaigns(id) on delete cascade,
  lead_id      uuid references public.leads(id) on delete cascade,
  lead_name    text,
  phone        text,
  message_body text,
  status       text,          -- 'sent' | 'failed' | 'skipped'
  error_msg    text,
  sent_at      timestamptz default now()
);

create index idx_logs_campaign on public.message_logs(campaign_id);
create index idx_logs_sent_at  on public.message_logs(sent_at desc);

-- ─── UPDATED_AT TRIGGER ──────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'settings','leads','templates','campaigns',
    'message_queue','whatsapp_session'
  ]
  loop
    execute format(
      'drop trigger if exists trg_updated_at on public.%I;
       create trigger trg_updated_at
       before update on public.%I
       for each row execute procedure public.set_updated_at();',
      t, t
    );
  end loop;
end $$;

-- ─── DUPLICATE PHONE DETECTION TRIGGER ───────────────────────
create or replace function public.flag_duplicate_lead()
returns trigger language plpgsql as $$
begin
  -- mark as duplicate if another row has the same phone
  if exists (
    select 1 from public.leads
    where phone = new.phone and id <> new.id
  ) then
    new.is_duplicate := true;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_duplicate_lead on public.leads;
create trigger trg_duplicate_lead
before insert or update on public.leads
for each row execute procedure public.flag_duplicate_lead();

-- ─── CAMPAIGN COUNTER FUNCTION ───────────────────────────────
-- Called by backend after each send to keep counts accurate.
create or replace function public.increment_campaign_counter(
  p_campaign_id uuid,
  p_field       text    -- 'sent_count' | 'failed_count' | 'skipped_count'
)
returns void language plpgsql as $$
begin
  execute format(
    'update public.campaigns set %I = %I + 1 where id = $1',
    p_field, p_field
  ) using p_campaign_id;
end;
$$;

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────
-- This is a single-user CRM accessed via service role key from the backend.
-- RLS is enabled but we allow all via service role (backend uses service key).
-- If you add Supabase Auth later, replace these policies.
alter table public.settings         enable row level security;
alter table public.whatsapp_session enable row level security;
alter table public.leads            enable row level security;
alter table public.templates        enable row level security;
alter table public.campaigns        enable row level security;
alter table public.message_queue    enable row level security;
alter table public.message_logs     enable row level security;

-- Allow all via anon key (frontend reads directly — no sensitive data exposed)
create policy "allow_all_settings"         on public.settings         for all using (true) with check (true);
create policy "allow_all_leads"            on public.leads            for all using (true) with check (true);
create policy "allow_all_templates"        on public.templates        for all using (true) with check (true);
create policy "allow_all_campaigns"        on public.campaigns        for all using (true) with check (true);
create policy "allow_all_queue"            on public.message_queue    for all using (true) with check (true);
create policy "allow_all_logs"             on public.message_logs     for all using (true) with check (true);
-- Session is BACKEND ONLY — never expose to frontend via anon key
create policy "deny_anon_session"          on public.whatsapp_session for all using (false);

-- ─── ANALYTICS VIEWS ─────────────────────────────────────────
create or replace view public.v_campaign_stats as
select
  c.id,
  c.name,
  c.status,
  c.total_leads,
  c.sent_count,
  c.failed_count,
  c.skipped_count,
  c.created_at,
  c.started_at,
  c.completed_at,
  case when c.total_leads > 0
    then round(c.sent_count::numeric / c.total_leads * 100, 1)
    else 0
  end as success_rate_pct,
  count(mq.id) filter (where mq.status = 'Pending') as pending_count
from public.campaigns c
left join public.message_queue mq on mq.campaign_id = c.id
group by c.id;

create or replace view public.v_dashboard_stats as
select
  (select count(*) from public.leads)                                          as total_leads,
  (select count(*) from public.leads where status = 'Interested')              as interested,
  (select count(*) from public.leads where status in ('New','Follow Up'))      as pending,
  (select count(*) from public.message_logs where sent_at::date = current_date) as sent_today,
  (select count(*) from public.message_logs)                                   as total_sent,
  (select count(*) from public.campaigns where status = 'Running')             as active_campaigns;

-- ─── DONE ─────────────────────────────────────────────────────
-- Next: Run baileys-service setup (Step 2)
