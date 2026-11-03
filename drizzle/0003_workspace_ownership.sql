-- Keep pre-existing global workspace rows intact. Their owner remains NULL,
-- so an arbitrary visitor cannot read, modify or claim another user's history
-- or saved signature. New records are always assigned by the authenticated API.
begin;
alter table documents add column if not exists owner_user_id uuid references users(id) on delete set null;
alter table jobs add column if not exists owner_user_id uuid references users(id) on delete set null;
alter table signatures add column if not exists owner_user_id uuid references users(id) on delete set null;
create index if not exists documents_owner_updated_idx on documents(owner_user_id, updated_at desc);
create index if not exists jobs_owner_created_idx on jobs(owner_user_id, created_at desc);
create index if not exists signatures_owner_created_idx on signatures(owner_user_id, created_at desc);
alter table documents enable row level security;
alter table jobs enable row level security;
alter table signatures enable row level security;
drop policy if exists documents_owner on documents;
create policy documents_owner on documents using (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid) with check (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
drop policy if exists jobs_owner on jobs;
create policy jobs_owner on jobs using (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid) with check (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
drop policy if exists signatures_owner on signatures;
create policy signatures_owner on signatures using (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid) with check (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
commit;
