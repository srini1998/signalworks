import { test } from "node:test";
import assert from "node:assert/strict";
import { checkScenario } from "../modules/alertscenario.ts";
import { compare, parseExposition } from "../modules/metriccontract.ts";
import { checkCase } from "../modules/routereplay.ts";
import { classify } from "../modules/serieswatch.ts";
import { assess, bind, unsupportedFeatures } from "../modules/dashboardreplay.ts";
import { judge, parseEcho, renderConfig } from "../modules/filterproof/index.ts";
import { corpusV1 } from "../modules/filterproof/corpus.ts";
import { AgentAction, ExperimentSpec } from "../agent/schemas.ts";
import { getModule } from "../modules/registry.ts";

const alertContract = { service: "checkout" as const, threshold: 50, pending_seconds: 30, eval_interval_seconds: 10 as const, missing_data_policy: "never_normal" as const, missing_series_must_be_labeled: true };
const sample = (t: number, c: string) => ({ t, shards: { a: "Normal", b: "Normal", c }, other: [] as string[] });

test("AlertScenario: sustained breach must fire inside the timing range and recover measurably", () => {
  const phases = [{ name: "high", start: 0 }, { name: "recovered", start: 70 }];
  const ok = checkScenario(alertContract, {}, "sustained", 70, phases, [sample(10, "Pending"), sample(40, "Alerting"), sample(80, "Normal")], [{ t: 79, shard: "c", prev: "Alerting", next: "Normal" }]);
  assert.equal(ok.ok, true);
  const late = checkScenario(alertContract, {}, "sustained", 70, phases, [sample(65, "Alerting"), sample(80, "Normal")], []);
  assert.equal(late.ok, false);
});

test("AlertScenario: a short breach is judged as a burst whatever the scenario is called", () => {
  const phases = [{ name: "high", start: 0 }, { name: "recovered", start: 13 }];
  const r = checkScenario(alertContract, {}, "sustained", 13, phases, [sample(10, "Pending"), sample(20, "Alerting")], []);
  assert.equal(r.invariant, "short_spike_does_not_fire");
  assert.equal(r.ok, false);
  const near = checkScenario(alertContract, {}, "spike", 25, phases, [sample(10, "Pending")], []);
  assert.equal(near.ok, null, "a spike too close to the pending period is not covered by the contract");
});

test("AlertScenario: missing data reported as plain Normal violates the contract; MissingSeries does not", () => {
  const phases = [{ name: "high", start: 0 }, { name: "all-series-absent", start: 40 }];
  const bad = checkScenario(alertContract, { no_data_state: "OK" }, "all_absent", null, phases, [sample(70, "Normal")], [{ t: 55, shard: "c", prev: "Alerting", next: "Normal" }]);
  assert.equal(bad.ok, false);
  const good = checkScenario(alertContract, { no_data_state: "NoData" }, "all_absent", null, phases,
    [{ t: 80, shards: {}, other: ["no-data instance:NoData"] }], [{ t: 55, shard: "c", prev: "Alerting", next: "Normal (MissingSeries)" }]);
  assert.equal(good.ok, true);
  const okMapped = checkScenario(alertContract, { no_data_state: "OK" }, "all_absent", null, phases,
    [{ t: 80, shards: { a: "Normal (NoData)", b: "Normal (NoData)", c: "Normal (NoData)" }, other: [] }], [{ t: 55, shard: "c", prev: "Alerting", next: "Normal (NoData)" }]);
  assert.equal(okMapped.ok, false, "Normal (NoData) is still Normal");
});

const metricContract = getModule("metriccontract").defaultContract;

test("MetricContract: parses exposition and flags renamed labels, cardinality and missing metrics", () => {
  const fams = parseExposition([
    "# TYPE sw_requests_total counter", 'sw_requests_total{service="payments",route="/pay",code="200"} 3',
    "# TYPE sw_request_duration_seconds histogram", 'sw_request_duration_seconds_bucket{service="payments",le="0.5"} 3', 'sw_request_duration_seconds_sum{service="payments"} 0.9', 'sw_request_duration_seconds_count{service="payments"} 3',
  ].join("\n"));
  assert.equal(fams.sw_request_duration_seconds.type, "histogram");
  const summary = Object.values(fams).map((f) => ({ name: f.name, type: f.type, series: f.series.length, labels: [...new Set(f.series.flatMap((s) => Object.keys(s.labels)))].filter((l) => l !== "__sample__") }));
  const checks = compare(metricContract, summary, { sw_requests_total: 500, sw_request_duration_seconds: 3 }, []);
  assert.equal(checks.find((c) => c.invariant === "required_labels" && c.metric === "sw_requests_total")!.ok, false);
  assert.equal(checks.find((c) => c.invariant === "cardinality_cap" && c.metric === "sw_requests_total")!.ok, false);
  assert.equal(checks.find((c) => c.invariant === "unit_witnessed")!.ok, null, "no witness -> insufficient evidence, never a guess");
  assert.equal(compare(metricContract, [], {}, []).find((c) => c.invariant === "metric_present")!.ok, false);
});

test("MetricContract: unit drift needs a witness; a 1000x ratio is milliseconds, an odd ratio stays undetermined", () => {
  const fams = [{ name: "sw_requests_total", type: "counter", series: 1, labels: ["service", "route", "status"] }, { name: "sw_request_duration_seconds", type: "histogram", series: 3, labels: ["service", "le"] }];
  const ms = compare(metricContract, fams, {}, [{ metric: "sw_request_duration_seconds", delta_count: 20, true_seconds: 0.25, observed_mean: 250 }]);
  assert.equal(ms.find((c) => c.invariant === "unit_witnessed")!.ok, false);
  const s = compare(metricContract, fams, {}, [{ metric: "sw_request_duration_seconds", delta_count: 20, true_seconds: 0.25, observed_mean: 0.251 }]);
  assert.equal(s.find((c) => c.invariant === "unit_witnessed")!.ok, true);
  const odd = compare(metricContract, fams, {}, [{ metric: "sw_request_duration_seconds", delta_count: 20, true_seconds: 0.25, observed_mean: 3.7 }]);
  assert.equal(odd.find((c) => c.invariant === "unit_witnessed")!.ok, null);
});

test("RouteReplay: no receipt is not a mismatch; wrong receiver is", () => {
  const c = getModule("routereplay").defaultContract;
  assert.equal(checkCase(c, { team: "payments", alerts: 1, silenced: false }, []).ok, null);
  assert.equal(checkCase(c, { team: "payments", alerts: 1, silenced: false }, [{ receiver: "default", alerts_in_notification: 1 }]).ok, false);
  assert.equal(checkCase(c, { team: "search", alerts: 2, silenced: false }, [{ receiver: "search-oncall", alerts_in_notification: 1 }, { receiver: "search-oncall", alerts_in_notification: 1 }]).ok, false);
  assert.equal(checkCase(c, { team: "search", alerts: 1, silenced: true }, []).ok, true);
});

test("SeriesWatch: classifies only supported cases; stale inventory is inconclusive", () => {
  const c = { inventory_max_age_minutes: 60, freshness_seconds: 30, require_approved_retirement: true };
  const now = Date.parse("2026-10-18T03:00:00Z");
  const inv = { snapshot_at: "2026-10-18T02:59:00Z", services: [{ name: "billing" }, { name: "search" }] };
  const absent = { fresh: false, target_health: "down", last_error: "HTTP 500" };
  assert.equal(classify(c, "billing", inv, [], { series: absent, health: { ok: false, status: 503 } }, now).class, "endpoint_down");
  assert.equal(classify(c, "search", inv, [], { series: absent, health: { ok: true, status: 200 } }, now).class, "telemetry_failure");
  assert.equal(classify(c, "legacy", inv, [{ id: "R1", service: "legacy", status: "approved", effective_at: "x" }], { series: absent }, now).class, "intentional_retirement");
  assert.equal(classify(c, "legacy", { ...inv, services: [...inv.services, { name: "legacy" }] }, [{ id: "R1", service: "legacy", status: "proposed", effective_at: "x" }],
    { series: absent, health: { ok: false, status: 503 } }, now).class, "endpoint_down", "a proposed retirement is not an approved one");
  assert.equal(classify(c, "billing", { ...inv, snapshot_at: "2026-10-15T00:00:00Z" }, [], { series: absent, health: { ok: false, status: 503 } }, now).class, "inconclusive");
  assert.equal(classify(c, "billing", inv, [], { series: absent }, now).class, "inconclusive", "absence alone never establishes a cause");
});

test("DashboardReplay: rejects unsupported features and detects a scope regression", () => {
  const rev = { title: "x", variables: [{ name: "env", type: "custom", value: "production" }], panels: [{ title: "p", type: "piechart", expr: 'sum(x{env="$env",r="$region"})', transformations: [{ id: "calculateField" }] }] };
  const problems = unsupportedFeatures(rev);
  assert.equal(problems.length, 3);
  assert.equal(bind('sum(x{env="$env"})', rev.variables), 'sum(x{env="production"})');
  const ref = [{ labels: {}, points: [[1, 8], [2, 8]] as [number, number][] }];
  const leaked = [{ labels: {}, points: [[1, 11], [2, 11]] as [number, number][] }];
  const c = getModule("dashboardreplay").defaultContract;
  assert.equal(assess(c, { title: "p", type: "timeseries", unit: "ops", expr: "" }, leaked, ref).find((x) => x.invariant === "scope_matches_reference")!.ok, false);
  assert.equal(assess(c, { title: "p", type: "timeseries", unit: "ops", expr: "" }, ref, ref).every((x) => x.ok), true);
});

test("FilterProof: corpus is deterministic, configs are templated, and outcomes are scored per fixture", () => {
  const a = corpusV1(), b = corpusV1();
  assert.deepEqual(a.map((f) => f.input_sha256), b.map((f) => f.input_sha256));
  assert.ok(a.length >= 20 && a.length <= 50);
  for (const f of a) for (const s of f.spans) if (s.where === "line") assert.equal(f.line.slice(s.start, s.end), s.value);
  assert.match(renderConfig({ case: "sampling", rate: 0.5 }, false), /rate\s+= 0\.5/);
  assert.doesNotMatch(renderConfig({ case: "control" }, false), /rate/);
  const secret = a.find((f) => f.kind === "custom_secret")!;
  const masked = judge(secret, { id: secret.id, trial: "1", line: secret.line.replace(secret.spans[0].value, "<REDACTED:sw-synthetic-token>"), labels: secret.labels, timedOutLabel: false }, "1");
  assert.equal(masked.secret, "masked");
  assert.equal(judge(secret, undefined, "1").delivered, false, "a missing entry is never counted as protected");
  const echo = `ts=x level=info msg="received log entry" component_path=/ component_id=loki.echo.capture labels="{fixture_id=\\"FP-001\\", sw_run=\\"abc-1\\", trial=\\"1\\"}" entry="fid=FP-001 token=<REDACTED:sw-synthetic-token> ok" entry_timestamp=x`;
  const cap = parseEcho(echo, "abc-1");
  assert.equal(cap.length, 1);
  assert.equal(cap[0].id, "FP-001");
});

test("Agent schemas reject malformed actions and out-of-range experiment specs", () => {
  assert.equal(AgentAction.safeParse({ tool: "x", args: "rm -rf /", decision_summary: "" }).success, false);
  const tool = getModule("alertscenario").tools.find((t) => t.name === "alertscenario.run_scenario")!;
  assert.equal(tool.args.safeParse({ kind: "delete_everything" }).success, false);
  assert.equal(tool.args.safeParse({ kind: "spike", seconds: 9999 }).success, false);
  assert.equal(ExperimentSpec.safeParse({ version: 1, project_id: "00000000-0000-4000-8000-000000000000", module: "alertscenario", contract_hash: "x", fixture_version: "y", seed: 1, supported_parameters: {},
    limits: { max_steps: 500, deadline_seconds: 60, max_model_tokens: 1 } }).success, false);
});
