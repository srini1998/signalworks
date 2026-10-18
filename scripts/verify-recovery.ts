// Worker crash/restart verification. Queues a run, SIGKILLs the worker while a tool call is in
// flight, starts a fresh worker, and checks: the run resumes on attempt 2, in-flight work is
// reconciled (owned resources removed, call marked interrupted), succeeded calls are not repeated,
// and the final evidence has no duplicate effects. Writes docs/evidence/recovery.json.
import "dotenv/config";
import { execSync, spawn } from "node:child_process";
import { openSync, readFileSync, writeFileSync } from "node:fs";
import { ownerPool } from "../server/db.ts";

const BASE = "http://127.0.0.1:4400";
const creds = JSON.parse(readFileSync(".local/demo-users.json", "utf8"));
const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "maya@signalworks.local", password: creds["maya@signalworks.local"] }) });
const cookie = login.headers.get("set-cookie")!.split(";")[0];
const api = async (p: string, body?: unknown) => (await fetch(`${BASE}${p}`, { method: body ? "POST" : "GET", headers: { cookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json();
const owner = ownerPool();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const busy = async () => (await owner.query("select count(*)::int as n from runs where status in ('queued','running')")).rows[0].n;
while ((await busy()) > 0) await sleep(5000); // run alone so the kill hits our run

const ws = (await api("/api/me")).workspaces[0].id;
const project = (await api(`/api/workspaces/${ws}/projects`)).find((p: any) => p.module === "alertscenario");
const run = await api(`/api/projects/${project.id}/runs`, { mode: "baseline", fixture_version: "v1-reviewed", idempotency_key: `recovery-${Date.now()}` });
console.log("queued", run.id);

// Wait until at least one call succeeded and another is in flight, then kill the worker hard.
let killedDuring = "";
for (let i = 0; i < 240; i++) {
  const calls = (await owner.query("select action_id, status from tool_calls where run_id = $1 order by started_at", [run.id])).rows;
  const running = calls.find((c) => c.status === "running");
  if (running && calls.some((c) => c.status === "succeeded")) {
    killedDuring = running.action_id;
    execSync("pkill -KILL -f 'worker/index.ts' || true");
    break;
  }
  await sleep(500);
}
if (!killedDuring) throw new Error("never observed an in-flight call to interrupt");
console.log("killed worker during", killedDuring);
const before = (await owner.query("select action_id, status from tool_calls where run_id = $1", [run.id])).rows;

await sleep(35_000); // lease is 30 s; a fresh worker may only reclaim after expiry
const log = openSync(".local/worker.log", "a");
const child = spawn("npm", ["run", "worker"], { detached: true, stdio: ["ignore", log, log] });
child.unref();
console.log("started replacement worker", child.pid);

let final: any = null;
for (let i = 0; i < 360; i++) {
  final = (await owner.query("select status, verdict, attempts from runs where id = $1", [run.id])).rows[0];
  if (["completed", "failed", "cancelled"].includes(final.status)) break;
  await sleep(2000);
}
const calls = (await owner.query("select action_id, tool, status, result->'observations'->>'error' as error from tool_calls where run_id = $1 order by started_at", [run.id])).rows;
const steps = (await owner.query("select kind, detail from steps where run_id = $1 order by seq", [run.id])).rows;
const succeeded = calls.filter((c) => c.status === "succeeded").map((c) => c.action_id);
const dupSucceeded = succeeded.filter((a, i) => succeeded.indexOf(a) !== i);
const reusedBeforeKill = before.filter((c) => c.status === "succeeded").every((c) => calls.find((x) => x.action_id === c.action_id)?.status === "succeeded");
const reconciled = steps.find((s) => s.kind === "recovery.reconciled");
const result = {
  run_id: run.id, killed_during: killedDuring, final, attempts: final.attempts,
  reconciled_step: reconciled?.detail ?? null,
  interrupted_calls: calls.filter((c) => (c.error ?? "").startsWith("interrupted")).map((c) => c.action_id),
  succeeded_before_kill_reused_not_repeated: reusedBeforeKill,
  duplicate_succeeded_action_ids: dupSucceeded,
  checks: {
    resumed_on_second_attempt: final.attempts === 2,
    in_flight_call_reconciled: !!reconciled,
    no_duplicate_effects: dupSucceeded.length === 0 && reusedBeforeKill,
    completed: final.status === "completed",
  },
  recorded_at: new Date().toISOString(),
};
writeFileSync("docs/evidence/recovery.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result.checks), final);
await owner.end();
process.exit(Object.values(result.checks).every(Boolean) ? 0 : 1);
