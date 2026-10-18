// Creates a dedicated Grafana service account for the worker (Editor: enough for alert rules,
// contact points, notification policies, silences and dashboards in this disposable test
// instance) and stores its token in .env. Idempotent: an existing token is kept.
import "dotenv/config";
import { appendFileSync, readFileSync } from "node:fs";
import { grafana } from "../worker/targets.ts";

if (process.env.GRAFANA_SA_TOKEN) {
  const saved = process.env.GRAFANA_SA_TOKEN;
  delete process.env.GRAFANA_SA_TOKEN;
  process.env.GRAFANA_SA_TOKEN = saved;
  console.log("service account token already configured");
  process.exit(0);
}
delete process.env.GRAFANA_SA_TOKEN; // use admin basic auth for the bootstrap only
const found = await grafana.req<{ serviceAccounts: { id: number; name: string }[] }>("GET", "/api/serviceaccounts/search?query=signalworks-worker");
let id = found.serviceAccounts.find((s) => s.name === "signalworks-worker")?.id;
if (!id) id = (await grafana.req<{ id: number }>("POST", "/api/serviceaccounts", { name: "signalworks-worker", role: "Editor", isDisabled: false })).id;
const token = await grafana.req<{ key: string }>("POST", `/api/serviceaccounts/${id}/tokens`, { name: `worker-${Date.now()}` });
if (!readFileSync(".env", "utf8").includes("GRAFANA_SA_TOKEN=")) appendFileSync(".env", `GRAFANA_SA_TOKEN=${token.key}\n`);
console.log(`service account ${id} (Editor) token stored in .env`);
