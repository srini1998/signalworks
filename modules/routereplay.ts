// RouteReplay: do real alerts reach the intended receiver, grouped and silenced as declared?
// Provisions webhook contact points pointing at the local sink and a notification-policy
// variant, fires labeled alert rules, and reads actual receipts. A missing receipt before the
// deadline is recorded as "no receipt", which is not the same as a proven routing mismatch.
import { z } from "zod";
import type { EvalResult, ModuleDef, RunContext } from "./types.ts";
import { deleteFolder, ensureFolder, upsertRule } from "./grafana.ts";
import { grafana, sink, sleep } from "../worker/targets.ts";
import type { Finding } from "../agent/schemas.ts";

const NO_PROV = { "X-Disable-Provenance": "true" };
const TEAMS = ["payments", "search"] as const;

export const RouteContract = z.object({
  routes: z.array(z.object({ team: z.string(), receiver: z.string() })),
  default_receiver: z.literal("default"),
  group_by: z.array(z.string()),
  group_wait_seconds: z.number().int().min(1).max(30),
  delivery_deadline_seconds: z.number().int().min(20).max(120).describe("how long to wait for a receipt"),
});
type Contract = z.infer<typeof RouteContract>;

const RECEIVERS = ["default", "payments-oncall", "search-oncall"];
const cpUid = (r: string) => `sw-cp-${r}`;

async function ensureContactPoints() {
  const existing = await grafana.req<any[]>("GET", "/api/v1/provisioning/contact-points");
  for (const r of RECEIVERS) {
    if (existing.some((c) => c.uid === cpUid(r))) continue;
    await grafana.req("POST", "/api/v1/provisioning/contact-points",
      { uid: cpUid(r), name: `sw-${r}`, type: "webhook", settings: { url: `http://sink:9300/hook/${r}`, httpMethod: "POST" }, disableResolveMessage: true }, NO_PROV);
  }
}

async function applyPolicy(ctx: RunContext) {
  if (ctx.memory.policyApplied) return;
  const p = ctx.fixture.manifest.policy;
  ctx.memory.previousPolicy = await grafana.req<any>("GET", "/api/v1/provisioning/policies");
  await ensureContactPoints();
  await grafana.req("PUT", "/api/v1/provisioning/policies", {
    receiver: "sw-default",
    group_by: p.group_by,
    group_wait: `${p.group_wait_seconds}s`,
    group_interval: "10s",
    repeat_interval: "4h",
    routes: p.routes.map((r: any) => ({
      receiver: `sw-${r.receiver}`,
      object_matchers: [["team", "=", r.team_match]],
      group_by: p.group_by,
      group_wait: `${p.group_wait_seconds}s`,
      group_interval: "10s",
      repeat_interval: "4h",
    })),
  }, NO_PROV);
  // Grafana's internal Alertmanager picks up a saved policy asynchronously, and the worker's
  // least-privilege account can't read Alertmanager status to confirm it. Observed on 13.2.4: an
  // alert fired immediately after a policy change could still use the previous tree, so wait.
  await sleep(15_000);
  ctx.memory.policyApplied = true;
}

const CaseArgs = z.object({
  team: z.enum(["payments", "search", "unrouted"]),
  alerts: z.number().int().min(1).max(3).describe("distinct alert rules fired together for this team"),
  silenced: z.boolean().describe("create a silence matching this case before firing"),
});
type CaseArgs = z.infer<typeof CaseArgs>;

async function runCase(ctx: RunContext, args: CaseArgs) {
  const c = ctx.contract as Contract;
  await applyPolicy(ctx);
  const n = (ctx.memory.results?.length ?? 0) + 1;
  const caseId = `${ctx.shortId}-${n}`;
  const folder = `sw-${ctx.shortId}`;
  await ensureFolder(folder, `Signalworks run ${ctx.shortId}`);
  const after = (await sink.receipts(1e12)).last_seq;
  let silenceId: string | null = null;
  if (args.silenced) {
    const now = Date.now();
    const s = await grafana.req<any>("POST", "/api/alertmanager/grafana/api/v2/silences", {
      matchers: [{ name: "sw_case", value: caseId, isRegex: false, isEqual: true }],
      startsAt: new Date(now - 1000).toISOString(), endsAt: new Date(now + 15 * 60_000).toISOString(),
      createdBy: "signalworks", comment: `RouteReplay case ${caseId}`,
    });
    silenceId = s.silenceID;
  }
  const team = args.team === "unrouted" ? "unrouted" : args.team;
  for (let i = 1; i <= args.alerts; i++) {
    await upsertRule({
      uid: `sw-${ctx.shortId}-rr${n}-${i}`, title: `RouteReplay ${caseId} alert ${i}`, folderUid: folder, group: `rr-${caseId}`,
      expr: "vector(1)", threshold: 0, forSeconds: 0, noDataState: "NoData", intervalSeconds: 10,
      labels: { team, sw_case: caseId, sw_alert: String(i) },
    });
  }
  const t0 = Date.now();
  const deadline = t0 + c.delivery_deadline_seconds * 1000;
  let receipts: any[] = [];
  const expectCount = args.silenced ? 0 : 1;
  while (Date.now() < deadline) {
    await ctx.checkpoint();
    const r = await sink.receipts(after);
    receipts = r.receipts.filter((x) => (x.payload?.alerts ?? []).some((a: any) => a.labels?.sw_case === caseId));
    // After the first receipt, keep watching one more group interval to catch extra notifications.
    if (receipts.length >= expectCount && expectCount > 0 && Date.now() - Date.parse(receipts[0].received_at) > 12_000) break;
    await sleep(2000);
  }
  // Stop the case: delete its rules so nothing keeps firing into later cases.
  for (let i = 1; i <= args.alerts; i++) await grafana.req("DELETE", `/api/v1/provisioning/alert-rules/sw-${ctx.shortId}-rr${n}-${i}`, undefined, NO_PROV).catch(() => {});
  if (silenceId) await grafana.req("DELETE", `/api/alertmanager/grafana/api/v2/silence/${silenceId}`).catch(() => {});

  const deliveries = receipts.map((r) => ({
    receiver: r.receiver, received_at: r.received_at, seconds_after_rule_created: Math.round((Date.parse(r.received_at) - t0) / 100) / 10,
    alerts_in_notification: (r.payload.alerts ?? []).filter((a: any) => a.labels?.sw_case === caseId).length,
    status: r.payload.status, group_labels: r.payload.groupLabels,
  }));
  return { case_id: caseId, args, silence_id: silenceId, deadline_seconds: c.delivery_deadline_seconds, deliveries, check: checkCase(c, args, deliveries) };
}

export function checkCase(c: Contract, args: CaseArgs, deliveries: { receiver: string; alerts_in_notification: number }[]) {
  const expectedReceiver = c.routes.find((r) => r.team === args.team)?.receiver ?? c.default_receiver;
  if (args.silenced) {
    return { invariant: "silence_suppresses_delivery", ok: deliveries.length === 0, expected: "no notification while the silence is active",
      observed: deliveries.length ? `${deliveries.length} notification(s) to ${[...new Set(deliveries.map((d) => d.receiver))].join(", ")}` : "no notification before the deadline" };
  }
  if (!deliveries.length)
    return { invariant: "routed_to_intended_receiver", ok: null, expected: `delivered to ${expectedReceiver}`, observed: "no receipt before the deadline (not proof of a routing mismatch)" };
  const receivers = [...new Set(deliveries.map((d) => d.receiver))];
  if (receivers.some((r) => r !== expectedReceiver))
    return { invariant: "routed_to_intended_receiver", ok: false, expected: `delivered only to ${expectedReceiver}`, observed: `delivered to ${receivers.join(", ")}` };
  if (args.alerts > 1 && c.group_by.length === 1 && c.group_by[0] === "team") {
    const firstBatch = deliveries[0].alerts_in_notification;
    return { invariant: "grouped_by_team", ok: firstBatch === args.alerts,
      expected: `${args.alerts} alerts for one team arrive together in one notification (group_by team, group_wait ${c.group_wait_seconds}s)`,
      observed: `first notification carried ${firstBatch} of ${args.alerts} alerts; ${deliveries.length} notification(s) total` };
  }
  return { invariant: "routed_to_intended_receiver", ok: true, expected: `delivered to ${expectedReceiver}`, observed: `delivered to ${receivers.join(", ")}` };
}

const routereplay: ModuleDef = {
  id: "routereplay",
  title: "RouteReplay",
  tagline: "When this alert fires, does the right team actually get it?",
  plain: {
    job: "Notification policies decide who gets woken up. A one-letter typo in a label matcher, or a grouping change, can send the payments team's pages to a catch-all channel nobody watches — and a preview screen won't tell you the message actually arrived.",
    example: "A policy edit changes the matcher from team=payments to team=payment. Every payments alert now lands in the default inbox. RouteReplay fires a real payments alert and shows which webhook actually received it.",
    howItWorks: [
      "Provision the candidate notification policy and webhook contact points in the local Grafana.",
      "Create real alert rules with fixture labels (team, case id) that fire immediately.",
      "Wait for receipts at the local webhook sink, up to a declared deadline.",
      "Check receiver, grouping and silence behavior. No receipt is reported separately from a wrong receipt.",
    ],
    notThis: "No email or Slack is ever sent; Grafana's routing preview is not treated as proof of delivery.",
  },
  contractSchema: RouteContract,
  defaultContract: {
    routes: [{ team: "payments", receiver: "payments-oncall" }, { team: "search", receiver: "search-oncall" }],
    default_receiver: "default", group_by: ["team"], group_wait_seconds: 5, delivery_deadline_seconds: 60,
  },
  fixtures: [
    { name: "notification-policy", version: "v1-reviewed", title: "Reviewed policy", fault: null,
      manifest: { description: "The policy the contract was written for.", policy: { group_by: ["team"], group_wait_seconds: 5, routes: [{ team_match: "payments", receiver: "payments-oncall" }, { team_match: "search", receiver: "search-oncall" }] } } },
    { name: "notification-policy", version: "v2-candidate", title: "Candidate: matcher cleanup", fault: { invariant: "routed_to_intended_receiver", note: "payments matcher typo 'payment'" },
      manifest: { description: "Tidied label matchers.", policy: { group_by: ["team"], group_wait_seconds: 5, routes: [{ team_match: "payment", receiver: "payments-oncall" }, { team_match: "search", receiver: "search-oncall" }] } } },
    { name: "notification-policy", version: "v3-candidate", title: "Candidate: per-alert grouping", fault: { invariant: "grouped_by_team", note: "group_by alertname splits a team's simultaneous alerts" },
      manifest: { description: "Group by alert name for clearer pages.", policy: { group_by: ["alertname"], group_wait_seconds: 5, routes: [{ team_match: "payments", receiver: "payments-oncall" }, { team_match: "search", receiver: "search-oncall" }] } } },
  ],
  tools: [
    {
      name: "routereplay.fire_case",
      description: "Fire `alerts` real alert rules labeled team=<team> (or an unrouted team), optionally behind a silence, and record which webhook receivers got notifications before the deadline.",
      args: CaseArgs, mutating: true, timeoutMs: 300_000,
      async run(ctx, args) {
        let r = await runCase(ctx, args);
        const attempts = [r];
        // A wrong receiver counts as a proven mismatch only if an identical case reproduces it.
        if (r.check.ok === false) {
          await sleep(10_000);
          r = await runCase(ctx, args);
          attempts.push(r);
          if (r.check.ok !== false) r = { ...r, check: { ...r.check, ok: null, observed: `not reproduced: first attempt ${attempts[0].check.observed}; repeat ${r.check.observed}` } };
        }
        const id = await ctx.artifact("receipts", `${args.team} ×${args.alerts}${args.silenced ? " silenced" : ""}`, { ...r, attempts });
        return { observations: { case_id: r.case_id, deliveries: r.deliveries, check: r.check, attempts: attempts.length }, evidence: [id] };
      },
    },
    {
      name: "routereplay.inspect_policy", description: "Read the candidate policy's routes and grouping (public manifest).", args: z.object({}), mutating: false, timeoutMs: 5000,
      async run(ctx) {
        return { observations: { policy: ctx.fixture.manifest.policy, contract: ctx.contract }, evidence: [] };
      },
    },
  ],
  baselinePlan: () => [
    { tool: "routereplay.fire_case", args: { team: "payments", alerts: 1, silenced: false } },
    { tool: "routereplay.fire_case", args: { team: "search", alerts: 2, silenced: false } },
    { tool: "routereplay.fire_case", args: { team: "unrouted", alerts: 1, silenced: false } },
    { tool: "routereplay.fire_case", args: { team: "search", alerts: 1, silenced: true } },
  ],
  budget: 4,
  agentView(ctx) {
    return {
      contract: ctx.contract,
      candidate_policy: ctx.fixture.manifest.policy,
      cases_run: (ctx.memory.results ?? []).filter((r: any) => r.tool === "routereplay.fire_case").map((r: any) => ({ args: r.args, check: r.observations.check })),
    };
  },
  evaluate(ctx): EvalResult {
    const cases = (ctx.memory.results ?? []).filter((r: any) => r.tool === "routereplay.fire_case");
    const findings: Finding[] = cases.filter((r: any) => r.observations.check.ok === false).map((r: any) => ({
      invariant_id: r.observations.check.invariant, expected: r.observations.check.expected, observed: r.observations.check.observed,
      evidence_refs: r.evidence ?? [], severity: "high", provenance: "observed",
      reproduction_ref: `routereplay.fire_case ${JSON.stringify(r.args)} with ${ctx.fixture.name}@${ctx.fixture.version}`,
    }));
    const noReceipt = cases.filter((r: any) => r.observations.check.ok === null);
    const covered = new Set(cases.filter((r: any) => r.observations.check.ok !== null).map((r: any) => r.observations.check.invariant));
    const required = ["routed_to_intended_receiver", "grouped_by_team", "silence_suppresses_delivery"];
    const missing = required.filter((i) => !covered.has(i));
    const result = findings.length ? "fail" : missing.length || noReceipt.length ? "inconclusive" : "pass";
    const reasons = findings.length ? findings.map((f) => `${f.invariant_id}: ${f.observed}`)
      : [...noReceipt.map((r: any) => `${r.args.team}: no receipt before the deadline`), ...(missing.length ? [`not exercised: ${missing.join(", ")}`] : []), ...(result === "pass" ? ["routing, grouping and silence held for every case"] : [])];
    return {
      verdict: { result, scope: `${ctx.fixture.name}@${ctx.fixture.version} on Grafana 13.2.4 Alertmanager, ${cases.length} case(s)`, reasons,
        evidence_refs: cases.flatMap((r: any) => r.evidence ?? []), limitations: ["Local webhook receipts only; repeat_interval behavior beyond a few minutes is not exercised."] },
      findings,
      summary: { cases: cases.map((r: any) => ({ args: r.args, deliveries: r.observations.deliveries, check: r.observations.check })) },
    };
  },
  async cleanup(ctx) {
    await deleteFolder(`sw-${ctx.shortId}`);
    if (ctx.memory?.previousPolicy) await grafana.req("PUT", "/api/v1/provisioning/policies", ctx.memory.previousPolicy, NO_PROV).catch(() => {});
  },
};
export default routereplay;
void TEAMS;
