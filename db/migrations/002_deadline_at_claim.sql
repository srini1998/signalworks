-- A run's deadline measures execution, not time spent waiting in the queue: on the first claim the
-- deadline restarts from now using the spec's deadline_seconds.
create or replace function sw_claim_run(p_worker text, p_lease_seconds integer)
  returns table (run_id uuid, workspace_id uuid, attempts integer)
  language plpgsql security definer set search_path = public as $$
  declare r record;
  begin
    select id, runs.workspace_id, runs.attempts as a, spec into r from runs
      where (status = 'queued') or (status = 'running' and lease_expires < now())
      order by created_at for update skip locked limit 1;
    if not found then return; end if;
    update runs set status = 'running', lease_owner = p_worker,
      lease_expires = now() + make_interval(secs => p_lease_seconds),
      deadline_at = case when r.a = 0 then now() + make_interval(secs => coalesce((r.spec->'limits'->>'deadline_seconds')::int, 1500)) else deadline_at end,
      attempts = runs.attempts + 1, started_at = coalesce(started_at, now())
      where id = r.id;
    return query select runs.id, runs.workspace_id, runs.attempts from runs where id = r.id;
  end $$;
revoke all on function sw_claim_run(text, integer) from public;
grant execute on function sw_claim_run(text, integer) to sw_worker;
