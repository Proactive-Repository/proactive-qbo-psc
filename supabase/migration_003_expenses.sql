-- 003: credit-card expenses posted through the connector. Run on every division's Supabase project.
create table if not exists posted_expense (
  id                uuid primary key default gen_random_uuid(),
  realm             uuid not null references qbo_realm(id),
  qbo_purchase_id   text,
  card_account_id   text not null,
  card_account_name text,
  payee_id          text,
  payee_name        text,
  doc_number        text,
  txn_date          date,
  currency          text,
  total             numeric(14,2),
  lines             jsonb,
  source_doc        text,
  operator          text not null,
  drift             jsonb,
  created_at        timestamptz not null default now()
);
create index if not exists posted_expense_dup on posted_expense(realm, card_account_id, txn_date, total);
alter table posted_expense enable row level security;
