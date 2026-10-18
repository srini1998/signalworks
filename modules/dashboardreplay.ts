// DashboardReplay: did a dashboard revision change what a panel means?
// Both revisions are provisioned into the real Grafana, their panel queries are executed through
// Grafana's datasource query API over the SAME frozen time window with explicitly bound variable
// values, and declared semantics (environment scope, unit, aggregation) are asserted against an
// independent reference query. Unsupported features are rejected before any comparison.
import { z } from "zod";
import type { EvalResult, ModuleDef, RunContext } from "./types.ts";
import { deleteFolder, ensureFolder } from "./grafana.ts";
import { grafana, prometheus, sleep, TargetError } from "../worker/targets.ts";
import type { Finding } from "../agent/schemas.ts";

export const DashboardContract = z.object({
  panel_title: z.string(),
  scope_env: z.enum(["production", "staging"]).describe("the panel must only include this environment"),
  unit: z.string().describe("Grafana unit id the panel must declare"),
  aggregation: z.enum(["sum"]),
  window_seconds: z.number().int().min(60).max(600),
  tolerance: z.number().min(0).max(0.2),
});
type Contract = z.infer<typeof DashboardContract>;

const SUPPORTED_PANELS = new Set(["timeseries", "stat"]);
const VARIABLE_TYPES = new Set(["custom", "constant"]);

type Panel = { title: string; type: string; unit?: string; expr: string; transformations?: unknown[]; datasource?: string };
type Revision = { title: string; variables: { name: string; type: string; value?: string }[]; panels: Panel[] };

/** Supported-subset gate: returns human-readable reasons a revision cannot be compared. */
export function unsupportedFeatures(rev: Revision): string[] {
  const out: string[] = [];
  for (const v of rev.variables) {
    if (!VARIABLE_TYPES.has(v.type)) out.push(`variable $${v.name} is a ${v.type} variable; only custom/constant variables with fixed values are supported`);
    else if (v.value === undefined) out.push(`variable $${v.name} has no fixed value, so its queries cannot be resolved reproducibly`);
  }
  for (const p of rev.panels) {
    if (!SUPPORTED_PANELS.has(p.type)) out.push(`panel "${p.title}" uses panel type ${p.type}; only timeseries and stat are supported`);
    if (p.transformations?.length) out.push(`panel "${p.title}" applies transformations (${(p.transformations as any[]).map((t) => t.id).join(", ")}); transformed values are out of scope`);
    if (p.datasource && p.datasource !== "sw-prom") out.push(`panel "${p.title}" queries datasource ${p.datasource}; only the direct Prometheus datasource is supported`);
    const unresolved = [...p.expr.matchAll(/\$(\w+)/g)].map((m) => m[1]).filter((n) => !rev.variables.some((v) => v.name === n && v.value !== undefined));
    if (unresolved.length) out.push(`panel "${p.title}" references unresolved variable(s) ${unresolved.map((n) => "$" + n).join(", ")}`);
  }
  return out;
}

export function bind(expr: string, vars: Revision["variables"]): string {
  return expr.replace(/\$(\w+)/g, (_, n) => vars.find((v) => v.name === n)?.value ?? `$${n}`);
}

function toDashboardJson(rev: Revision, uid: string) {
  return {
    uid, title: rev.title, schemaVersion: 39, time: { from: "now-15m", to: "now" },
    templating: { list: rev.variables.map((v) => ({ name: v.name, type: v.type, query: v.value ?? "", current: v.value ? { text: v.value, value: v.value } : {}, options: [] })) },
    panels: rev.panels.map((p, i) => ({
      id: i + 1, title: p.title, type: p.type, gridPos: { x: 0, y: i * 8, w: 24, h: 8 },
      datasource: { type: "prometheus", uid: p.datasource ?? "sw-prom" },
      fieldConfig: { defaults: { unit: p.unit ?? "none" }, overrides: [] },
      transformations: p.transformations ?? [],
      targets: [{ refId: "A", expr: p.expr, datasource: { type: "prometheus", uid: p.datasource ?? "sw-prom" } }],
    })),
  };
}

type SeriesResult = { labels: Record<string, string>; points: [number, number][] };

async function grafanaQuery(expr: string, fromMs: number, toMs: number): Promise<SeriesResult[]> {
  const res = await grafana.req<any>("POST", "/api/ds/query", {
    queries: [{ refId: "A", datasource: { type: "prometheus", uid: "sw-prom" }, expr, range: true, instant: false, intervalMs: 15_000, maxDataPoints: 200 }],
    from: String(fromMs), to: String(toMs),
  });
  const frames = res.results?.A?.frames ?? [];
  if (res.results?.A?.error) throw new Error(`query error: ${res.results.A.error}`);
  return frames.map((f: any) => ({
    labels: f.schema.fields[1]?.labels ?? {},
    points: (f.data.values[0] ?? []).map((t: number, i: number) => [t, Number(f.data.values[1][i])] as [number, number]),
  }));
}

const meanOf = (s: SeriesResult[]) => {
  const vals = s.flatMap((x) => x.points.map((p) => p[1])).filter((v) => Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
};
const totalMean = (s: SeriesResult[]) => s.reduce((acc, x) => acc + meanOf([x]), 0);

export function assess(c: Contract, panel: Panel, result: SeriesResult[], reference: SeriesResult[]) {
  const checks: { invariant: string; ok: boolean | null; expected: string; observed: string }[] = [];
  const ref = meanOf(reference);
  const got = totalMean(result);
  const rel = Number.isFinite(ref) && ref !== 0 ? Math.abs(got - ref) / ref : NaN;
  checks.push({ invariant: "scope_matches_reference", ok: Number.isFinite(rel) ? rel <= c.tolerance : null,
    expected: `mean ≈ ${ref.toFixed(3)} (independent ${c.scope_env}-only reference, ±${c.tolerance * 100}%)`,
    observed: `mean ${got.toFixed(3)}${Number.isFinite(rel) ? ` (${(rel * 100).toFixed(1)}% off)` : ""}${result.some((s) => s.labels.env && s.labels.env !== c.scope_env) ? `; series include env=${[...new Set(result.map((s) => s.labels.env))].join(",")}` : ""}` });
  checks.push({ invariant: "unit_declared", ok: (panel.unit ?? "none") === c.unit, expected: `unit ${c.unit}`, observed: `unit ${panel.unit ?? "none"}` });
  checks.push({ invariant: "aggregated_to_single_series", ok: result.length === 1, expected: "one aggregated series (sum)", observed: `${result.length} series` });
  return checks;
}

const rev = (ctx: RunContext, which: "before" | "after"): Revision => ctx.fixture.manifest[which];
const latest = (ctx: RunContext, tool: string, pred: (r: any) => boolean = () => true) =>
  [...(ctx.memory.results ?? [])].reverse().find((r: any) => r.tool === tool && pred(r));

const dashboardreplay: ModuleDef = {
  id: "dashboardreplay",
  title: "DashboardReplay",
  tagline: "Does the edited dashboard still show the same thing?",
  plain: {
    job: "A dashboard edit can look harmless and still change what a panel means: a dropped label filter quietly adds staging traffic to a production panel, or a unit change multiplies every value by 60. Comparing two graphs by eye — over two different live time windows — won't catch it.",
    example: "'Orders per second (production)' is edited to simplify its query and loses the env filter. The graph looks similar but now reads 11 orders/s instead of 8. DashboardReplay runs both versions over the same frozen two minutes and checks the result against an independent production-only reference.",
    howItWorks: [
      "Check both revisions against the supported subset (direct Prometheus queries, fixed variables, no transformations or plugins).",
      "Provision both dashboards in the real Grafana and freeze a time window after the data is ingested.",
      "Execute each revision's panel queries through Grafana's query API with the variables bound explicitly.",
      "Assert declared semantics — scope, unit, aggregation — against an independent reference query; explain any difference.",
    ],
    notThis: "It does not auto-rewrite queries or compare screenshots; unsupported dashboards get an explanation instead of a green result.",
  },
  contractSchema: DashboardContract,
  defaultContract: { panel_title: "Orders per second (production)", scope_env: "production", unit: "ops", aggregation: "sum", window_seconds: 120, tolerance: 0.03 },
  fixtures: (() => {
    const before: Revision = { title: "Orders", variables: [{ name: "env", type: "custom", value: "production" }],
      panels: [{ title: "Orders per second (production)", type: "timeseries", unit: "ops", expr: 'sum(rate(sw_orders_total{env="$env"}[1m]))' }] };
    const mk = (after: Revision) => ({ before, after });
    return [
      { name: "orders-dashboard", version: "r2-valid", title: "Revision: grouped legend (valid)", fault: null,
        manifest: { description: "Adds a region breakdown in the tooltip; production total unchanged.", ...mk({ ...before, title: "Orders (r2)", panels: [{ ...before.panels[0], expr: 'sum(sum by (region) (rate(sw_orders_total{env="$env"}[1m])))' }] }) } },
      { name: "orders-dashboard", version: "r3-scope", title: "Revision: simplified query", fault: { invariant: "scope_matches_reference", note: "env filter dropped; staging counted as production" },
        manifest: { description: "Simplifies the query.", ...mk({ ...before, title: "Orders (r3)", panels: [{ ...before.panels[0], expr: "sum(rate(sw_orders_total[1m]))" }] }) } },
      { name: "orders-dashboard", version: "r4-unit", title: "Revision: per-minute display", fault: { invariant: "unit_declared", note: "values ×60 and unit changed to per-minute" },
        manifest: { description: "Shows orders per minute.", ...mk({ ...before, title: "Orders (r4)", panels: [{ ...before.panels[0], unit: "opm", expr: 'sum(rate(sw_orders_total{env="$env"}[1m])) * 60' }] }) } },
      { name: "orders-dashboard", version: "r5-unsupported", title: "Revision: computed field", fault: { invariant: "unsupported", note: "uses a transformation and an unresolved variable" },
        manifest: { description: "Adds a calculated field and a region picker.", ...mk({ ...before, title: "Orders (r5)", panels: [{ ...before.panels[0], expr: 'sum(rate(sw_orders_total{env="$env", region="$region"}[1m]))', transformations: [{ id: "calculateField" }] }] }) } },
    ];
  })(),
  tools: [
    {
      name: "dashboardreplay.check_support", description: "Validate one revision ('before' or 'after') against the supported subset; lists every unsupported feature.",
      args: z.object({ revision: z.enum(["before", "after"]) }), mutating: false, timeoutMs: 5000,
      async run(ctx, args) {
        const problems = unsupportedFeatures(rev(ctx, args.revision));
        return { observations: { revision: args.revision, supported: problems.length === 0, problems }, evidence: [] };
      },
    },
    {
      name: "dashboardreplay.provision_and_freeze", description: "Provision both supported revisions in Grafana, wait until the window is fully ingested, and freeze it [from, to].",
      args: z.object({}), mutating: true, timeoutMs: 60_000,
      async run(ctx) {
        const c = ctx.contract as Contract;
        const folder = `sw-${ctx.shortId}`;
        await ensureFolder(folder, `Signalworks run ${ctx.shortId}`);
        const uids: Record<string, string> = {};
        for (const which of ["before", "after"] as const) {
          if (unsupportedFeatures(rev(ctx, which)).length) continue;
          const uid = `sw-${ctx.shortId}-${which}`;
          await grafana.req("POST", "/api/dashboards/db", { dashboard: toDashboardJson(rev(ctx, which), uid), folderUid: folder, overwrite: true, message: `Signalworks ${ctx.shortId}` });
          uids[which] = uid;
        }
        // Freeze a window that ends a few scrapes in the past, so no sample in it can still change.
        let up = await prometheus.query("count(sw_orders_total)");
        for (let i = 0; i < 10 && !up.length; i++) {
          await sleep(2000);
          up = await prometheus.query("count(sw_orders_total)");
        }
        const to = Math.floor((Date.now() - 10_000) / 1000) * 1000;
        const from = to - c.window_seconds * 1000;
        const obs = { from, to, from_iso: new Date(from).toISOString(), to_iso: new Date(to).toISOString(), dashboards: uids };
        const id = await ctx.artifact("window", "frozen window", obs);
        return { observations: obs, evidence: [id] };
      },
    },
    {
      name: "dashboardreplay.execute", description: "Execute one revision's contracted panel through Grafana's query API over the frozen window, with variables bound; also runs the independent reference query.",
      args: z.object({ revision: z.enum(["before", "after"]) }), mutating: true, timeoutMs: 30_000,
      async run(ctx, args) {
        const c = ctx.contract as Contract;
        const win = latest(ctx, "dashboardreplay.provision_and_freeze")?.observations;
        if (!win) throw new TargetError("no frozen window yet: call dashboardreplay.provision_and_freeze first", "validation");
        const r = rev(ctx, args.revision);
        const problems = unsupportedFeatures(r);
        if (problems.length) return { observations: { revision: args.revision, unsupported: problems }, evidence: [] };
        const panel = r.panels.find((p) => p.title === c.panel_title) ?? r.panels[0];
        const expr = bind(panel.expr, r.variables);
        const result = await grafanaQuery(expr, win.from, win.to);
        const referenceExpr = `sum(rate(sw_orders_total{env="${c.scope_env}"}[1m]))`;
        const reference = await grafanaQuery(referenceExpr, win.from, win.to);
        const checks = assess(c, panel, result, reference);
        const obs = { revision: args.revision, panel: panel.title, query_text: panel.expr, bound_query: expr, variable_bindings: r.variables, datasource: "sw-prom (Prometheus 3.15.0)",
          window: { from: win.from_iso, to: win.to_iso }, reference_query: referenceExpr, series: result.map((s) => ({ labels: s.labels, points: s.points.length, mean: meanOf([s]) })), checks };
        const id = await ctx.artifact("query", `${args.revision} panel`, { ...obs, result, reference });
        return { observations: obs, evidence: [id] };
      },
    },
  ],
  baselinePlan: () => [
    { tool: "dashboardreplay.check_support", args: { revision: "before" } },
    { tool: "dashboardreplay.check_support", args: { revision: "after" } },
    { tool: "dashboardreplay.provision_and_freeze", args: {} },
    { tool: "dashboardreplay.execute", args: { revision: "before" } },
    { tool: "dashboardreplay.execute", args: { revision: "after" } },
  ],
  budget: 4,
  agentView(ctx) {
    return {
      contract: ctx.contract,
      revisions: { before: rev(ctx, "before"), after: rev(ctx, "after") },
      done: (ctx.memory.results ?? []).map((r: any) => ({ tool: r.tool, args: r.args, summary: r.observations.checks ?? r.observations.problems ?? r.observations.unsupported ?? (r.observations.from_iso ? "window frozen" : undefined) })),
    };
  },
  evaluate(ctx): EvalResult {
    const results = ctx.memory.results ?? [];
    const support = { before: unsupportedFeatures(rev(ctx, "before")), after: unsupportedFeatures(rev(ctx, "after")) };
    const execAfter = latest(ctx, "dashboardreplay.execute", (r) => r.args.revision === "after" && r.observations.checks);
    const execBefore = latest(ctx, "dashboardreplay.execute", (r) => r.args.revision === "before" && r.observations.checks);
    if (support.after.length || support.before.length) {
      return {
        verdict: { result: "unsupported", scope: `${ctx.fixture.name}@${ctx.fixture.version}`, reasons: [...support.before.map((p) => `before: ${p}`), ...support.after.map((p) => `after: ${p}`)],
          evidence_refs: [], limitations: ["Unsupported revisions are rejected before comparison; no values were compared."] },
        findings: [], summary: { support },
      };
    }
    if (!execAfter || !execBefore) {
      return { verdict: { result: "inconclusive", scope: `${ctx.fixture.name}@${ctx.fixture.version}`, reasons: ["both revisions were not executed over the frozen window"], evidence_refs: [], limitations: [] }, findings: [], summary: { support } };
    }
    const findings: Finding[] = execAfter.observations.checks.filter((c: any) => c.ok === false).map((c: any) => ({
      invariant_id: c.invariant, expected: c.expected, observed: `${c.observed} (before: ${execBefore.observations.checks.find((b: any) => b.invariant === c.invariant)?.observed})`,
      evidence_refs: [...(execBefore.evidence ?? []), ...(execAfter.evidence ?? [])], severity: c.invariant === "scope_matches_reference" ? "high" : "medium", provenance: "observed",
      reproduction_ref: `${execAfter.observations.bound_query} over ${execAfter.observations.window.from}..${execAfter.observations.window.to}`,
    }));
    const beforeBroken = execBefore.observations.checks.some((c: any) => c.ok === false);
    const undetermined = execAfter.observations.checks.some((c: any) => c.ok === null);
    const result = findings.length ? "fail" : beforeBroken || undetermined ? "inconclusive" : "pass";
    return {
      verdict: { result, scope: `${ctx.fixture.name}@${ctx.fixture.version}, panel "${execAfter.observations.panel}", frozen window ${execAfter.observations.window.from}..${execAfter.observations.window.to}`,
        reasons: findings.length ? findings.map((f) => `${f.invariant_id}: ${f.observed}`) : beforeBroken ? ["the 'before' revision itself violates the contract"] : ["the revision preserves scope, unit and aggregation over identical data"],
        evidence_refs: results.flatMap((r: any) => r.evidence ?? []), limitations: ["Synthetic order counters with fixed per-environment rates; one panel."] },
      findings,
      summary: { before: execBefore.observations, after: execAfter.observations },
    };
  },
  async cleanup(ctx) {
    await deleteFolder(`sw-${ctx.shortId}`);
  },
};
export default dashboardreplay;
