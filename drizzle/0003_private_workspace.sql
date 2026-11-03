-- Keep the old unscoped records intact under a non-user legacy namespace.
-- New API writes are scoped to an authenticated user or an opaque guest cookie.
alter table documents add column if not exists workspace_id text not null default 'legacy';
alter table signatures add column if not exists workspace_id text not null default 'legacy';
alter table jobs add column if not exists workspace_id text not null default 'legacy';
create index if not exists documents_workspace_updated_idx on documents (workspace_id, updated_at desc);
create index if not exists signatures_workspace_created_idx on signatures (workspace_id, created_at desc);
create index if not exists jobs_workspace_created_idx on jobs (workspace_id, created_at desc);

-- Do not reuse the global settings table: billing/AdSense/storage settings
-- belong to administrators and must never be returned as workspace preferences.
create table if not exists workspace_settings (
  workspace_id text not null,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, key)
);
-- Preserve existing workspace preferences separately without exposing their
-- former global values to new guests/users. Admins can export legacy rows.
insert into workspace_settings (workspace_id, key, value)
select 'legacy', key, value from settings
where key in ('theme', 'defaultZoom', 'defaultView', 'maxFileMB', 'autosave', 'ocrLang')
on conflict (workspace_id, key) do nothing;
