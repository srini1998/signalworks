// Offline scoring: compares each recorded run with the PRIVATE seeded-fault truth, which the agent
// never sees. Writes docs/evidence/planner-comparison.json and docs/evidence/runs-table.md.
import { writeFileSync } from "node:fs";
import { ownerPool } from "../server/db.ts";

const pool = ownerPool();
const runs = (await pool.query(`
  select r.id, r.module, r.mode, r.status, r.verdict, r.spec->>'fixture_version' as fixture, r.spec->>'fixture_name' as fixture_name,
         r.created_at, r.finished_at, r.summary, r.error, pf.fault
  from runs r
  left join fixture_versions fv on fv.module = r.module and fv.name = r.spec->>'fixture_name' and fv.version = r.spec->>'fixture_version'
  left join private_faults pf on pf.fixture_version_id = fv.id
  where r.mode in ('baseline', 'agent') and r.spec ? 'fixture_version' and r.idempotency_key not like 'cancel-test-%' and r.idempotency_key not like 'dup-%'
  order by r.created_at`)).rows;
// Runs before the matrix-1 fixes (sink permissions, baseline index, release traffic) are kept in
// the table for transparency but excluded from the summary.
const SINCE = process.env.SW_REPORT_SINCE ?? "2026-10-18T02:58:00Z";
const findings = (await pool.query("select run_id, invariant_id, observed from findings")).rows;
const calls = (await pool.query("select run_id, decided_by, status, tool from tool_calls")).rows;

const rows = runs.map((r) => {
  const fs = findings.filter((f) => f.run_id === r.id);
  const cs = calls.filter((c) => c.run_id === r.id);
  let truth = "clean candidate";
  let detected: boolean | null = null;
  if (r.fault?.invariant && r.fault.invariant !== "unsupported") {
    truth = `seeded: ${r.fault.invariant}`;
    detected = fs.some((f) => f.invariant_id === r.fault.invariant);
  } else if (r.fault?.invariant === "unsupported") {
    truth = "seeded: unsupported revision";
    detected = r.verdict === "unsupported";
  } else if (r.fault?.truth) {
    truth = "seeded: classification truth";
    const rowsSummary = r.summary?.rows ?? [];
    const agree = rowsSummary.filter((x: any) => r.fault.truth[x.service] === x.workbench).length;
    detected = rowsSummary.length ? agree === rowsSummary.length : false;
    truth += ` (${agree}/${Object.keys(r.fault.truth).length} services agree)`;
  } else if (r.fault?.note) {
    truth = "policy run (documented behaviors)";
  }
  const correct = truth === "clean candidate" ? r.verdict === "pass" : detected;
  return {
    id: r.id.slice(0, 8), module: r.module, fixture: r.fixture, mode: r.mode, status: r.status, verdict: r.verdict, truth, detected_or_correct: correct,
    experiments: cs.filter((c) => c.status === "succeeded" && !c.tool.endsWith(".finish")).length, rejected: cs.filter((c) => c.status === "rejected").length,
    model_tokens: r.summary?.model_tokens ?? 0, minutes: r.finished_at ? Math.round((new Date(r.finished_at).getTime() - new Date(r.created_at).getTime()) / 6000) / 10 : null,
    error: r.error ?? null,
  };
});
const created = new Map(runs.map((r) => [r.id.slice(0, 8), new Date(r.created_at).toISOString()]));
const byMode = (m: string) => rows.filter((r) => r.mode === m && r.status === "completed" && r.detected_or_correct !== null && created.get(r.id)! >= SINCE);
const summary = {
  generated_at: new Date().toISOString(),
  baseline: { runs: byMode("baseline").length, correct: byMode("baseline").filter((r) => r.detected_or_correct).length },
  agent: { runs: byMode("agent").length, correct: byMode("agent").filter((r) => r.detected_or_correct).length, rejected_actions: rows.filter((r) => r.mode === "agent").reduce((n, r) => n + r.rejected, 0) },
  since: SINCE,
  note: "Correct = clean candidate judged pass, or the seeded invariant appears among findings (classification fixtures: every service matches the private truth). Truth is read only here, never by the agent.",
  rows,
};
writeFileSync("docs/evidence/planner-comparison.json", JSON.stringify(summary, null, 2) + "\n");
const md = ["| run | module | candidate | planner | verdict | seeded truth | correct | experiments | rejected | tokens | min |", "|---|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.id} | ${r.module} | ${r.fixture} | ${r.mode} | ${r.status === "completed" ? r.verdict : r.status} | ${r.truth} | ${r.detected_or_correct === null ? "n/a" : r.detected_or_correct ? "yes" : "no"} | ${r.experiments} | ${r.rejected} | ${r.model_tokens} | ${r.minutes ?? ""} |`)].join("\n");
writeFileSync("docs/evidence/runs-table.md", md + "\n");
console.log(JSON.stringify({ baseline: summary.baseline, agent: summary.agent }));
await pool.end();
