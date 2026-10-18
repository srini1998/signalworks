// MetricContract: does a release's real metric output still match the reviewed contract?
// Structure (names, types, labels, cardinality) is read from the exporter's actual exposition and
// Prometheus' ingested series. Units are judged only with an independent witness: a workload whose
// true latency the worker controls. Without one, the unit check is "insufficient evidence".
import { z } from "zod";
import type { EvalResult, ModuleDef, RunContext } from "./types.ts";
import { exporter, prometheus, sleep } from "../worker/targets.ts";
import type { Finding } from "../agent/schemas.ts";

const SERVICE = "payments";

const MetricSpec = z.object({
  name: z.string(),
  type: z.enum(["counter", "gauge", "histogram"]),
  unit: z.enum(["seconds", "none"]),
  required_labels: z.array(z.string()),
});
export const MetricContractSchema = z.object({
  service: z.literal(SERVICE),
  metrics: z.array(MetricSpec).min(1),
  cardinality_cap: z.number().int().min(1).max(5000).describe("maximum ingested series per metric"),
  unit_tolerance: z.number().min(0.01).max(0.5).describe("allowed relative error of the witnessed mean latency"),
});
type Contract = z.infer<typeof MetricContractSchema>;

type Family = { name: string; type: string; series: { labels: Record<string, string>; value: number }[] };

export function parseExposition(text: string): Record<string, Family> {
  const fams: Record<string, Family> = {};
  const familyOf = (sample: string) => {
    for (const suffix of ["_bucket", "_sum", "_count"]) if (sample.endsWith(suffix) && fams[sample.slice(0, -suffix.length)]?.type === "histogram") return sample.slice(0, -suffix.length);
    return sample;
  };
  for (const line of text.split("\n")) {
    const t = line.match(/^# TYPE (\S+) (\S+)/);
    if (t) {
      fams[t[1]] = { name: t[1], type: t[2], series: [] };
      continue;
    }
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)/);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const pair of (m[2] ?? "").matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[pair[1]] = pair[2];
    const fam = familyOf(m[1]);
    (fams[fam] ??= { name: fam, type: "untyped", series: [] }).series.push({ labels: { ...labels, __sample__: m[1] }, value: Number(m[3]) });
  }
  return fams;
}

async function deploy(ctx: RunContext) {
  if (ctx.memory.deployed) return;
  const release = ctx.fixture.manifest.release;
  await exporter.reset(SERVICE);
  await exporter.setState(SERVICE, { release, cardinality_users: ctx.fixture.manifest.cardinality_users ?? 0 });
  // A contracted service is inspected while it serves traffic: a few steady requests make the
  // request counters exist. The unit witness later measures only its own delta on top of these.
  await exporter.workload(SERVICE, 10, 120);
  await sleep(5000); // >= 2 scrape intervals so Prometheus has ingested the new release
  ctx.memory.deployed = { release, at: new Date().toISOString() };
}

async function ingestedSeries(metric: string): Promise<{ count: number; labelSets: Record<string, string>[] }> {
  const res = await prometheus.query(`{__name__=~"${metric}(_bucket|_sum|_count)?", service="${SERVICE}"}`);
  return { count: new Set(res.map((r) => JSON.stringify(r.metric))).size, labelSets: res.slice(0, 5).map((r) => r.metric) };
}

async function histogramTotals(metric: string): Promise<{ sum: number; count: number } | null> {
  const [s, c] = await Promise.all([prometheus.query(`sum(${metric}_sum{service="${SERVICE}"})`), prometheus.query(`sum(${metric}_count{service="${SERVICE}"})`)]);
  if (!s.length || !c.length) return null;
  return { sum: Number(s[0].value![1]), count: Number(c[0].value![1]) };
}

type FamilySummary = { name: string; type: string; series: number; labels: string[] };

export function compare(contract: Contract, families: FamilySummary[] | undefined, ingested: Record<string, number> | undefined, witnesses: any[]) {
  const scrape = families ? Object.fromEntries(families.map((f) => [f.name, f])) : undefined;
  const checks: { invariant: string; metric: string; ok: boolean | null; expected: string; observed: string }[] = [];
  if (!scrape) return checks;
  for (const m of contract.metrics) {
    const fam = scrape[m.name];
    checks.push({ invariant: "metric_present", metric: m.name, ok: !!fam, expected: `${m.name} is exposed`, observed: fam ? `exposed as ${fam.type}` : "not exposed" });
    if (!fam) continue;
    checks.push({ invariant: "metric_type", metric: m.name, ok: fam.type === m.type, expected: m.type, observed: fam.type });
    const missing = m.required_labels.filter((l) => !fam.labels.includes(l));
    const extra = fam.labels.filter((l) => !["__sample__", "le", ...m.required_labels].includes(l));
    checks.push({ invariant: "required_labels", metric: m.name, ok: missing.length === 0, expected: `labels ${m.required_labels.join(", ")}`,
      observed: missing.length ? `missing ${missing.join(", ")}${extra.length ? `; unexpected ${extra.join(", ")}` : ""}` : `present${extra.length ? `; also ${extra.join(", ")}` : ""}` });
    const n = ingested?.[m.name];
    if (n !== undefined)
      checks.push({ invariant: "cardinality_cap", metric: m.name, ok: n <= contract.cardinality_cap, expected: `<= ${contract.cardinality_cap} ingested series`, observed: `${n} series in Prometheus` });
    if (m.unit === "seconds") {
      const usable = witnesses.filter((w) => w.metric === m.name && w.delta_count > 0);
      if (!usable.length) {
        checks.push({ invariant: "unit_witnessed", metric: m.name, ok: null, expected: "mean latency matches a controlled workload (seconds)",
          observed: "no controlled workload was run: units cannot be judged from arbitrary magnitudes" });
      } else {
        const verdicts = usable.map((w) => {
          const ratio = w.observed_mean / w.true_seconds;
          return { w, ratio, ok: Math.abs(ratio - 1) <= contract.unit_tolerance ? true : Math.abs(ratio / 1000 - 1) <= contract.unit_tolerance ? false : null };
        });
        const bad = verdicts.find((v) => v.ok === false);
        const unclear = verdicts.every((v) => v.ok === null);
        checks.push({ invariant: "unit_witnessed", metric: m.name, ok: bad ? false : unclear ? null : true,
          expected: `observed mean ≈ true latency (±${contract.unit_tolerance * 100}%)`,
          observed: verdicts.map((v) => `workload ${v.w.true_seconds}s → recorded mean ${v.w.observed_mean.toPrecision(4)} (×${v.ratio.toPrecision(4)})`).join("; ") +
            (bad ? " — consistent with milliseconds recorded under a _seconds name" : unclear ? " — ratio matches neither seconds nor milliseconds" : "") });
      }
    }
  }
  return checks;
}

const latest = (ctx: RunContext, tool: string) => [...(ctx.memory.results ?? [])].reverse().find((r: any) => r.tool === tool)?.observations;
const evidenceState = (ctx: RunContext) => ({
  families: latest(ctx, "metriccontract.scrape")?.families as FamilySummary[] | undefined,
  ingested: latest(ctx, "metriccontract.query_series")?.ingested_series as Record<string, number> | undefined,
  witnesses: (ctx.memory.results ?? []).filter((r: any) => r.tool === "metriccontract.run_workload").map((r: any) => r.observations),
});

const metriccontract: ModuleDef = {
  id: "metriccontract",
  title: "MetricContract",
  tagline: "Did the new release quietly change what your metrics mean?",
  plain: {
    job: "Dashboards and alerts assume a metric keeps its name, labels and unit. A release can rename a label, drop a metric, explode cardinality, or start reporting milliseconds under a _seconds name — and every downstream threshold silently breaks.",
    example: "Payments v5 records 250 ms requests as 250 instead of 0.25. The alert 'p99 > 2 seconds' now fires constantly — or, the other way around, a renamed status label makes your error-rate panel show zero.",
    howItWorks: [
      "Deploy the candidate release of the test service and let Prometheus ingest it.",
      "Read the real exposition (names, types, labels) and the ingested series count in Prometheus.",
      "Run a controlled workload with a known latency as an independent witness for units.",
      "Compare everything with the reviewed contract; units without a witness are reported as insufficient evidence.",
    ],
    notThis: "It does not guess units from numbers or names. A unit verdict requires controlled input.",
  },
  contractSchema: MetricContractSchema,
  defaultContract: {
    service: SERVICE,
    metrics: [
      { name: "sw_requests_total", type: "counter", unit: "none", required_labels: ["service", "route", "status"] },
      { name: "sw_request_duration_seconds", type: "histogram", unit: "seconds", required_labels: ["service"] },
    ],
    cardinality_cap: 60,
    unit_tolerance: 0.1,
  },
  fixtures: [
    { name: "payments-release", version: "v1", title: "v1: the reviewed release", manifest: { release: "v1", description: "Release that the contract was written against." }, fault: null },
    { name: "payments-release", version: "v2", title: "v2 candidate", manifest: { release: "v2-missing-metric", description: "Refactored request middleware." }, fault: { invariant: "metric_present", note: "sw_requests_total no longer exported" } },
    { name: "payments-release", version: "v3", title: "v3 candidate", manifest: { release: "v3-renamed-label", description: "Adopted a new HTTP library." }, fault: { invariant: "required_labels", note: "status label renamed to code" } },
    { name: "payments-release", version: "v4", title: "v4 candidate", manifest: { release: "v4-cardinality", cardinality_users: 300, description: "Added per-customer request tracking." }, fault: { invariant: "cardinality_cap", note: "user_id label creates hundreds of series" } },
    { name: "payments-release", version: "v5", title: "v5 candidate", manifest: { release: "v5-milliseconds", description: "Switched to a new timing helper." }, fault: { invariant: "unit_witnessed", note: "durations recorded in milliseconds under a _seconds name" } },
  ],
  tools: [
    {
      name: "metriccontract.scrape", description: "Read the deployed release's actual Prometheus exposition: metric names, types and label sets.", args: z.object({}), mutating: false, timeoutMs: 20_000,
      async run(ctx) {
        await deploy(ctx);
        const res = await exporter.scrape(SERVICE);
        const fams = parseExposition(res.text);
        const families: FamilySummary[] = Object.values(fams).map((f) => ({ name: f.name, type: f.type, series: f.series.length,
          labels: [...new Set(f.series.flatMap((s) => Object.keys(s.labels)))].filter((l) => l !== "__sample__").sort() }));
        const id = await ctx.artifact("exposition", "exporter scrape", { status: res.status, families, sample: res.text.slice(0, 4000) });
        return { observations: { http_status: res.status, families }, evidence: [id] };
      },
    },
    {
      name: "metriccontract.query_series", description: "Count the series Prometheus actually ingested for each contracted metric.", args: z.object({}), mutating: false, timeoutMs: 20_000,
      async run(ctx) {
        await deploy(ctx);
        const out: Record<string, number> = {};
        const detail: Record<string, unknown> = {};
        for (const m of (ctx.contract as Contract).metrics) {
          const s = await ingestedSeries(m.name);
          out[m.name] = s.count;
          detail[m.name] = s;
        }
        const meta = await prometheus.metadata().catch(() => ({}));
        const id = await ctx.artifact("prometheus", "ingested series", { counts: out, detail, metadata: Object.fromEntries(Object.entries(meta).filter(([k]) => k.startsWith("sw_"))) });
        return { observations: { ingested_series: out }, evidence: [id] };
      },
    },
    {
      name: "metriccontract.run_workload", description: "Send a controlled workload of `requests` requests whose true latency is `latency_ms`, then measure the mean the release recorded (via Prometheus). This is the independent unit witness.",
      args: z.object({ requests: z.number().int().min(5).max(200), latency_ms: z.number().int().min(20).max(3000) }), mutating: true, timeoutMs: 30_000,
      async run(ctx, args) {
        await deploy(ctx);
        const metric = "sw_request_duration_seconds";
        const before = await histogramTotals(metric);
        const w = await exporter.workload(SERVICE, args.requests, args.latency_ms);
        let after = before;
        for (let i = 0; i < 10; i++) {
          await sleep(1500);
          after = await histogramTotals(metric);
          if (after && (!before || after.count >= before.count + args.requests)) break;
        }
        const dCount = (after?.count ?? 0) - (before?.count ?? 0);
        const dSum = (after?.sum ?? 0) - (before?.sum ?? 0);
        const witness = { metric, requests: args.requests, true_seconds: w.true_latency_seconds, delta_count: dCount, delta_sum: dSum, observed_mean: dCount > 0 ? dSum / dCount : NaN };
        const id = await ctx.artifact("witness", `workload ${args.requests}×${args.latency_ms}ms`, { before, after, ...witness });
        return { observations: witness, evidence: [id] };
      },
    },
    {
      name: "metriccontract.compare", description: "Compare the latest scrape, ingested series and witnesses with the contract.", args: z.object({}), mutating: false, timeoutMs: 5000,
      async run(ctx) {
        const e = evidenceState(ctx);
        return { observations: { checks: compare(ctx.contract, e.families, e.ingested, e.witnesses) }, evidence: [] };
      },
    },
  ],
  baselinePlan: () => [
    { tool: "metriccontract.scrape", args: {} },
    { tool: "metriccontract.query_series", args: {} },
    { tool: "metriccontract.run_workload", args: { requests: 20, latency_ms: 250 } },
    { tool: "metriccontract.compare", args: {} },
  ],
  budget: 2,
  agentView(ctx) {
    return {
      contract: ctx.contract,
      candidate: { release_label: ctx.fixture.version, description: ctx.fixture.manifest.description },
      evidence_so_far: (() => {
        const e = evidenceState(ctx);
        return { scraped: !!e.families, ingested: e.ingested ?? null, witnesses: e.witnesses, checks: e.families ? compare(ctx.contract, e.families, e.ingested, e.witnesses) : [] };
      })(),
    };
  },
  evaluate(ctx): EvalResult {
    // Rebuild from recorded observations (works after a restart too).
    const results = ctx.memory.results ?? [];
    const e = evidenceState(ctx);
    const scrape = e.families;
    const checks = compare(ctx.contract, e.families, e.ingested, e.witnesses);
    const evidenceFor = (tool: string) => results.filter((r: any) => r.tool === tool).flatMap((r: any) => r.evidence ?? []);
    const findings: Finding[] = checks.filter((c) => c.ok === false).map((c) => ({
      invariant_id: c.invariant, expected: `${c.metric}: ${c.expected}`, observed: `${c.metric}: ${c.observed}`,
      evidence_refs: c.invariant === "unit_witnessed" ? evidenceFor("metriccontract.run_workload") : [...evidenceFor("metriccontract.scrape"), ...evidenceFor("metriccontract.query_series")],
      severity: "high", provenance: "observed", reproduction_ref: `deploy ${ctx.fixture.manifest.release}; ${c.invariant === "unit_witnessed" ? "run_workload" : "scrape"}`,
    }));
    const undetermined = checks.filter((c) => c.ok === null);
    const result = !scrape ? "inconclusive" : findings.length ? "fail" : undetermined.length ? "inconclusive" : "pass";
    const reasons = findings.length ? findings.map((f) => `${f.invariant_id}: ${f.observed}`) : undetermined.length ? undetermined.map((c) => `${c.metric}: ${c.observed}`) : !scrape ? ["the release was never scraped"] : ["structure, cardinality and witnessed units match the contract"];
    return {
      verdict: { result, scope: `${ctx.fixture.name}@${ctx.fixture.version} (${ctx.fixture.manifest.release}) on Prometheus 3.15.0`, reasons,
        evidence_refs: results.flatMap((r: any) => r.evidence ?? []), limitations: ["One synthetic service; the witness controls latency inside the test exporter, not a real network path."] },
      findings,
      summary: { checks },
    };
  },
  async cleanup() {
    await exporter.reset(SERVICE);
  },
};
export default metriccontract;
