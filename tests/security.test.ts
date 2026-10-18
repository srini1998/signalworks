// Integration tests against the real control database, through the ordinary application role
// (sw_app) exactly as the API uses it — never the owner role.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { appPool, asUser, anon, inWorkspace, workerPool } from "../server/db.ts";

after(async () => {
  await appPool.end();
  await workerPool.end();
});

async function userId(email: string): Promise<string> {
  return (await anon((tx) => tx.query("select id from sw_auth_lookup($1)", [email]))).rows[0].id;
}

test("cross-workspace reads and writes are denied by RLS for ordinary sessions", async () => {
  const maya = await userId("maya@signalworks.local");
  const omar = await userId("omar@signalworks.local");
  const mayaWs = (await asUser(maya, (tx) => tx.query("select id from workspaces"))).rows.map((r) => r.id);
  const omarWs = (await asUser(omar, (tx) => tx.query("select id from workspaces"))).rows.map((r) => r.id);
  assert.equal(mayaWs.length, 1);
  assert.equal(omarWs.length, 1);
  assert.notEqual(mayaWs[0], omarWs[0]);

  const mayaProject = (await asUser(maya, (tx) => tx.query("select id from projects limit 1"))).rows[0].id;
  const seenByOmar = await asUser(omar, (tx) => tx.query("select id from projects where id = $1", [mayaProject]));
  assert.equal(seenByOmar.rowCount, 0, "Omar cannot read Maya's project");
  const runsSeen = await asUser(omar, (tx) => tx.query("select id from runs where workspace_id = $1", [mayaWs[0]]));
  assert.equal(runsSeen.rowCount, 0, "Omar cannot read Maya's runs");

  await assert.rejects(
    asUser(omar, (tx) => tx.query(
      "insert into runs (workspace_id, project_id, module, mode, spec, spec_hash, seed, idempotency_key, deadline_at) values ($1,$2,'alertscenario','baseline','{}','x',1,'evil', now())",
      [mayaWs[0], mayaProject])),
    /row-level security/, "Omar cannot queue a run in Maya's workspace");
  const updated = await asUser(omar, (tx) => tx.query("update projects set name = 'pwned' where id = $1", [mayaProject]));
  assert.equal(updated.rowCount, 0, "Omar cannot modify Maya's project");
});

test("the app role cannot read private fault manifests, users or sessions", async () => {
  const maya = await userId("maya@signalworks.local");
  await assert.rejects(asUser(maya, (tx) => tx.query("select * from private_faults")), /permission denied/);
  await assert.rejects(asUser(maya, (tx) => tx.query("select * from users")), /permission denied/);
  await assert.rejects(asUser(maya, (tx) => tx.query("select * from sessions")), /permission denied/);
});

test("without a session the app role sees nothing", async () => {
  const r = await anon((tx) => tx.query("select count(*)::int as n from projects"));
  assert.equal(r.rows[0].n, 0);
});

test("the worker role is confined to the workspace it is working on", async () => {
  const maya = await userId("maya@signalworks.local");
  const omar = await userId("omar@signalworks.local");
  const mayaWs = (await asUser(maya, (tx) => tx.query("select id from workspaces"))).rows[0].id;
  const omarWs = (await asUser(omar, (tx) => tx.query("select id from workspaces"))).rows[0].id;
  const visible = await inWorkspace(mayaWs, (tx) => tx.query("select distinct workspace_id from projects"));
  assert.deepEqual(visible.rows.map((r) => r.workspace_id), [mayaWs]);
  const other = await inWorkspace(mayaWs, (tx) => tx.query("select id from projects where workspace_id = $1", [omarWs]));
  assert.equal(other.rowCount, 0);
});

test("a queued run can be cancelled and then never claimed", async () => {
  const omar = await userId("omar@signalworks.local");
  const project = (await asUser(omar, (tx) => tx.query("select id, workspace_id from projects where module = 'metriccontract'"))).rows[0];
  const run = (await asUser(omar, (tx) => tx.query(
    `insert into runs (workspace_id, project_id, module, mode, spec, spec_hash, seed, idempotency_key, deadline_at)
     values ($1,$2,'metriccontract','baseline','{"fixture_name":"payments-release","fixture_version":"v1","limits":{"max_steps":6,"max_model_tokens":1}}','t',1,$3, now() + interval '5 minutes') returning id`,
    [project.workspace_id, project.id, `cancel-test-${Date.now()}`]))).rows[0];
  const cancelled = await asUser(omar, (tx) => tx.query(
    "update runs set cancel_requested = true, status = case when status = 'queued' then 'cancelled' else status end where id = $1 returning status", [run.id]));
  assert.equal(cancelled.rows[0].status, "cancelled");
  const after = await asUser(omar, (tx) => tx.query("select status, lease_owner from runs where id = $1", [run.id]));
  assert.equal(after.rows[0].status, "cancelled");
  assert.equal(after.rows[0].lease_owner, null);
});

test("idempotency keys deduplicate run creation within a workspace", async () => {
  const omar = await userId("omar@signalworks.local");
  const project = (await asUser(omar, (tx) => tx.query("select id, workspace_id from projects where module = 'metriccontract'"))).rows[0];
  const key = `dup-${Date.now()}`;
  const insert = () => asUser(omar, (tx) => tx.query(
    `insert into runs (workspace_id, project_id, module, mode, spec, spec_hash, seed, idempotency_key, deadline_at, status)
     values ($1,$2,'metriccontract','baseline','{}','t',1,$3, now(), 'cancelled')`, [project.workspace_id, project.id, key]));
  await insert();
  await assert.rejects(insert(), /duplicate key/);
});
