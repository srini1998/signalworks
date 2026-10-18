// SeriesWatch: when a service's series disappear, what actually happened?
// Uses an independent desired-service inventory and an approved retirement ledger (not query
// history alone), Prometheus target state and series freshness, and an allowlisted HTTP health
// probe. Grafana's own alert state for the same disappearance is recorded side by side and never
// modified. Absence alone never establishes a root cause.
import { z } from "zod";
import type { EvalResult, ModuleDef, RunContext } from "./types.ts";
import { deleteFolder, ensureFolder, ruleState, stateHistory, upsertRule } from "./grafana.ts";
import { exporter, prometheus, sleep, SERVICES } from "../worker/targets.ts";
import type { Finding } from "../agent/schemas.ts";

const WATCHED = ["billing", "search", "legacy-report", "payments"] as const;
const Svc = z.enum(WATCHED);

export const SeriesContract = z.object({
  inventory_max_age_minutes: z.number().int().min(1).max(10_080).describe("an inventory snapshot older than this is stale"),
  freshness_seconds: z.number().int().min(5).max(600).describe("a series with no sample for this long counts as absent"),
  require_approved_retirement: z.boolean(),
});
type Contract = z.infer<typeof SeriesContract>;

export type Classification = "endpoint_down" | "telemetry_failure" | "intentional_retirement" | "present" | "inconclusive";

/** Deterministic classifier over gathered evidence. Missing evidence -> inconclusive. */
export function classify(c: Contract, svc: string, inv: any, ledger: any[], ev: { series?: any; health?: any }, nowMs: number): { class: Classification; why: string } {
  const ageMin = (nowMs - Date.parse(inv.snapshot_at)) / 60_000;
  if (ageMin > c.inventory_max_age_minutes)
    return { class: "inconclusive", why: `inventory snapshot is ${Math.round(ageMin)} min old (limit ${c.inventory_max_age_minutes}); desired state is unknown` };
  const desired = inv.services.find((s: any) => s.name === svc);
  if (!ev.series) return { class: "inconclusive", why: "series/target evidence was not collected" };
  if (ev.series.fresh) return { class: "present", why: `latest sample ${ev.series.age_seconds}s old` };
  const retirement = ledger.find((r) => r.service === svc);
  if (retirement && (retirement.status === "approved" || !c.require_approved_retirement))
    return { class: "intentional_retirement", why: `retirement ${retirement.id} (${retirement.status}) effective ${retirement.effective_at}` };
  if (!desired) return { class: "inconclusive", why: "service is neither in the inventory nor in an approved retirement" };
  if (!ev.health) return { class: "inconclusive", why: "series are absent but the application health was not probed" };
  if (!ev.health.ok && ev.series.target_health !== "up")
    return { class: "endpoint_down", why: `health probe HTTP ${ev.health.status} and scrape target ${ev.series.target_health}${retirement ? `; retirement ${retirement.id} is only '${retirement.status}'` : ""}` };
  if (ev.health.ok && ev.series.target_health !== "up")
    return { class: "telemetry_failure", why: `application healthy (HTTP ${ev.health.status}) but scrape target ${ev.series.target_health}: ${ev.series.last_error || "no error text"}` };
  return { class: "inconclusive", why: `conflicting evidence: health ${ev.health.ok ? "ok" : "failing"}, target ${ev.series.target_health}` };
}

function resolveTimes(v: any, now: number): any {
  if (v === "__NOW__") return new Date(now).toISOString();
  if (v === "__THREE_DAYS_AGO__") return new Date(now - 3 * 86_400_000).toISOString();
  if (Array.isArray(v)) return v.map((x) => resolveTimes(x, now));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveTimes(x, now)]));
  return v;
}

async function applyIncident(ctx: RunContext) {
  if (ctx.memory.incident) return;
  // Inventory/ledger timestamps are relative to the run so freshness rules are meaningful.
  ctx.fixture = { ...ctx.fixture, manifest: resolveTimes(ctx.fixture.manifest, Date.now()) };
  for (const s of SERVICES) await exporter.reset(s);
  const folder = `sw-${ctx.shortId}`;
  await ensureFolder(folder, `Signalworks run ${ctx.shortId}`);
  const uid = `sw-${ctx.shortId}-sw`;
  // Grafana's own view: one instance per app, from the queue-depth series every service exports.
  await upsertRule({ uid, title: `SeriesWatch ${ctx.shortId} presence`, folderUid: folder, group: `sw-${ctx.shortId}`,
    expr: "count by (app) (sw_queue_depth)", threshold: 1000, forSeconds: 0, noDataState: "NoData", intervalSeconds: 10, labels: { signalworks_run: ctx.shortId } });
  for (let i = 0; i < 25; i++) {
    const st = await ruleState(uid);
    if (st.instances.length >= WATCHED.length) break;
    await sleep(2000);
  }
  const t0 = Date.now();
  for (const [svc, state] of Object.entries<any>(ctx.fixture.manifest.incident)) await exporter.setState(svc, state);
  await sleep(12_000); // let scrapes fail/stop and staleness markers land
  ctx.memory.incident = { applied_at: new Date(t0).toISOString(), rule_uid: uid };
}

const seriesweatchTools = [
  {
    name: "serieswatch.inspect_inventory", description: "Read the independent desired-service inventory snapshot (with its timestamp) and the retirement ledger.",
    args: z.object({}), mutating: false, timeoutMs: 30_000,
    async run(ctx: RunContext) {
      await applyIncident(ctx);
      return { observations: { inventory: ctx.fixture.manifest.inventory, retirements: ctx.fixture.manifest.retirements }, evidence: [] };
    },
  },
  {
    name: "serieswatch.query_series", description: "For one service: Prometheus scrape-target health/last error and how old its newest sample is.",
    args: z.object({ service: Svc }), mutating: false, budgeted: true, timeoutMs: 40_000,
    async run(ctx: RunContext, args: { service: string }) {
      await applyIncident(ctx);
      const c = ctx.contract as Contract;
      const targets = await prometheus.targets();
      const t = targets.find((x) => x.labels.job === `svc-${args.service}`);
      const ts = await prometheus.query(`timestamp(last_over_time(sw_queue_depth{app="${args.service}"}[10m]))`);
      const newest = ts.length ? Math.max(...ts.map((r) => Number(r.value![1]))) : null;
      const age = newest === null ? null : Math.round(Date.now() / 1000 - newest);
      const live = await prometheus.query(`sw_queue_depth{app="${args.service}"}`);
      const obs = { service: args.service, target_health: t?.health ?? "missing", last_error: t?.lastError ?? "", last_scrape: t?.lastScrape ?? null,
        newest_sample_age_seconds: age, live_series: live.length, fresh: live.length > 0 && age !== null && age <= c.freshness_seconds, observed_at: new Date().toISOString(), age_seconds: age };
      const id = await ctx.artifact("series", `${args.service} series`, obs);
      return { observations: obs, evidence: [id] };
    },
  },
  {
    name: "serieswatch.probe_health", description: "Allowlisted HTTP health probe of one service's application endpoint.",
    args: z.object({ service: Svc }), mutating: false, budgeted: true, timeoutMs: 15_000,
    async run(ctx: RunContext, args: { service: string }) {
      await applyIncident(ctx);
      const h = await exporter.health(args.service);
      const obs = { service: args.service, status: h.status, ok: h.ok, observed_at: new Date().toISOString() };
      const id = await ctx.artifact("health", `${args.service} health`, obs);
      return { observations: obs, evidence: [id] };
    },
  },
  {
    name: "serieswatch.grafana_view", description: "Read Grafana's own alert instance states and state history for the watched services (read-only).",
    args: z.object({}), mutating: false, timeoutMs: 20_000,
    async run(ctx: RunContext) {
      await applyIncident(ctx);
      const uid = ctx.memory.incident.rule_uid;
      const st = await ruleState(uid);
      const hist = await stateHistory(uid, Date.parse(ctx.memory.incident.applied_at) - 60_000);
      const obs = { instances: st.instances.map((i) => ({ app: i.labels.app ?? "(no-data)", state: i.state })), history: hist.map((h) => ({ app: h.labels.app ?? "?", prev: h.prev, next: h.next, time: h.time })) };
      const id = await ctx.artifact("grafana", "Grafana state", obs);
      return { observations: obs, evidence: [id] };
    },
  },
];

function evidenceFor(ctx: RunContext) {
  const results = ctx.memory.results ?? [];
  const per: Record<string, { series?: any; health?: any; refs: string[] }> = {};
  for (const r of results) {
    if (r.tool === "serieswatch.query_series") (per[r.args.service] ??= { refs: [] }).series = r.observations, per[r.args.service].refs.push(...(r.evidence ?? []));
    if (r.tool === "serieswatch.probe_health") (per[r.args.service] ??= { refs: [] }).health = r.observations, per[r.args.service].refs.push(...(r.evidence ?? []));
  }
  const grafana = [...results].reverse().find((r: any) => r.tool === "serieswatch.grafana_view")?.observations ?? null;
  return { per, grafana };
}

const serieswatch: ModuleDef = {
  id: "serieswatch",
  title: "SeriesWatch",
  tagline: "A service went quiet. Is it down, unmonitored, or retired on purpose?",
  plain: {
    job: "When a service's metrics vanish, dashboards just go blank and alerts may resolve. That could mean the service crashed, only its exporter broke, or someone retired it on purpose. Each needs a different response, and absence alone can't tell them apart.",
    example: "Billing's series disappear at 02:10. SeriesWatch checks the service inventory (billing should exist), the retirement ledger (no approved retirement), the scrape target (down) and a health probe (HTTP 503): service failure. Search's series also vanish, but its health endpoint answers 200 while the scrape returns HTTP 500: an exporter problem, not an outage.",
    howItWorks: [
      "Read an independent desired-service inventory and approved retirement ledger, with timestamps.",
      "Query Prometheus for scrape-target health and the age of each service's newest sample.",
      "Probe each application's health endpoint (allowlisted, local only).",
      "Classify only supported cases; a stale inventory or missing evidence yields 'inconclusive'. Grafana's own state is shown alongside, unmodified.",
    ],
    notThis: "Grafana already detects missing series. SeriesWatch adds desired-state evidence to explain them; it never edits Grafana's state history.",
  },
  contractSchema: SeriesContract,
  defaultContract: { inventory_max_age_minutes: 1440, freshness_seconds: 30, require_approved_retirement: true },
  fixtures: [
    {
      name: "incident-set", version: "v1", title: "Four disappearances, current inventory",
      manifest: {
        description: "Billing, search, legacy-report and payments all stop reporting at once.",
        incident: { billing: { health: "down" }, search: { metrics: "error" }, "legacy-report": { metrics: "absent", health: "down" }, payments: { metrics: "absent" } },
        inventory: { snapshot_at: "__NOW__", services: [{ name: "billing", owner: "finance-eng" }, { name: "search", owner: "search-infra" }, { name: "payments", owner: "payments" }, { name: "checkout", owner: "payments" }] },
        retirements: [{ id: "RET-104", service: "legacy-report", status: "approved", effective_at: "__NOW__", approved_by: "platform-review" }],
      },
      fault: { truth: { billing: "endpoint_down", search: "telemetry_failure", "legacy-report": "intentional_retirement", payments: "telemetry_failure" } },
    },
    {
      name: "incident-set", version: "v2", title: "Retirement not yet approved",
      manifest: {
        description: "Same outage, but legacy-report's retirement is only proposed.",
        incident: { billing: { health: "down" }, search: { metrics: "error" }, "legacy-report": { metrics: "absent", health: "down" }, payments: { metrics: "absent" } },
        inventory: { snapshot_at: "__NOW__", services: [{ name: "billing", owner: "finance-eng" }, { name: "search", owner: "search-infra" }, { name: "payments", owner: "payments" }, { name: "legacy-report", owner: "reporting" }] },
        retirements: [{ id: "RET-104", service: "legacy-report", status: "proposed", effective_at: "__NOW__", approved_by: null }],
      },
      fault: { truth: { billing: "endpoint_down", search: "telemetry_failure", "legacy-report": "endpoint_down", payments: "telemetry_failure" } },
    },
    {
      name: "incident-set", version: "v3", title: "Stale inventory",
      manifest: {
        description: "The inventory export is three days old.",
        incident: { billing: { health: "down" }, search: { metrics: "error" }, "legacy-report": { metrics: "absent", health: "down" }, payments: { metrics: "absent" } },
        inventory: { snapshot_at: "__THREE_DAYS_AGO__", services: [{ name: "billing", owner: "finance-eng" }, { name: "search", owner: "search-infra" }, { name: "payments", owner: "payments" }] },
        retirements: [{ id: "RET-104", service: "legacy-report", status: "approved", effective_at: "__THREE_DAYS_AGO__", approved_by: "platform-review" }],
      },
      fault: { truth: { billing: "inconclusive", search: "inconclusive", "legacy-report": "inconclusive", payments: "inconclusive" } },
    },
  ],
  tools: seriesweatchTools as any,
  baselinePlan: () => [
    { tool: "serieswatch.inspect_inventory", args: {} },
    ...WATCHED.flatMap((s) => [{ tool: "serieswatch.query_series", args: { service: s } }, { tool: "serieswatch.probe_health", args: { service: s } }]),
    { tool: "serieswatch.grafana_view", args: {} },
  ],
  budget: 8,
  agentView(ctx) {
    const { per } = evidenceFor(ctx);
    return {
      contract: ctx.contract,
      watched_services: WATCHED,
      inventory: ctx.fixture.manifest.inventory,
      retirements: ctx.fixture.manifest.retirements,
      evidence: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, { series: v.series ? { target: v.series.target_health, fresh: v.series.fresh } : null, health: v.health ? v.health.ok : null }])),
    };
  },
  evaluate(ctx): EvalResult {
    const c = ctx.contract as Contract;
    const { per, grafana } = evidenceFor(ctx);
    const now = Date.parse(ctx.memory.incident?.applied_at ?? new Date().toISOString());
    const inv = ctx.fixture.manifest.inventory;
    const rows = WATCHED.map((svc) => {
      const r = classify(c, svc, inv, ctx.fixture.manifest.retirements, per[svc] ?? {}, now);
      const g = grafana?.instances.find((i: any) => i.app === svc);
      const gh = grafana?.history.filter((h: any) => h.app === svc).map((h: any) => `${h.prev} → ${h.next}`).join("; ");
      return { service: svc, workbench: r.class, why: r.why, grafana: g ? g.state : gh ? `no live instance (history: ${gh})` : "no live instance", evidence: per[svc]?.refs ?? [] };
    });
    const unsupported = rows.filter((r) => r.workbench === "inconclusive");
    const findings: Finding[] = rows.filter((r) => r.workbench !== "present").map((r) => ({
      invariant_id: `disappearance_explained:${r.service}`, expected: "a supported, evidence-backed classification", observed: `${r.workbench}: ${r.why}`,
      evidence_refs: r.evidence, severity: r.workbench === "endpoint_down" ? "high" : r.workbench === "telemetry_failure" ? "medium" : "info",
      provenance: "seeded", reproduction_ref: `${ctx.fixture.name}@${ctx.fixture.version} incident ${JSON.stringify(ctx.fixture.manifest.incident[r.service] ?? {})}`,
    }));
    const result = unsupported.length === rows.length ? "inconclusive" : unsupported.length ? "inconclusive" : "pass";
    return {
      verdict: {
        result, scope: `${ctx.fixture.name}@${ctx.fixture.version}, ${WATCHED.length} watched services`,
        reasons: result === "pass" ? ["every disappearance was explained by a supported, evidence-backed case"] : unsupported.map((r) => `${r.service}: ${r.why}`),
        evidence_refs: rows.flatMap((r) => r.evidence), limitations: ["Seeded local incident; the classifier only supports the four documented cases."],
      },
      findings,
      summary: { rows, grafana_view_collected: !!grafana },
    };
  },
  async cleanup(ctx) {
    await deleteFolder(`sw-${ctx.shortId}`);
    for (const s of SERVICES) await exporter.reset(s);
  },
};
export default serieswatch;
