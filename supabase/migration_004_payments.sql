-- 004: customer payments applied through the connector. Run on every division's Supabase project.
create table if not exists posted_payment (
  id                   uuid primary key default gen_random_uuid(),
  realm                uuid not null references qbo_realm(id),
  qbo_payment_id       text,
  customer_id          text not null,
  customer_name        text,
  payment_ref          text,
  txn_date             date,
  currency             text,
  total                numeric(14,2),
  applied              numeric(14,2),
  unapplied            numeric(14,2),
  deposit_account_id   text,
  deposit_account_name text,
  lines                jsonb,
  source_doc           text,
  operator             text not null,
  drift                jsonb,
  created_at           timestamptz not null default now()
);
create index if not exists posted_payment_dup on posted_payment(realm, customer_id, txn_date, total);
alter table posted_payment enable row level security;
