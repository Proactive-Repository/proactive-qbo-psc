-- 002: connector sign-in (OAuth 2.1 authorization server). Idempotent.

alter table connector_user
  alter column token_hash drop not null,
  add column if not exists password_hash      text,
  add column if not exists totp_secret_enc    text,
  add column if not exists mfa_required       boolean not null default false,
  add column if not exists must_set_password  boolean not null default false,
  add column if not exists failed_attempts    integer not null default 0,
  add column if not exists locked_until       timestamptz,
  add column if not exists password_set_at    timestamptz;

create table if not exists auth_setup_token (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references connector_user(id) on delete cascade,
  token_hash   text not null unique,
  purpose      text not null check (purpose in ('setup','reset')),
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  pending_totp_secret_enc text,
  created_at   timestamptz not null default now()
);
alter table auth_setup_token add column if not exists pending_totp_secret_enc text;

create table if not exists oauth_client (
  client_id           text primary key,
  client_secret_hash  text,
  redirect_uris       text[] not null,
  client_name         text,
  metadata            jsonb,
  created_at          timestamptz not null default now()
);

create table if not exists oauth_code (
  id              uuid primary key default gen_random_uuid(),
  code_hash       text not null unique,
  user_id         uuid not null references connector_user(id) on delete cascade,
  client_id       text not null references oauth_client(client_id) on delete cascade,
  redirect_uri    text not null,
  code_challenge  text not null,
  scope           text,
  resource        text,
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists oauth_token (
  id                  uuid primary key default gen_random_uuid(),
  access_hash         text not null unique,
  refresh_hash        text not null unique,
  user_id             uuid not null references connector_user(id) on delete cascade,
  client_id           text not null references oauth_client(client_id) on delete cascade,
  scope               text,
  access_expires_at   timestamptz not null,
  refresh_expires_at  timestamptz not null,
  revoked_at          timestamptz,
  rotated             boolean not null default false,
  created_at          timestamptz not null default now()
);
create index if not exists oauth_token_user on oauth_token(user_id, revoked_at);

alter table auth_setup_token enable row level security;
alter table oauth_client     enable row level security;
alter table oauth_code       enable row level security;
alter table oauth_token      enable row level security;

-- Existing users must set a password before they can sign in.
update connector_user set must_set_password = true where password_hash is null;
