-- PDF Pro — accounts, cloud storage, subscriptions and AdSense
-- Migration 0001. Idempotent: safe to run against an existing deployment that
-- already owns the workspace tables (documents, signatures, settings, jobs).
--
-- Apply with:  npm run db:migrate
-- The runner records applied files in schema_migrations.

begin;

/* ------------------------------------------------------------------ */
/* Baseline workspace tables (created only when missing)               */
/* ------------------------------------------------------------------ */

create table if not exists documents (
  id serial primary key,
  name text not null,
  size integer not null default 0,
  pages integer not null default 0,
  kind text not null default 'pdf',
  starred boolean not null default false,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now()
);

create table if not exists signatures (
  id serial primary key,
  name text not null,
  data_url text not null,
  kind text not null default 'draw',
  created_at timestamp not null default now()
);

create table if not exists settings (
  id serial primary key,
  key text not null unique,
  value jsonb not null,
  updated_at timestamp not null default now()
);

create table if not exists jobs (
  id serial primary key,
  kind text not null,
  file_name text not null,
  status text not null default 'completed',
  input_size integer not null default 0,
  output_size integer not null default 0,
  message text,
  created_at timestamp not null default now()
);

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  email_normalized text not null,
  email_verified_at timestamptz,
  password_hash text,
  display_name text,
  avatar_url text,
  plan text not null default 'free',
  account_status text not null default 'active',
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_plan_check check (plan in ('free', 'premium')),
  constraint users_account_status_check check (account_status in ('active', 'suspended'))
);

create unique index if not exists users_email_normalized_key on users (email_normalized);

create table if not exists profiles (
  user_id uuid primary key references users (id) on delete cascade,
  full_name text,
  company text,
  country text,
  timezone text,
  marketing_opt_in boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  token_hash text not null,
  user_agent text,
  ip_hash text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create unique index if not exists sessions_token_hash_key on sessions (token_hash);
create index if not exists sessions_user_idx on sessions (user_id);
create index if not exists sessions_expires_idx on sessions (expires_at);

create table if not exists email_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  kind text not null,
  token_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint email_tokens_kind_check check (kind in ('verify_email', 'reset_password'))
);

create unique index if not exists email_tokens_token_hash_key on email_tokens (token_hash);
create index if not exists email_tokens_user_kind_idx on email_tokens (user_id, kind);

create table if not exists oauth_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  provider text not null,
  provider_account_id text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists oauth_accounts_provider_account_key on oauth_accounts (provider, provider_account_id);

create table if not exists admin_roles (
  user_id uuid primary key references users (id) on delete cascade,
  role text not null default 'admin',
  granted_by uuid,
  created_at timestamptz not null default now(),
  constraint admin_roles_role_check check (role in ('admin', 'support'))
);

/* ------------------------------------------------------------------ */
/* Cloud storage                                                       */
/* ------------------------------------------------------------------ */

create table if not exists storage_usage (
  user_id uuid primary key references users (id) on delete cascade,
  used_bytes bigint not null default 0,
  file_count integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint storage_usage_used_bytes_check check (used_bytes >= 0),
  constraint storage_usage_file_count_check check (file_count >= 0)
);

create table if not exists user_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  name text not null,
  size_bytes bigint not null,
  mime_type text not null default 'application/pdf',
  storage_driver text not null default 'local',
  storage_key text not null,
  checksum_sha256 text,
  pages integer,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint user_files_size_check check (size_bytes > 0),
  constraint user_files_status_check check (status in ('active', 'deleted'))
);

create unique index if not exists user_files_storage_key_key on user_files (storage_key);
create index if not exists user_files_user_idx on user_files (user_id, status, created_at);
create index if not exists user_files_name_idx on user_files (user_id, lower(name));

/* ------------------------------------------------------------------ */
/* Plans, subscriptions, payments                                      */
/* ------------------------------------------------------------------ */

create table if not exists subscription_plans (
  id text primary key,
  name text not null,
  description text,
  interval text not null,
  price_minor integer not null default 0,
  currency text not null default 'PKR',
  compare_at_minor integer,
  billing_mode text not null default 'one_time',
  provider text not null default 'safepay',
  provider_plan_id text,
  storage_bytes bigint not null default 10000000000,
  features jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscription_plans_interval_check check (interval in ('month', 'year')),
  constraint subscription_plans_billing_mode_check check (billing_mode in ('one_time', 'recurring')),
  constraint subscription_plans_price_check check (price_minor >= 0)
);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  plan_id text not null references subscription_plans (id),
  provider text not null default 'safepay',
  provider_subscription_id text,
  provider_reference text,
  status text not null default 'pending',
  billing_mode text not null default 'one_time',
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  grace_until timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_status_check check (status in ('pending', 'active', 'past_due', 'cancelled', 'expired'))
);

create unique index if not exists subscriptions_provider_sub_key
  on subscriptions (provider, provider_subscription_id)
  where provider_subscription_id is not null;
create index if not exists subscriptions_user_idx on subscriptions (user_id, created_at);
create index if not exists subscriptions_lifecycle_idx on subscriptions (status, current_period_end);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  subscription_id uuid references subscriptions (id) on delete set null,
  plan_id text references subscription_plans (id),
  provider text not null default 'safepay',
  provider_payment_id text,
  provider_reference text,
  amount_minor integer not null,
  currency text not null,
  status text not null default 'pending',
  failure_reason text,
  paid_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_status_check check (status in ('pending', 'succeeded', 'failed', 'refunded', 'cancelled'))
);

create unique index if not exists payments_provider_payment_key
  on payments (provider, provider_payment_id)
  where provider_payment_id is not null;
create index if not exists payments_user_idx on payments (user_id, created_at);
create index if not exists payments_status_idx on payments (status, created_at);

create table if not exists payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  event_type text,
  signature_valid boolean not null default false,
  payload jsonb not null,
  status text not null default 'received',
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint payment_webhook_events_status_check
    check (status in ('received', 'processed', 'ignored', 'duplicate', 'error'))
);

create unique index if not exists payment_webhook_events_provider_event_key
  on payment_webhook_events (provider, event_id);
create index if not exists payment_webhook_events_received_idx on payment_webhook_events (received_at);

/* ------------------------------------------------------------------ */
/* Platform operations                                                 */
/* ------------------------------------------------------------------ */

create table if not exists rate_limits (
  key text primary key,
  count integer not null default 0,
  window_started_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists audit_log (
  id bigserial primary key,
  actor_user_id uuid,
  actor_email text,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_created_idx on audit_log (created_at);

create table if not exists email_outbox (
  id uuid primary key default gen_random_uuid(),
  to_email text not null,
  subject text not null,
  body_text text not null,
  kind text not null,
  transport text not null,
  status text not null default 'queued',
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists email_outbox_created_idx on email_outbox (created_at);

create table if not exists user_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists user_notifications_user_idx on user_notifications (user_id, created_at);

/* ------------------------------------------------------------------ */
/* Default seed data (never overwrites administrator changes)          */
/* ------------------------------------------------------------------ */

insert into subscription_plans (id, name, description, interval, price_minor, currency, compare_at_minor, billing_mode, provider, storage_bytes, features, active, sort_order)
values
  ('premium_monthly', 'Premium Monthly', 'Monthly Premium membership · 10 GB cloud storage · no advertisements',
   'month', 150000, 'PKR', null, 'one_time', 'safepay', 10000000000,
   '["10 GB cloud storage","Completely ad-free","Premium badge","Premium dashboard","Subscription management"]'::jsonb, true, 1),
  ('premium_yearly', 'Premium Yearly', 'Annual Premium membership · two months free · 10 GB cloud storage · no advertisements',
   'year', 1500000, 'PKR', 1800000, 'one_time', 'safepay', 10000000000,
   '["10 GB cloud storage","Completely ad-free","Premium badge","Premium dashboard","Two months free"]'::jsonb, true, 2)
on conflict (id) do nothing;

insert into settings (key, value)
values
  ('billing', '{"graceDays":3,"paused":false,"supportEmail":"billing@example.com","prorationNote":""}'::jsonb),
  ('adsense', '{"enabled":false,"publisherId":"","slots":{},"requireConsent":true}'::jsonb),
  ('storage', '{"maxUploadBytes":104857600}'::jsonb)
on conflict (key) do nothing;

/* ------------------------------------------------------------------ */
/* Row Level Security                                                  */
/*                                                                     */
/* The application connects with the database owner, which bypasses     */
/* RLS by design (server-side authorisation is enforced in code).      */
/* These policies exist so that a restricted role – e.g. the Supabase  */
/* `authenticated`/`anon` roles – can never read another account's     */
/* rows even if a key or query path leaks.                             */
/* ------------------------------------------------------------------ */

do $$
declare
  tbl text;
begin
  foreach tbl in array array['profiles', 'sessions', 'email_tokens', 'oauth_accounts', 'storage_usage', 'user_files', 'subscriptions', 'payments', 'user_notifications']
  loop
    execute format('alter table %I enable row level security', tbl);
  end loop;
end $$;

drop policy if exists profiles_owner on profiles;
create policy profiles_owner on profiles
  using (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

drop policy if exists sessions_owner on sessions;
create policy sessions_owner on sessions
  using (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

drop policy if exists email_tokens_owner on email_tokens;
create policy email_tokens_owner on email_tokens
  using (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

drop policy if exists oauth_accounts_owner on oauth_accounts;
create policy oauth_accounts_owner on oauth_accounts
  using (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

drop policy if exists storage_usage_owner on storage_usage;
create policy storage_usage_owner on storage_usage
  using (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

drop policy if exists user_files_owner on user_files;
create policy user_files_owner on user_files
  using (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

drop policy if exists subscriptions_owner on subscriptions;
create policy subscriptions_owner on subscriptions
  using (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

drop policy if exists payments_owner on payments;
create policy payments_owner on payments
  using (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

drop policy if exists user_notifications_owner on user_notifications;
create policy user_notifications_owner on user_notifications
  using (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

commit;
