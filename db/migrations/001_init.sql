-- Signalworks control plane. Workspace isolation is enforced by RLS for both roles:
--   sw_app    (HTTP API)  sees rows in workspaces where app.user_id is a member
--   sw_worker (worker)    sees rows of the single workspace in app.workspace_id
-- Neither role has BYPASSRLS. Auth lookups and run claiming go through narrow SECURITY
-- DEFINER functions owned by sw_owner.

create extension if not exists pgcrypto;

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  name text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);
create table sessions (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null
);
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);
create table memberships (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  primary key (workspace_id, user_id)
);
create index memberships_user on memberships(user_id);

-- Global, read-only fixture catalog. Public manifests only; seeded-fault truth lives in private_faults.
create table fixture_versions (
  id uuid primary key default gen_random_uuid(),
  module text not null,
  name text not null,
  version text not null,
  manifest jsonb not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (module, name, version)
);
create table private_faults (
  fixture_version_id uuid primary key references fixture_versions(id) on delete cascade,
  fault jsonb not null
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  module text not null check (module in ('alertscenario','metriccontract','routereplay','serieswatch','dashboardreplay','filterproof')),
  name text not null,
  contract jsonb not null,
  contract_hash text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index projects_ws on projects(workspace_id);

create table runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  module text not null,
  mode text not null check (mode in ('baseline', 'agent', 'replay')),
  status text not null default 'queued' check (status in ('queued','running','completed','failed','cancelled')),
  verdict text not null default 'not_evaluated' check (verdict in ('pass','fail','inconclusive','unsupported','not_evaluated')),
  spec jsonb not null,
  spec_hash text not null,
  seed integer not null,
  idempotency_key text not null,
  replay_of uuid references runs(id),
  lease_owner text,
  lease_expires timestamptz,
  attempts integer not null default 0,
  cancel_requested boolean not null default false,
  deadline_at timestamptz not null,
  environment jsonb,
  summary jsonb,
  error text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (workspace_id, idempotency_key)
);
create index runs_ws_created on runs(workspace_id, created_at desc);
create index runs_claimable on runs(status, lease_expires) where status in ('queued', 'running');

create table steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  seq integer not null,
  kind text not null,
  status text not null check (status in ('running','succeeded','failed','skipped')),
  detail jsonb not null default '{}',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (run_id, seq)
);
create table tool_calls (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  action_id text not null,
  tool text not null,
  args jsonb not null,
  args_hash text not null,
  decided_by text not null check (decided_by in ('baseline', 'model', 'system')),
  decision_summary text,
  status text not null check (status in ('running','succeeded','failed','rejected')),
  result jsonb,
  error_category text check (error_category in ('validation','infrastructure','timeout','domain','cancelled')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (run_id, action_id)
);
create index tool_calls_run on tool_calls(run_id, started_at);
create table artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null,
  name text not null,
  content jsonb not null,
  sha256 text not null,
  created_at timestamptz not null default now()
);
create index artifacts_run on artifacts(run_id);
create table findings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  invariant_id text not null,
  expected jsonb not null,
  observed jsonb not null,
  evidence_refs uuid[] not null default '{}',
  severity text not null check (severity in ('info','low','medium','high')),
  provenance text not null check (provenance in ('seeded','reproduced','observed')),
  reproduction_ref text,
  created_at timestamptz not null default now()
);
create index findings_run on findings(run_id);
create table approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  run_id uuid references runs(id) on delete cascade,
  action_hash text not null,
  plan jsonb not null,
  approved_by uuid not null references users(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- Roles ------------------------------------------------------------------------------------
do $$ begin
  if not exists (select from pg_roles where rolname = 'sw_app') then create role sw_app login; end if;
  if not exists (select from pg_roles where rolname = 'sw_worker') then create role sw_worker login; end if;
end $$;
grant usage on schema public to sw_app, sw_worker;
grant select on fixture_versions to sw_app, sw_worker;
grant select on private_faults to sw_worker;  -- evaluator only; never exposed to agent tools
grant select, update on workspaces to sw_app;
grant select on memberships to sw_app;
grant select, insert, update on projects, runs, approvals to sw_app;
grant select on steps, tool_calls, artifacts, findings to sw_app;
grant select, update on runs to sw_worker;
grant select on projects, approvals, memberships to sw_worker;
grant update (used_at) on approvals to sw_worker;
grant select, insert, update on steps, tool_calls, artifacts, findings to sw_worker;

create or replace function app_user() returns uuid language sql stable as
  $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
create or replace function app_workspace() returns uuid language sql stable as
  $$ select nullif(current_setting('app.workspace_id', true), '')::uuid $$;
create or replace function is_member(ws uuid) returns boolean language sql stable security definer set search_path = public as
  $$ select exists (select 1 from memberships m where m.workspace_id = ws and m.user_id = app_user()) $$;
revoke all on function is_member(uuid) from public;
grant execute on function is_member(uuid), app_user(), app_workspace() to sw_app, sw_worker;

alter table workspaces enable row level security;
alter table memberships enable row level security;
create policy ws_app on workspaces for all to sw_app using (is_member(id)) with check (is_member(id));
create policy ws_worker on workspaces for select to sw_worker using (id = app_workspace());
create policy mem_app on memberships for select to sw_app using (is_member(workspace_id));
create policy mem_worker on memberships for select to sw_worker using (workspace_id = app_workspace());

do $$
declare t text;
begin
  foreach t in array array['projects','runs','steps','tool_calls','artifacts','findings','approvals'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for all to sw_app using (is_member(workspace_id)) with check (is_member(workspace_id))', t || '_app', t);
    execute format('create policy %I on %I for all to sw_worker using (workspace_id = app_workspace()) with check (workspace_id = app_workspace())', t || '_worker', t);
  end loop;
end $$;

-- Narrow privileged functions ---------------------------------------------------------------
create or replace function sw_auth_lookup(p_email text) returns table (id uuid, name text, password_hash text)
  language sql stable security definer set search_path = public as
  $$ select id, name, password_hash from users where email = lower(p_email) $$;
create or replace function sw_session_create(p_user uuid, p_token_hash text, p_ttl_seconds integer) returns void
  language sql security definer set search_path = public as
  $$ insert into sessions values (p_token_hash, p_user, now() + make_interval(secs => p_ttl_seconds)) $$;
create or replace function sw_session_user(p_token_hash text) returns table (id uuid, email text, name text)
  language sql stable security definer set search_path = public as
  $$ select u.id, u.email, u.name from sessions s join users u on u.id = s.user_id
     where s.token_hash = p_token_hash and s.expires_at > now() $$;
create or replace function sw_session_delete(p_token_hash text) returns void
  language sql security definer set search_path = public as $$ delete from sessions where token_hash = p_token_hash $$;
create or replace function sw_create_workspace(p_name text) returns uuid
  language plpgsql security definer set search_path = public as $$
  declare ws uuid;
  begin
    if app_user() is null then raise exception 'no session'; end if;
    insert into workspaces(name) values (p_name) returning id into ws;
    insert into memberships values (ws, app_user(), 'owner');
    return ws;
  end $$;

-- Claim one run: queued, or running with an expired lease (crashed worker). Returns only ids,
-- so the worker then reads the run under RLS with app.workspace_id set.
create or replace function sw_claim_run(p_worker text, p_lease_seconds integer)
  returns table (run_id uuid, workspace_id uuid, attempts integer)
  language plpgsql security definer set search_path = public as $$
  declare r record;
  begin
    select id, runs.workspace_id into r from runs
      where (status = 'queued') or (status = 'running' and lease_expires < now())
      order by created_at for update skip locked limit 1;
    if not found then return; end if;
    update runs set status = 'running', lease_owner = p_worker,
      lease_expires = now() + make_interval(secs => p_lease_seconds),
      attempts = runs.attempts + 1, started_at = coalesce(started_at, now())
      where id = r.id;
    return query select runs.id, runs.workspace_id, runs.attempts from runs where id = r.id;
  end $$;
create or replace function sw_heartbeat(p_run uuid, p_worker text, p_lease_seconds integer) returns boolean
  language sql security definer set search_path = public as
  $$ update runs set lease_expires = now() + make_interval(secs => p_lease_seconds)
     where id = p_run and lease_owner = p_worker and status = 'running' returning true $$;

revoke all on function sw_auth_lookup(text), sw_session_create(uuid, text, integer), sw_session_user(text),
  sw_session_delete(text), sw_create_workspace(text), sw_claim_run(text, integer), sw_heartbeat(uuid, text, integer) from public;
grant execute on function sw_auth_lookup(text), sw_session_create(uuid, text, integer), sw_session_user(text),
  sw_session_delete(text), sw_create_workspace(text) to sw_app;
grant execute on function sw_claim_run(text, integer), sw_heartbeat(uuid, text, integer) to sw_worker;
