-- proactive-qbo-psc (QBO-02) — schema for a NEW Supabase project.
-- Run once in the SQL editor of the new project. Idempotent.
-- Same shape as QBO-01 plus: qbo_realm.write_scope, posted_bill.

create extension if not exists pgcrypto;

create table if not exists qbo_realm (
  id             uuid primary key default gen_random_uuid(),
  label          text not null unique,
  realm_id       text,
  environment    text not null default 'production',
  country        text,
  home_currency  text,
  status         text not null default 'pending',   -- pending | authorised | revoked
  authorised_by  text,
  authorised_at  timestamptz,
  revoked_at     timestamptz,
  write_enabled  boolean not null default false,
  write_scope    text[] not null default '{}',      -- set_invoice_number | create_bill
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists qbo_token (
  realm               uuid primary key references qbo_realm(id) on delete cascade,
  access_token_enc    text,
  access_expires_at   timestamptz,
  refresh_token_enc   text,
  refresh_expires_at  timestamptz,
  last_refresh_at     timestamptz,
  refresh_failures    integer not null default 0,
  updated_at          timestamptz not null default now()
);

create table if not exists oauth_state (
  state        text primary key,
  realm_label  text not null,
  created_at   timestamptz not null default now(),
  consumed_at  timestamptz
);

create table if not exists connector_user (
  id            uuid primary key default gen_random_uuid(),
  full_name     text not null,
  email         text not null unique,
  role          text not null default 'reader' check (role in ('reader','approver','admin')),
  token_hash    text not null unique,
  active        boolean not null default true,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz
);

create table if not exists audit_event (
  id            bigserial primary key,
  realm         uuid references qbo_realm(id),
  kind          text not null,      -- read | write | auth | error
  operator      text,
  tool          text,
  entity        text,
  entity_id     text,
  field         text,
  value_before  jsonb,
  value_after   jsonb,
  source_doc    text,
  request_id    text,
  outcome       text not null default 'ok',
  detail        jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists audit_event_realm_created on audit_event(realm, created_at desc);
create index if not exists audit_event_operator_created on audit_event(operator, created_at desc);

-- Bills created through the connector. Second duplicate guard and the AP posting report.
create table if not exists posted_bill (
  id            uuid primary key default gen_random_uuid(),
  realm         uuid not null references qbo_realm(id),
  qbo_bill_id   text,
  vendor_id     text not null,
  vendor_name   text,
  doc_number    text not null,
  txn_date      date,
  currency      text,
  total         numeric(14,2),
  lines         jsonb,
  source_doc    text,
  operator      text not null,
  drift         jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists posted_bill_dup on posted_bill(realm, vendor_id, doc_number);

-- MX reconciliation tables (shared design with QBO-01; used if PSC runs carrier recon too)
create table if not exists recon_run (
  id             uuid primary key default gen_random_uuid(),
  realm          uuid references qbo_realm(id),
  kind           text,
  operator       text,
  params         jsonb,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  bills_scanned  integer,
  matched        integer,
  variances      integer,
  unmatched      integer,
  summary        jsonb
);

create table if not exists recon_match (
  id               uuid primary key default gen_random_uuid(),
  run              uuid references recon_run(id) on delete cascade,
  bill_id          text,
  doc_number       text,
  load_number      text,
  vendor_id        text,
  vendor_name      text,
  currency         text,
  bill_amount      numeric(14,2),
  invoice_amount   numeric(14,2),
  variance         numeric(14,2),
  status           text,
  proposed_action  jsonb,
  notes            text,
  created_at       timestamptz not null default now()
);

create table if not exists exception_item (
  id               uuid primary key default gen_random_uuid(),
  realm            uuid references qbo_realm(id),
  match            uuid references recon_match(id),
  raised_at        timestamptz not null default now(),
  kind             text,
  vendor_name      text,
  currency         text,
  reference        text,
  amount_billed    numeric(14,2),
  amount_expected  numeric(14,2),
  status           text not null default 'open',
  decision         text,
  decided_by       text,
  decided_at       timestamptz,
  age_days         integer
);

create table if not exists vendor_currency_pair (
  id           uuid primary key default gen_random_uuid(),
  realm        uuid references qbo_realm(id),
  base_name    text,
  vendor_id    text,
  vendor_name  text,
  currency     text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table if not exists baseline_measure (
  id           uuid primary key default gen_random_uuid(),
  workflow     text not null,
  person       text,
  measure      text not null,
  value        numeric,
  unit         text,
  method       text,
  captured_at  timestamptz not null default now(),
  captured_by  text,
  notes        text
);

-- The connector uses the service-role key. Lock every table against the anon/authenticated roles.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Seed: the PSC company file, pending consent, writes off.
insert into qbo_realm (label, environment, country, home_currency, status, write_enabled, write_scope, notes)
values ('PSC', 'production', 'CA', 'CAD', 'pending', false, '{}',
        'Proactive Supply Chain Solutions Inc. Separate Intuit app "PSC Oauth" (QBO-02). AP bill posting for Manpreet Kaur; carrier recon as needed. Consent by Bill Stathakos.')
on conflict (label) do nothing;
