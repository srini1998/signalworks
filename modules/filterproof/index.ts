// FilterProof: how does a specific Alloy loki.secretfilter pipeline behave on a versioned
// synthetic corpus, for an explicit redaction-and-preservation policy?
// Reviewed config templates only; every case snapshots its resolved config, hash, version, seed and
// limits. Entries are correlated by a harmless fixture id label; missing entries stay in the
// denominator. Three layers are kept apart: documented product scope, operator policy, observation.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { EvalResult, ModuleDef, RunContext } from "../types.ts";
import { containerLogs, containerState, removeContainer, removeRunContainers, restartContainer, runAlloy } from "../../worker/docker.ts";
import { sleep, TargetError } from "../../worker/targets.ts";
import { CORPUS_VERSION, corpusHash, corpusV1, GITLEAKS_TOML, type Fixture } from "./corpus.ts";
import type { Finding } from "../../agent/schemas.ts";

const PORTS = { push: 3590, http: 12390 };
const LOKI = "http://127.0.0.1:3100";

export const FilterContract = z.object({
  require_full_mask: z.boolean().describe("line secrets must be fully replaced; partial masking fails"),
  protect_labels: z.boolean().describe("operator policy: secrets in labels must also be protected"),
  preserve_benign: z.boolean().describe("benign lines must arrive unchanged"),
  require_delivery: z.boolean().describe("every sent entry must arrive; drops count as failures"),
  drain_seconds: z.number().int().min(3).max(60),
});
type Contract = z.infer<typeof FilterContract>;

const CaseArgs = z.object({
  case: z.enum(["control", "sampling", "stress", "label_scope", "restart", "invalid_config"]),
  rate: z.number().min(0.05).max(1).optional().describe("sampling rate (sampling case)"),
  trials: z.number().int().min(1).max(4).optional().describe("repeat sends (sampling case)"),
  processing_timeout_ms: z.number().int().min(1).max(500).optional().describe("stress case"),
  drop_on_timeout: z.boolean().optional().describe("stress case"),
});
type CaseArgs = z.infer<typeof CaseArgs>;

/** Reviewed template. Only these knobs vary; required redaction can't be disabled. */
export function renderConfig(a: CaseArgs, loki: boolean): string {
  const filter = [
    `  forward_to      = [loki.echo.capture.receiver${loki ? ", loki.write.store.receiver" : ""}]`,
    `  gitleaks_config = "/etc/alloy/gitleaks.toml"`,
    `  redact_with     = "<REDACTED:$SECRET_NAME>"`,
    `  label_timed_out = true`,
  ];
  if (a.case === "sampling") filter.push(`  rate            = ${a.rate ?? 0.5}`);
  if (a.case === "stress") {
    filter.push(`  processing_timeout = "${a.processing_timeout_ms ?? 5}ms"`);
    filter.push(`  drop_on_timeout    = ${a.drop_on_timeout ?? false}`);
  }
  if (a.case === "invalid_config") filter.push(`  redact_everything = true`); // not an argument: must fail validation
  return [
    `loki.source.api "intake" {`, `  http {`, `    listen_address = "0.0.0.0"`, `    listen_port    = 3500`, `  }`, `  forward_to = [loki.secretfilter.policy.receiver]`, `}`,
    `loki.secretfilter "policy" {`, ...filter, `}`,
    `loki.echo "capture" { }`,
    ...(loki ? [`loki.write "store" {`, `  endpoint {`, `    url = "http://loki:3100/loki/api/v1/push"`, `  }`, `}`] : []),
  ].join("\n") + "\n";
}

function fixturesFor(a: CaseArgs, all: Fixture[]): Fixture[] {
  if (a.case === "label_scope") return all.filter((f) => f.kind === "label_canary");
  if (a.case === "stress") return all.filter((f) => f.kind === "long_line" || f.kind === "custom_secret" || f.kind === "benign").slice(0, 16);
  return all.filter((f) => f.kind !== "long_line");
}

async function push(tag: string, fixtures: Fixture[], trial: number): Promise<{ accepted: string[]; rejected: { id: string; status: number | string }[] }> {
  const accepted: string[] = [];
  const rejected: { id: string; status: number | string }[] = [];
  let ns = BigInt(Date.now()) * 1_000_000n;
  for (const f of fixtures) {
    ns += 1000n;
    const body = { streams: [{ stream: { ...f.labels, sw_run: tag, trial: String(trial) }, values: [[ns.toString(), f.line]] }] };
    try {
      const r = await fetch(`http://127.0.0.1:${PORTS.push}/loki/api/v1/push`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      (r.status === 204 || r.ok ? accepted.push(f.id) : rejected.push({ id: f.id, status: r.status }));
    } catch (e) {
      rejected.push({ id: f.id, status: (e as Error).name });
    }
  }
  return { accepted, rejected };
}

type Captured = { id: string; trial: string; line: string; labels: Record<string, string>; timedOutLabel: boolean };

/** Parse loki.echo output ("received log entry ... labels=\"{...}\" entry=\"...\"") for one tag. */
export function parseEcho(logs: string, tag: string): Captured[] {
  const out: Captured[] = [];
  for (const raw of logs.split("\n")) {
    if (!raw.includes("component_id=loki.echo.capture") || !raw.includes(`sw_run=\\"${tag}\\"`)) continue;
    const lab = raw.match(/labels="\{((?:[^"\\]|\\.)*)\}"/);
    const ent = raw.match(/ entry="((?:[^"\\]|\\.)*)"/);
    if (!lab || !ent) continue;
    const labels: Record<string, string> = {};
    for (const m of lab[1].matchAll(/(\w+)=\\"((?:[^"\\]|\\\\.)*)\\"/g)) labels[m[1]] = m[2];
    const line = JSON.parse(`"${ent[1]}"`);
    out.push({ id: labels.fixture_id, trial: labels.trial ?? "1", line, labels, timedOutLabel: labels.secretfilter === "timed-out" });
  }
  return out;
}

async function alloyMetrics(): Promise<Record<string, number>> {
  const text = await (await fetch(`http://127.0.0.1:${PORTS.http}/metrics`, { signal: AbortSignal.timeout(5000) })).text();
  const want = ["loki_secretfilter_entries_bypassed_total", "loki_secretfilter_lines_timed_out_total", "loki_secretfilter_lines_dropped_total", "loki_secretfilter_secrets_redacted_total",
    "loki_secretfilter_processing_duration_seconds_sum", "loki_secretfilter_processing_duration_seconds_count"];
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) for (const w of want) if (line.startsWith(w + "{") || line.startsWith(w + " ")) out[w] = (out[w] ?? 0) + Number(line.trim().split(/\s+/).pop());
  for (const q of ["0.5", "0.99"]) {
    const m = text.match(new RegExp(`loki_secretfilter_processing_duration_seconds\\{[^}]*quantile="${q}"[^}]*\\} (\\S+)`));
    if (m) out[`duration_p${q === "0.5" ? "50" : "99"}_seconds`] = Number(m[1]);
  }
  return out;
}

async function lokiCount(tag: string): Promise<number | null> {
  try {
    const p = new URLSearchParams({ query: `{sw_run="${tag}"}`, limit: "5000", start: String((Date.now() - 3_600_000) * 1e6), end: String(Date.now() * 1e6) });
    const r = await fetch(`${LOKI}/loki/api/v1/query_range?${p}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const d = await r.json();
    return d.data.result.reduce((n: number, s: any) => n + s.values.length, 0);
  } catch {
    return null;
  }
}

export type FixtureOutcome = { id: string; kind: string; rule_scope: string; trial: string; delivered: boolean; secret: "masked" | "partial" | "unredacted" | "n/a"; benign: "preserved" | "altered" | "n/a"; json: "ok" | "broken" | "n/a"; label: "protected" | "unprotected" | "n/a"; timed_out: boolean };

export function judge(f: Fixture, got: Captured | undefined, trial: string): FixtureOutcome {
  const base: FixtureOutcome = { id: f.id, kind: f.kind, rule_scope: f.rule_scope, trial, delivered: !!got, secret: "n/a", benign: "n/a", json: "n/a", label: "n/a", timed_out: !!got?.timedOutLabel };
  if (!got) return base;
  for (const s of f.spans) {
    if (s.where === "line") {
      const prefix = s.value.slice(0, s.value.indexOf("_") + 1 || 4);
      const core = s.value.slice(prefix.length);
      base.secret = got.line.includes(s.value) ? "unredacted" : got.line.includes(core.slice(0, 6)) ? "partial" : "masked";
    } else {
      const key = s.where.slice("label:".length);
      base.label = got.labels[key] === s.value ? "unprotected" : "protected";
    }
  }
  if (f.kind === "benign") base.benign = got.line === f.line ? "preserved" : "altered";
  if (f.json_fields) {
    try {
      const a = JSON.parse(f.line.slice(f.line.indexOf("{")));
      const b = JSON.parse(got.line.slice(got.line.indexOf("{")));
      base.json = f.json_fields.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k])) ? "ok" : "broken";
    } catch {
      base.json = "broken";
    }
  }
  return base;
}

async function runCase(ctx: RunContext, a: CaseArgs) {
  const all = corpusV1();
  const fixtures = fixturesFor(a, all);
  const n = (ctx.memory.results?.length ?? 0) + 1;
  const name = `sw-fp-${ctx.shortId}-${n}`;
  const tag = `${ctx.shortId}-${n}`;
  const loki = (await fetch(`${LOKI}/ready`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false));
  const config = renderConfig(a, loki);
  const configHash = createHash("sha256").update(config + GITLEAKS_TOML).digest("hex");
  const snapshot = { alloy_image: "grafana/alloy:v1.20.1", config, config_sha256: configHash, gitleaks_sha256: createHash("sha256").update(GITLEAKS_TOML).digest("hex"),
    corpus: CORPUS_VERSION, corpus_sha256: corpusHash(all), seed: ctx.seed, limits: { cpus: 0.5, memory: "256m", drain_seconds: (ctx.contract as Contract).drain_seconds }, loki_sink: loki ? "loki 3.7.8" : "unavailable" };
  try {
    await runAlloy(name, { "config.alloy": config, "gitleaks.toml": GITLEAKS_TOML }, PORTS);
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) {
      ready = await fetch(`http://127.0.0.1:${PORTS.http}/-/ready`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
      if (!ready) {
        const st = await containerState(name);
        if (!st.running && st.exitCode !== null) break;
        await sleep(1000);
      }
    }
    if (!ready) {
      const logs = (await containerLogs(name).catch(() => "")).split("\n").filter((l) => /level=error|Error:|error/.test(l)).slice(-6).join("\n");
      return { snapshot, infrastructure: `Alloy did not become ready (config rejected or failed to start): ${logs.slice(0, 900)}`, outcomes: [], sent: 0 };
    }
    const trials = a.case === "sampling" ? a.trials ?? 2 : 1;
    const sendLog: any[] = [];
    const t0 = performance.now();
    for (let t = 1; t <= trials; t++) {
      if (a.case === "restart") {
        const half = Math.ceil(fixtures.length / 2);
        sendLog.push({ trial: t, phase: "before-restart", ...(await push(tag, fixtures.slice(0, half), t)) });
        await restartContainer(name);
        for (let i = 0; i < 20; i++) if (await fetch(`http://127.0.0.1:${PORTS.http}/-/ready`).then((r) => r.ok).catch(() => false)) break; else await sleep(1000);
        sendLog.push({ trial: t, phase: "after-restart", ...(await push(tag, fixtures.slice(half), t)) });
      } else {
        sendLog.push({ trial: t, ...(await push(tag, fixtures, t)) });
      }
    }
    const sendMs = performance.now() - t0;
    await sleep((ctx.contract as Contract).drain_seconds * 1000);
    const captured = parseEcho(await containerLogs(name), tag);
    const metrics = await alloyMetrics().catch(() => ({}));
    const stored = loki ? await lokiCount(tag) : null;
    const outcomes: FixtureOutcome[] = [];
    for (let t = 1; t <= trials; t++) for (const f of fixtures) outcomes.push(judge(f, captured.find((c) => c.id === f.id && c.trial === String(t)), String(t)));
    const sent = sendLog.reduce((s, l) => s + l.accepted.length + l.rejected.length, 0);
    const accepted = sendLog.reduce((s, l) => s + l.accepted.length, 0);
    return {
      snapshot, infrastructure: null as string | null, sent, accepted, captured: captured.length, stored_in_loki: stored, send_ms: Math.round(sendMs),
      throughput_entries_per_s: Math.round((accepted / (sendMs / 1000)) * 10) / 10, metrics, send_log: sendLog.map((l) => ({ ...l, accepted: l.accepted.length })), outcomes,
    };
  } finally {
    await removeContainer(name);
  }
}

export function summarize(r: any) {
  const o: FixtureOutcome[] = r.outcomes ?? [];
  const secrets = o.filter((x) => x.secret !== "n/a" || (x.kind !== "benign" && x.kind !== "label_canary" && x.rule_scope !== "none"));
  return {
    entries: o.length,
    delivered: o.filter((x) => x.delivered).length,
    missing: o.filter((x) => !x.delivered).map((x) => `${x.id}#${x.trial}`),
    line_secrets: { total: secrets.length, masked: o.filter((x) => x.secret === "masked").length, partial: o.filter((x) => x.secret === "partial").length, unredacted: o.filter((x) => x.secret === "unredacted").map((x) => `${x.id}#${x.trial}`) },
    benign_altered: o.filter((x) => x.benign === "altered").map((x) => x.id),
    json_broken: o.filter((x) => x.json === "broken").map((x) => x.id),
    labels_unprotected: o.filter((x) => x.label === "unprotected").map((x) => x.id),
    timed_out_labelled: o.filter((x) => x.timed_out).length,
  };
}

const filterproof: ModuleDef = {
  id: "filterproof",
  title: "FilterProof",
  tagline: "Does your log pipeline really hide secrets — without eating your logs?",
  plain: {
    job: "Teams add Grafana Alloy's secret filter so API keys don't end up in Loki. But sampling, timeouts on long lines, secrets in labels, and restarts each change what actually gets through — and a line that disappears is not 'protected', it's lost.",
    example: "With sampling at 50%, roughly half of the synthetic tokens arrive unredacted — the filter is working exactly as configured, but the policy 'no tokens in logs' is violated. A token placed in a label survives because the filter only scans lines (documented), so the operator policy needs another control.",
    howItWorks: [
      "Pick a reviewed pipeline case: full scan control, sampling, long-line stress with timeouts, label scope, restart, or an invalid config.",
      "Start a pinned Alloy container, send the versioned synthetic corpus with a harmless fixture id on every entry.",
      "Capture what the filter forwarded (and what Loki stored), plus Alloy's own bypass/timeout/drop counters.",
      "Score every fixture: fully masked, partially masked, unredacted, benign preserved, JSON intact, delivered or missing.",
    ],
    notThis: "Not a secret scanner and not proof of universal protection: verdicts hold for this corpus, policy, version and config hash only. All values are synthetic and nonfunctional.",
  },
  contractSchema: FilterContract,
  defaultContract: { require_full_mask: true, protect_labels: true, preserve_benign: true, require_delivery: true, drain_seconds: 4 },
  fixtures: [
    { name: "alloy-secretfilter", version: "1.20.1-corpus-v1", title: "Alloy 1.20.1 secretfilter · synthetic corpus v1", fault: { note: "label canaries are a documented scope boundary; sampling below 1 bypasses entries by design" },
      manifest: { description: `Pinned Alloy v1.20.1, Gitleaks default rules extended with one custom rule, ${corpusV1().length} synthetic fixtures.`, corpus: CORPUS_VERSION, cases: CaseArgs.shape.case.options } },
  ],
  tools: [
    {
      name: "filterproof.run_case", description: "Run one reviewed pipeline case against a fresh pinned Alloy container and score every fixture. Cases: control (rate 1), sampling (rate, trials), stress (processing_timeout_ms, drop_on_timeout; long lines), label_scope (secrets in labels), restart (restart mid-send), invalid_config.",
      args: CaseArgs, mutating: true, timeoutMs: 180_000,
      async run(ctx, args) {
        const r = await runCase(ctx, args);
        const summary = r.infrastructure ? null : summarize(r);
        const id = await ctx.artifact("case", `${args.case}${args.rate ? ` rate ${args.rate}` : ""}${args.processing_timeout_ms ? ` timeout ${args.processing_timeout_ms}ms${args.drop_on_timeout ? " drop" : ""}` : ""}`, { args, ...r, summary });
        return { observations: { args, infrastructure: r.infrastructure, summary, metrics: (r as any).metrics ?? null, stored_in_loki: (r as any).stored_in_loki ?? null, config_sha256: r.snapshot.config_sha256 }, evidence: [id] };
      },
    },
    {
      name: "filterproof.inspect_policy", description: "Read the operator policy and the documented scope of the component (public).", args: z.object({}), mutating: false, timeoutMs: 3000,
      async run(ctx) {
        return { observations: { policy: ctx.contract, product_scope: "loki.secretfilter scans log lines only, not labels or metadata (Alloy 1.20.1 docs). rate < 1 forwards unsampled entries unchanged. processing_timeout forwards (or drops, if drop_on_timeout) slow entries." }, evidence: [] };
      },
    },
    {
      name: "filterproof.minimize", description: "Shrink a fixture that leaked in an earlier control case to the smallest line that still leaks under the same config, keeping the secret itself intact. Runs one Alloy container.",
      args: z.object({ fixture_id: z.string().regex(/^FP-\d{3}$/) }), mutating: true, timeoutMs: 180_000,
      async run(ctx, args) {
        const f = corpusV1().find((x) => x.id === args.fixture_id);
        if (!f || !f.spans.length || f.spans[0].where !== "line") return { observations: { error: "fixture has no line secret to minimize" }, evidence: [] };
        const s = f.spans[0];
        const parts = f.line.slice(0, s.start).split(" ").filter(Boolean);
        const tail = f.line.slice(s.end).split(" ").filter(Boolean);
        // Candidates keep the secret verbatim and drop surrounding context in decreasing chunks.
        const candidates: string[] = [];
        for (let k = 0; k <= parts.length; k++) for (let j = 0; j <= tail.length; j++) candidates.push([...parts.slice(k), s.value, ...tail.slice(0, tail.length - j)].join(" "));
        const uniq = [...new Set(candidates)].slice(0, 60);
        const name = `sw-fp-${ctx.shortId}-min${(ctx.memory.results?.length ?? 0) + 1}`;
        const tag = `${ctx.shortId}-min-${args.fixture_id}`;
        try {
          await runAlloy(name, { "config.alloy": renderConfig({ case: "control" }, false), "gitleaks.toml": GITLEAKS_TOML }, PORTS);
          for (let i = 0; i < 30; i++) if (await fetch(`http://127.0.0.1:${PORTS.http}/-/ready`).then((r) => r.ok).catch(() => false)) break; else await sleep(1000);
          const fx = uniq.map((line, i) => ({ ...f, id: `M${String(i).padStart(3, "0")}`, line, labels: { fixture_id: `M${String(i).padStart(3, "0")}` } }));
          await push(tag, fx as Fixture[], 1);
          await sleep(3000);
          const cap = parseEcho(await containerLogs(name), tag);
          const leaking = fx.filter((x) => cap.find((c) => c.id === x.id)?.line.includes(s.value)).map((x) => x.line);
          const smallest = leaking.sort((a, b) => a.length - b.length)[0] ?? null;
          const obs = { fixture_id: f.id, original_length: f.line.length, candidates: uniq.length, leaking_candidates: leaking.length, minimized: smallest, still_contains_secret: smallest?.includes(s.value) ?? false,
            note: smallest ? "secret value kept verbatim; only surrounding context removed" : "no candidate leaked under the control config" };
          const id = await ctx.artifact("minimized", `${f.id} minimized`, { original: f.line, ...obs });
          return { observations: obs, evidence: [id] };
        } finally {
          await removeContainer(name);
        }
      },
    },
  ],
  baselinePlan: () => [
    { tool: "filterproof.run_case", args: { case: "control" } },
    { tool: "filterproof.run_case", args: { case: "sampling", rate: 0.5, trials: 2 } },
    { tool: "filterproof.run_case", args: { case: "stress", processing_timeout_ms: 5, drop_on_timeout: true } },
    { tool: "filterproof.run_case", args: { case: "label_scope" } },
    { tool: "filterproof.run_case", args: { case: "restart" } },
  ],
  budget: 6,
  agentView(ctx) {
    return {
      policy: ctx.contract,
      product_scope: "line-only scanning; rate<1 bypasses entries; timeouts forward or drop",
      corpus: { version: CORPUS_VERSION, fixtures: corpusV1().map((f) => ({ id: f.id, kind: f.kind, placement: f.placement })) },
      cases_run: (ctx.memory.results ?? []).filter((r: any) => r.tool === "filterproof.run_case").map((r: any) => ({ args: r.args, infrastructure: r.observations.infrastructure, summary: r.observations.summary })),
      minimized: (ctx.memory.results ?? []).filter((r: any) => r.tool === "filterproof.minimize").map((r: any) => r.observations),
    };
  },
  evaluate(ctx): EvalResult {
    const c = ctx.contract as Contract;
    const cases = (ctx.memory.results ?? []).filter((r: any) => r.tool === "filterproof.run_case");
    const findings: Finding[] = [];
    const reasons: string[] = [];
    let infra = 0;
    for (const r of cases) {
      const a = r.observations.args;
      const s = r.observations.summary;
      const ref = `filterproof.run_case ${JSON.stringify(a)} config ${r.observations.config_sha256?.slice(0, 12)}`;
      if (r.observations.infrastructure) {
        infra++;
        reasons.push(`${a.case}: infrastructure/config failure, no redaction verdict (${r.observations.infrastructure.slice(0, 120)})`);
        continue;
      }
      const add = (invariant: string, expected: string, observed: string, severity: Finding["severity"], layer: string) => {
        findings.push({ invariant_id: invariant, expected, observed: `${observed} [${layer}]`, evidence_refs: r.evidence ?? [], severity, provenance: "observed", reproduction_ref: ref });
        reasons.push(`${a.case}: ${invariant} - ${observed}`);
      };
      if (s.line_secrets.unredacted.length)
        add("line_secret_redacted", "every line secret fully masked", `${s.line_secrets.unredacted.length} unredacted: ${s.line_secrets.unredacted.slice(0, 8).join(", ")}${a.case === "sampling" ? `; Alloy reports ${r.observations.metrics?.loki_secretfilter_entries_bypassed_total ?? "?"} bypassed entries` : ""}`,
          "high", a.case === "sampling" ? "documented sampling behavior; operator policy violated" : "behavioral observation; operator policy violated");
      if (c.require_full_mask && s.line_secrets.partial) add("full_mask_required", "full masking", `${s.line_secrets.partial} partially masked`, "medium", "operator policy");
      if (c.preserve_benign && s.benign_altered.length) add("benign_preserved", "benign lines unchanged", `altered: ${s.benign_altered.join(", ")}`, "medium", "behavioral observation");
      if (s.json_broken.length) add("json_structure_preserved", "declared JSON fields intact", `broken: ${s.json_broken.join(", ")}`, "medium", "behavioral observation");
      if (c.require_delivery && s.missing.length)
        add("entries_delivered", "every sent entry arrives (missing entries are not counted as protected)", `${s.missing.length} missing of ${s.entries}${r.observations.metrics?.loki_secretfilter_lines_dropped_total ? `; Alloy dropped ${r.observations.metrics.loki_secretfilter_lines_dropped_total} on timeout` : ""}`,
          "high", a.case === "restart" ? "delivery across restart" : "operator policy");
      if (s.labels_unprotected.length)
        add("label_secret_protected", c.protect_labels ? "secrets in labels protected by the pipeline" : "informational", `${s.labels_unprotected.length} label canaries survived: line-only scanning is the documented scope of loki.secretfilter, so this is a pipeline-policy gap, not a component malfunction`,
          c.protect_labels ? "medium" : "info", "documented product scope vs operator policy");
    }
    const result = !cases.length ? "inconclusive" : findings.some((f) => f.severity !== "info") ? "fail" : infra === cases.length ? "inconclusive" : "pass";
    if (result === "pass") reasons.push("every executed case met the policy for this corpus, version and config");
    return {
      verdict: { result, scope: `Alloy 1.20.1, ${CORPUS_VERSION}, ${cases.length} case(s); per corpus, policy, version and config hash only`, reasons,
        evidence_refs: cases.flatMap((r: any) => r.evidence ?? []), limitations: ["Synthetic corpus; local CPU/throughput only; not universal protection or a scanner certification."] },
      findings,
      summary: { cases: cases.map((r: any) => ({ args: r.observations.args, infrastructure: r.observations.infrastructure, summary: r.observations.summary, metrics: r.observations.metrics, stored_in_loki: r.observations.stored_in_loki })) },
    };
  },
  async cleanup(ctx) {
    await removeRunContainers(ctx.shortId);
  },
};
export default filterproof;
void TargetError;
