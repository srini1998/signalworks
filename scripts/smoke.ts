// Queues runs through the real HTTP API as a fictional user and waits for verdicts.
// Usage: npm run smoke -- alertscenario:baseline:v1-reviewed metriccontract:baseline:v5 ...
import { readFileSync } from "node:fs";

const BASE = process.env.SW_API ?? "http://127.0.0.1:4400";
const creds = JSON.parse(readFileSync(".local/demo-users.json", "utf8"));
const email = process.env.SW_USER ?? "maya@signalworks.local";
const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: creds[email] }) });
if (!login.ok) throw new Error(`login failed: ${login.status}`);
const cookie = login.headers.get("set-cookie")!.split(";")[0];
const get = async (p: string) => (await fetch(`${BASE}${p}`, { headers: { cookie } })).json();
const post = async (p: string, b: unknown) => (await fetch(`${BASE}${p}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(b) })).json();

const me = await get("/api/me");
const ws = me.workspaces[0].id;
const projects = await get(`/api/workspaces/${ws}/projects`);
const specs = process.argv.slice(2).length ? process.argv.slice(2) : ["alertscenario:baseline:v1-reviewed"];
const queued: { spec: string; id: string }[] = [];
for (const spec of specs) {
  const [module, mode, fixture] = spec.split(":");
  const project = projects.find((p: any) => p.module === module);
  if (!project) throw new Error(`no ${module} project`);
  const r = await post(`/api/projects/${project.id}/runs`, { mode, fixture_version: fixture, idempotency_key: `smoke-${spec}-${Date.now()}` });
  if (!r.id) throw new Error(`could not queue ${spec}: ${JSON.stringify(r)}`);
  queued.push({ spec, id: r.id });
  console.log(`queued ${spec} -> ${r.id}`);
}
const pending = new Set(queued.map((q) => q.id));
while (pending.size) {
  await new Promise((r) => setTimeout(r, 5000));
  for (const q of queued) {
    if (!pending.has(q.id)) continue;
    const d = await get(`/api/runs/${q.id}`);
    if (["completed", "failed", "cancelled"].includes(d.run.status)) {
      pending.delete(q.id);
      console.log(`${q.spec}: ${d.run.status} / ${d.run.verdict}${d.run.error ? ` (${d.run.error})` : ""} :: ${(d.run.summary?.verdict?.reasons ?? []).join(" | ")}`);
    }
  }
}
