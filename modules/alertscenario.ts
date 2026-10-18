// AlertScenario: does a Grafana-managed alert rule move through normal -> pending -> firing ->
// recovery the way its contract says, including short spikes and missing data?
// Each scenario provisions a real rule in a run-owned folder, drives the controlled exporter,
// polls Grafana's actual instance states, and reads Grafana's own state history.
import { z } from "zod";
import type { EvalResult, ModuleDef, RunContext } from "./types.ts";
import { deleteFolder, ensureFolder, ruleState, splitState, stateHistory, upsertRule } from "./grafana.ts";
import { exporter, sleep } from "../worker/targets.ts";
import type { Finding } from "../agent/schemas.ts";

const SERVICE = "checkout";
const HIGH = 100;
const LOW = 5;

export const AlertContract = z.object({
  service: z.literal(SERVICE),
  threshold: z.number().min(1).max(1000),
  pending_seconds: z.number().int().min(0).max(120),
  eval_interval_seconds: z.literal(10),
  missing_data_policy: z.enum(["never_normal"]).describe("When all series vanish the rule must not report Normal"),
  missing_series_must_be_labeled: z.boolean(),
});
type Contract = z.infer<typeof AlertContract>;

const ScenarioArgs = z.object({
  kind: z.enum(["sustained", "spike", "all_absent", "partial_disappearance"]),
  seconds: z.number().int().min(5).max(90).optional().describe("spike length, or how long the high value is held for 'sustained'"),
});
type ScenarioArgs = z.infer<typeof ScenarioArgs>;

type Sample = { t: number; shards: Record<string, string>; other: string[] };
type ScenarioResult = {
  kind: string;
  seconds: number | null;
  phases: { name: string; start: number }[];
  samples: Sample[];
  history: { t: number; shard: string; prev: string; next: string }[];
  check: { invariant: string; ok: boolean | null; detail: string; expected: string; observed: string };
};

const rel = (t0: number) => Math.round((Date.now() - t0) / 100) / 10;

async function waitForEvaluation(uid: string, maxMs = 45_000): Promise<boolean> {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const s = await ruleState(uid);
    if (s.lastEvaluation && s.instances.length && s.instances.every((i) => i.state === "Normal")) return true;
    await sleep(2000);
  }
  return false;
}

async function observe(uid: string, t0: number, ms: number, samples: Sample[], until?: (s: Sample) => boolean): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const st = await ruleState(uid);
    const shards: Record<string, string> = {};
    const other: string[] = [];
    for (const i of st.instances) {
      if (i.labels.shard) shards[i.labels.shard] = i.state;
      else other.push(`${i.labels.datasource_uid ? "no-data instance" : "instance"}:${i.state}`);
    }
    const s = { t: rel(t0), shards, other };
    samples.push(s);
    if (until?.(s)) return true;
    await sleep(2000);
  }
  return false;
}

function firstTime(samples: Sample[], after: number, pred: (s: Sample) => boolean): number | null {
  return samples.find((s) => s.t >= after && pred(s))?.t ?? null;
}

async function runScenario(ctx: RunContext, args: ScenarioArgs): Promise<ScenarioResult> {
  const c = ctx.contract as Contract;
  const cand = ctx.fixture.manifest.rule;
  const n = (ctx.memory.results?.length ?? 0) + 1;
  const folder = `sw-${ctx.shortId}`;
  const uid = `sw-${ctx.shortId}-as${n}`;
  await ensureFolder(folder, `Signalworks run ${ctx.shortId}`);
  await exporter.reset(SERVICE);
  await exporter.setState(SERVICE, { queue: { a: LOW, b: LOW, c: LOW } });
  await upsertRule({
    uid, title: `AlertScenario ${ctx.shortId} #${n} ${args.kind}`, folderUid: folder, group: `as-${ctx.shortId}-${n}`,
    expr: `sw_queue_depth{service="${SERVICE}"}`, threshold: c.threshold, forSeconds: cand.for_seconds,
    noDataState: cand.no_data_state, intervalSeconds: c.eval_interval_seconds,
    labels: { signalworks_run: ctx.shortId, scenario: String(n) },
  });
  if (!(await waitForEvaluation(uid))) throw new Error("rule never reached an evaluated Normal baseline within 45 s");
  await ctx.checkpoint();

  const t0 = Date.now();
  const startMs = t0 - 5000;
  const samples: Sample[] = [];
  const phases: { name: string; start: number }[] = [];
  const phase = async (name: string, state: Record<string, unknown>) => {
    await exporter.setState(SERVICE, state);
    phases.push({ name, start: rel(t0) });
  };
  const firing = (shard: string) => (s: Sample) => s.shards[shard] === "Alerting";
  const evalSlack = 2 * c.eval_interval_seconds + 6; // two evaluation periods plus scrape/poll slack
  let seconds: number | null = null;

  if (args.kind === "sustained") {
    seconds = args.seconds ?? c.pending_seconds + 40;
    await phase("high", { queue: { a: LOW, b: LOW, c: HIGH } });
    await observe(uid, t0, seconds * 1000, samples);
    await phase("recovered", { queue: { a: LOW, b: LOW, c: LOW } });
    await observe(uid, t0, (evalSlack + 10) * 1000, samples, (s) => s.t > phases[1].start + 4 && s.shards.c === "Normal");
  } else if (args.kind === "spike") {
    seconds = args.seconds ?? 10;
    await phase("spike", { queue: { a: LOW, b: LOW, c: HIGH } });
    await observe(uid, t0, seconds * 1000, samples);
    await phase("after-spike", { queue: { a: LOW, b: LOW, c: LOW } });
    await observe(uid, t0, (c.pending_seconds + evalSlack) * 1000, samples);
  } else if (args.kind === "all_absent") {
    await phase("high", { queue: { a: LOW, b: LOW, c: HIGH } });
    const fired = await observe(uid, t0, (c.pending_seconds + evalSlack + 10) * 1000, samples, firing("c"));
    if (!fired) throw new Error("precondition failed: rule never fired before removing data");
    await phase("all-series-absent", { metrics: "absent" });
    await observe(uid, t0, (3 * c.eval_interval_seconds + evalSlack) * 1000, samples);
  } else {
    await phase("high", { queue: { a: LOW, b: LOW, c: HIGH } });
    const fired = await observe(uid, t0, (c.pending_seconds + evalSlack + 10) * 1000, samples, firing("c"));
    if (!fired) throw new Error("precondition failed: rule never fired before removing the shard");
    await phase("shard-c-removed", { queue: { a: LOW, b: LOW } });
    await observe(uid, t0, (3 * c.eval_interval_seconds + evalSlack) * 1000, samples);
  }
  await exporter.reset(SERVICE);

  const history = (await stateHistory(uid, startMs)).map((h) => ({
    t: Math.round((Date.parse(h.time) - t0) / 100) / 10, shard: h.labels.shard ?? (h.labels.datasource_uid ? "no-data" : "?"), prev: h.prev, next: h.next,
  }));
  const result: ScenarioResult = { kind: args.kind, seconds, phases, samples, history, check: checkScenario(c, cand, args.kind, seconds, phases, samples, history) };
  return result;
}

/** Deterministic per-scenario check against the contract. Timing expectations are ranges. */
export function checkScenario(c: Contract, cand: any, kindIn: string, seconds: number | null, phases: { name: string; start: number }[],
  samples: Sample[], history: ScenarioResult["history"]): ScenarioResult["check"] {
  const I = c.eval_interval_seconds;
  const slack = 2 * I + 6;
  let kind = kindIn;
  // Any breach shorter than the allowed burst is a burst, whatever the scenario is called.
  if (kind === "sustained" && seconds !== null && seconds + I <= c.pending_seconds) kind = "spike";
  if (kind === "sustained") {
    const tFire = firstTime(samples, 0, (s) => s.shards.c === "Alerting");
    const lo = c.pending_seconds - I;
    const hi = c.pending_seconds + slack;
    if (tFire === null) {
      const held = seconds ?? 0;
      const inconclusive = held < c.pending_seconds + slack;
      return { invariant: "sustained_breach_fires", ok: inconclusive ? null : false, expected: `Alerting between ${lo}s and ${hi}s after the breach`,
        observed: "never Alerting", detail: inconclusive ? `held only ${held}s, shorter than pending + evaluation slack` : "a sustained breach never fired" };
    }
    const tRec = phases[1] ? firstTime(samples, phases[1].start, (s) => s.shards.c === "Normal") : null;
    const reason = history.filter((h) => h.shard === "c" && /^Normal/.test(h.next)).map((h) => splitState(h.next).reason).pop() ?? "";
    const onTime = tFire >= lo && tFire <= hi;
    const recovered = tRec !== null && tRec - phases[1].start <= slack && reason === "";
    return { invariant: "sustained_breach_fires", ok: onTime && recovered, expected: `Alerting within [${lo}s, ${hi}s]; Normal (measured) within ${slack}s of recovery`,
      observed: `Alerting at ${tFire}s; Normal at ${tRec === null ? "never" : `${(tRec - phases[1].start).toFixed(1)}s after recovery`}${reason ? ` (${reason})` : ""}`,
      detail: !onTime ? "firing time outside the expected range" : !recovered ? "recovery missing, late, or not attributed to measured values" : "timeline matches" };
  }
  if (kind === "spike") {
    const fired = samples.some((s) => s.shards.c === "Alerting");
    const shorterThanPending = (seconds ?? 0) + I <= c.pending_seconds;
    if (!shorterThanPending)
      return { invariant: "short_spike_does_not_fire", ok: null, expected: `spikes shorter than ${c.pending_seconds}s minus one evaluation do not fire`,
        observed: fired ? "fired" : "did not fire", detail: `a ${seconds}s spike is too close to the pending period to be covered by the contract` };
    return { invariant: "short_spike_does_not_fire", ok: !fired, expected: "never Alerting", observed: fired ? `Alerting at ${firstTime(samples, 0, (s) => s.shards.c === "Alerting")}s` : "never Alerting",
      detail: fired ? `a ${seconds}s spike fired although the pending period is ${c.pending_seconds}s` : "spike stayed below firing" };
  }
  if (kind === "all_absent") {
    const t = phases[1].start;
    const after = samples.filter((s) => s.t >= t + I + 4);
    const last = after[after.length - 1];
    const states = last ? [...Object.values(last.shards), ...last.other.map((o) => o.split(":").slice(1).join(":"))] : [];
    // "Normal (NoData)" is still Normal: the alert resolves and notifications stop. Only a NoData or
    // Alerting instance keeps the outage visible. A vanished shard resolving as Normal (MissingSeries)
    // is fine as long as such an instance takes over.
    const base = states.map((st) => splitState(st.trim()).state);
    const visible = base.some((b) => b === "NoData" || b === "Alerting");
    const mappedToNormal = history.some((h) => h.t >= t && h.shard !== "c" && /^Normal( \(NoData\))?$/.test(h.next.trim()))
      || history.some((h) => h.t >= t && /^Normal \(NoData\)$/.test(h.next.trim()));
    const ok = visible && !mappedToNormal;
    return { invariant: "missing_data_not_reported_as_recovery", ok, expected: "after every series vanishes, the rule shows NoData or keeps alerting; it never looks recovered",
      observed: `final instance states: ${states.join(", ") || "none"}; history after removal: ${history.filter((h) => h.t >= t).map((h) => `${h.shard} ${h.prev}->${h.next}`).join("; ") || "none"}`,
      detail: ok ? "missing data stays visible as NoData/Alerting" : `with noDataState=${cand.no_data_state} the rule reports Normal when every series disappears` };
  }
  const t = phases[1].start;
  const cEvents = history.filter((h) => h.shard === "c" && h.t >= t);
  const resolvedPlain = cEvents.some((h) => /^Normal$/.test(h.next.trim()));
  const labeled = cEvents.some((h) => /MissingSeries/i.test(h.next));
  const stillTracked = samples.filter((s) => s.t >= t).some((s) => "c" in s.shards);
  const ok = c.missing_series_must_be_labeled ? !resolvedPlain && (labeled || stillTracked) : true;
  return { invariant: "vanished_series_labeled_missing", ok, expected: "the vanished shard's instance is resolved with reason MissingSeries (or still tracked), not a plain Normal",
    observed: cEvents.map((h) => `${h.prev} -> ${h.next} at +${(h.t - t).toFixed(1)}s`).join("; ") || "no state change recorded for shard c",
    detail: labeled ? "Grafana labeled the transition MissingSeries" : resolvedPlain ? "resolved as plain Normal, indistinguishable from recovery" : "no resolution observed in the window" };
}

const alertscenario: ModuleDef = {
  id: "alertscenario",
  title: "AlertScenario",
  tagline: "Does the alert fire, wait, and recover the way you promised?",
  plain: {
    job: "Alert rules have timing promises: ignore short blips, fire on real problems, and never go quiet just because data disappeared. AlertScenario runs those situations against a real Grafana rule and records what actually happened.",
    example: "Your queue alert should wait 30 seconds before paging. A 10-second burst should not page anyone; a two-minute backlog must. If the exporter dies, the dashboard must not turn green.",
    howItWorks: [
      "Pick a candidate rule configuration and a contract (threshold, pending period, missing-data policy).",
      "The worker creates a real Grafana-managed rule in a run-owned folder and drives a controlled test metric.",
      "It polls Grafana's live alert states every 2 seconds and reads Grafana's own state history.",
      "A deterministic evaluator compares the observed timeline with the contract, using time ranges rather than exact timestamps.",
    ],
    notThis: "Not a replacement for Grafana's rule testing; it adds repeatable, cross-scenario assertions and evidence you can export.",
  },
  contractSchema: AlertContract,
  defaultContract: { service: "checkout", threshold: 50, pending_seconds: 30, eval_interval_seconds: 10, missing_data_policy: "never_normal", missing_series_must_be_labeled: true },
  fixtures: [
    { name: "queue-rule", version: "v1-reviewed", title: "Reviewed rule: pending 30s, no data -> NoData",
      manifest: { rule: { for_seconds: 30, no_data_state: "NoData" }, description: "The reviewed configuration." }, fault: null },
    { name: "queue-rule", version: "v2-candidate", title: "Candidate: missing data mapped to OK",
      manifest: { rule: { for_seconds: 30, no_data_state: "OK" }, description: "A proposed change to reduce no-data noise." },
      fault: { invariant: "missing_data_not_reported_as_recovery", note: "noDataState OK turns a vanished exporter into Normal" } },
    { name: "queue-rule", version: "v3-candidate", title: "Candidate: pending period removed",
      manifest: { rule: { for_seconds: 0, no_data_state: "NoData" }, description: "A proposed change to page faster." },
      fault: { invariant: "short_spike_does_not_fire", note: "for: 0s pages on any single high evaluation" } },
    { name: "queue-rule", version: "v4-candidate", title: "Candidate: pending period shortened",
      manifest: { rule: { for_seconds: 10, no_data_state: "NoData" }, description: "A proposed tuning change." },
      fault: { invariant: "short_spike_does_not_fire", note: "for: 10s lets a ~25s burst fire although the contract allows bursts up to 20s; a 10s probe misses it" } },
  ],
  tools: [
    {
      name: "alertscenario.inspect_contract", description: "Read the contract and the candidate rule configuration under test.", args: z.object({}),
      mutating: false, timeoutMs: 5000,
      async run(ctx) {
        return { observations: { contract: ctx.contract, candidate: ctx.fixture.manifest }, evidence: [] };
      },
    },
    {
      name: "alertscenario.run_scenario",
      description: "Run one allowlisted scenario against a real Grafana rule: 'sustained' (hold a breach), 'spike' (a breach lasting `seconds`), 'all_absent' (fire, then every series disappears), 'partial_disappearance' (fire on shard c, then only shard c disappears). Returns the observed timeline and the contract check for that scenario.",
      args: ScenarioArgs, mutating: true, timeoutMs: 240_000,
      async run(ctx, args) {
        const r = await runScenario(ctx, args);
        const id = await ctx.artifact("timeline", `${r.kind}${r.seconds ? `-${r.seconds}s` : ""}`, r);
        return { observations: { kind: r.kind, seconds: r.seconds, phases: r.phases, check: r.check, history: r.history, samples: r.samples.length }, evidence: [id] };
      },
    },
    {
      name: "alertscenario.inspect_evidence", description: "Read the compact observed timeline of an earlier scenario (1-based index).",
      args: z.object({ index: z.number().int().min(1).max(10) }), mutating: false, timeoutMs: 5000,
      async run(ctx, args) {
        const r = (ctx.memory.results ?? []).filter((x: any) => x.tool === "alertscenario.run_scenario")[args.index - 1];
        if (!r) return { observations: { error: "no such scenario" }, evidence: [] };
        return { observations: { phases: r.observations.phases, history: r.observations.history, check: r.observations.check }, evidence: [] };
      },
    },
  ],
  baselinePlan: () => [
    { tool: "alertscenario.run_scenario", args: { kind: "sustained" } },
    { tool: "alertscenario.run_scenario", args: { kind: "spike", seconds: 10 } },
    { tool: "alertscenario.run_scenario", args: { kind: "all_absent" } },
    { tool: "alertscenario.run_scenario", args: { kind: "partial_disappearance" } },
  ],
  budget: 4,
  agentView(ctx) {
    return {
      contract: ctx.contract,
      candidate_rule: ctx.fixture.manifest,
      scenarios_run: (ctx.memory.results ?? []).filter((r: any) => r.tool === "alertscenario.run_scenario").map((r: any) => ({
        kind: r.observations.kind, seconds: r.observations.seconds, invariant: r.observations.check?.invariant, ok: r.observations.check?.ok, observed: r.observations.check?.observed,
      })),
      untested_invariants: ["sustained_breach_fires", "short_spike_does_not_fire", "missing_data_not_reported_as_recovery", "vanished_series_labeled_missing"]
        .filter((i) => !(ctx.memory.results ?? []).some((r: any) => r.tool === "alertscenario.run_scenario" && r.observations.check?.invariant === i && r.observations.check?.ok !== null)),
      scenario_semantics: {
        sustained: "hold a breach long enough to fire (default pending + 40 s) - tests that real problems page",
        spike: "a short breach of `seconds` - tests that blips shorter than pending minus one evaluation do not page",
        all_absent: "fire, then every series disappears - tests missing-data handling",
        partial_disappearance: "fire on shard c, then only shard c disappears - tests MissingSeries labeling",
      },
      note: "The contract allows bursts shorter than pending_seconds minus one evaluation interval without firing.",
    };
  },
  evaluate(ctx): EvalResult {
    const runs = (ctx.memory.results ?? []).filter((r: any) => r.tool === "alertscenario.run_scenario");
    const findings: Finding[] = [];
    const reasons: string[] = [];
    let fail = false;
    let undetermined = 0;
    for (const r of runs) {
      const ch = r.observations.check;
      if (ch.ok === false) {
        fail = true;
        reasons.push(`${ch.invariant}: ${ch.detail}`);
        findings.push({ invariant_id: ch.invariant, expected: ch.expected, observed: ch.observed, evidence_refs: r.evidence ?? [], severity: "high",
          provenance: "observed", reproduction_ref: `alertscenario.run_scenario ${JSON.stringify(r.args)} on ${ctx.fixture.name}@${ctx.fixture.version}` });
      } else if (ch.ok === null) undetermined++;
    }
    const covered = new Set(runs.filter((r: any) => r.observations.check.ok !== null).map((r: any) => r.observations.check.invariant));
    const required = ["sustained_breach_fires", "short_spike_does_not_fire", "missing_data_not_reported_as_recovery", "vanished_series_labeled_missing"];
    const missing = required.filter((i) => !covered.has(i));
    const result = fail ? "fail" : missing.length ? "inconclusive" : "pass";
    if (!fail && missing.length) reasons.push(`not tested: ${missing.join(", ")}`);
    if (result === "pass") reasons.push("every contract invariant was exercised and held");
    return {
      verdict: { result, scope: `${ctx.fixture.name}@${ctx.fixture.version} on Grafana 13.2.4, ${runs.length} scenario(s)`, reasons,
        evidence_refs: runs.flatMap((r: any) => r.evidence ?? []), limitations: ["Single synthetic metric; timings are local-stack observations with 10 s evaluation and 2 s scrape intervals."] },
      findings,
      summary: { scenarios: runs.map((r: any) => ({ kind: r.observations.kind, seconds: r.observations.seconds, check: r.observations.check })), undetermined, untested: missing },
    };
  },
  async cleanup(ctx) {
    await deleteFolder(`sw-${ctx.shortId}`);
    await exporter.reset(SERVICE);
  },
};
export default alertscenario;
