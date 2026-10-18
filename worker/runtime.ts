// Durable run execution. A run is claimed with a lease (sw_claim_run), heartbeated, and executed
// as a sequence of tool calls keyed by a deterministic action_id. On restart, succeeded calls are
// reused (never re-executed); a call that was in flight is reconciled: its owned external
// resources are removed and it is recorded as interrupted before any new attempt.
import { randomUUID } from "node:crypto";
import { inWorkspace, workerPool, type Tx } from "../server/db.ts";
import { AgentAction, sha256, type ToolResult } from "../agent/schemas.ts";
import { planNext } from "../agent/planner.ts";
import { getModule } from "../modules/registry.ts";
import type { ModuleDef, RunContext } from "../modules/types.ts";
import { TargetError } from "./targets.ts";

export const LEASE_SECONDS = 30;
const STACK_LOCK = 4242; // one experiment at a time against the shared local stack

export class Cancelled extends Error {}
export class DeadlineExceeded extends Error {}

const log = (event: string, detail: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...detail }));

export async function claim(workerId: string): Promise<{ run_id: string; workspace_id: string; attempts: number } | null> {
  const r = await workerPool.query("select * from sw_claim_run($1, $2)", [workerId, LEASE_SECONDS]);
  return r.rows[0] ?? null;
}

async function loadRun(tx: Tx, runId: string) {
  const run = (await tx.query("select * from runs where id = $1", [runId])).rows[0];
  const project = (await tx.query("select * from projects where id = $1", [run.project_id])).rows[0];
  const fixture = (await tx.query("select name, version, manifest from fixture_versions where module = $1 and name = $2 and version = $3",
    [run.module, run.spec.fixture_name, run.spec.fixture_version])).rows[0];
  return { run, project, fixture };
}

export async function execute(workerId: string, claimed: { run_id: string; workspace_id: string; attempts: number }): Promise<void> {
  const ws = claimed.workspace_id;
  const runId = claimed.run_id;
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    const { run, project, fixture } = await inWorkspace(ws, (tx) => loadRun(tx, runId));
    const mod = getModule(run.module);
    log("run.start", { run_id: runId, module: run.module, mode: run.mode, attempt: claimed.attempts, worker_id: workerId });
    heartbeat = setInterval(() => {
      workerPool.query("select sw_heartbeat($1, $2, $3)", [runId, workerId, LEASE_SECONDS]).catch(() => {});
    }, 10_000);

    let seq = (await inWorkspace(ws, (tx) => tx.query("select coalesce(max(seq), 0) as s from steps where run_id = $1", [runId]))).rows[0].s as number;
    const step = async (kind: string, status: string, detail: Record<string, unknown>) => {
      seq += 1;
      await inWorkspace(ws, (tx) => tx.query(
        "insert into steps (run_id, workspace_id, seq, kind, status, detail, finished_at) values ($1,$2,$3,$4,$5,$6, case when $5 <> 'running' then now() end)",
        [runId, ws, seq, kind, status, detail]));
    };

    const memory: Record<string, any> = {};
    const ctx: RunContext = {
      runId,
      shortId: runId.slice(0, 8),
      seed: run.seed,
      contract: project.contract,
      fixture,
      memory,
      log: (event, detail) => log(event, { run_id: runId, ...detail }),
      async artifact(kind, name, content) {
        const r = await inWorkspace(ws, (tx) => tx.query(
          "insert into artifacts (run_id, workspace_id, kind, name, content, sha256) values ($1,$2,$3,$4,$5,$6) returning id",
          [runId, ws, kind, name, JSON.stringify(content), sha256(content)]));
        return r.rows[0].id;
      },
      async checkpoint() {
        const r = (await inWorkspace(ws, (tx) => tx.query("select cancel_requested, deadline_at < now() as late from runs where id = $1", [runId]))).rows[0];
        if (r.cancel_requested) throw new Cancelled("cancel requested");
        if (r.late) throw new DeadlineExceeded("run deadline exceeded");
      },
    };

    if (run.attempts > 1) await reconcile(ws, runId, mod, ctx, step);
    await rebuildMemory(ws, runId, mod, ctx);
    if (run.mode === "replay") {
      await finishReplay(ws, run, step);
      return;
    }

    const costs = (t: ModuleDef["tools"][number]) => t.mutating || !!t.budgeted;
    const mutatingTools = mod.tools.filter(costs).map((t) => t.name);
    let calls = (await inWorkspace(ws, (tx) => tx.query(
      "select count(*)::int as n from tool_calls where run_id = $1 and status in ('succeeded', 'failed') and tool = any($2) and action_id not like '%:interrupted'",
      [runId, mutatingTools]))).rows[0].n as number;
    let decisions = (await inWorkspace(ws, (tx) => tx.query("select count(*)::int as n from tool_calls where run_id = $1", [runId]))).rows[0].n as number;
    const baseline = mod.baselinePlan(project.contract);
    let baselineIdx = (await inWorkspace(ws, (tx) => tx.query(
      "select count(*)::int as n from tool_calls where run_id = $1 and decided_by = 'baseline' and action_id not like '%:interrupted'", [runId]))).rows[0].n as number;
    const maxDecisions = run.spec.limits.max_steps;
    let tokens = 0;
    let consecutiveRejections = 0;
    while (decisions < maxDecisions) {
      await ctx.checkpoint();
      let action: AgentAction;
      let decidedBy: "baseline" | "model";
      if (run.mode === "baseline") {
        if (baselineIdx >= baseline.length) break;
        action = { ...baseline[baselineIdx], decision_summary: `fixed matrix step ${baselineIdx + 1}/${baseline.length}` };
        baselineIdx += 1;
        decidedBy = "baseline";
      } else {
        if (consecutiveRejections >= 3) {
          await recordCall(ws, runId, `${decisions + 1}:finish`, { tool: `${mod.id}.finish`, args: {}, decision_summary: "stopped after 3 consecutive rejected proposals" }, "system", "succeeded", { finished: true }, null);
          await step("agent.finish", "succeeded", { summary: "stopped after repeated rejected proposals" });
          break;
        }
        // Once the experiment budget is spent the model is offered only read-only tools and finish.
        const next = await planNext(mod, ctx, { used: calls, budget: mod.budget }, run.spec.limits.max_model_tokens - tokens);
        tokens += next.tokens;
        decidedBy = "model";
        if (!next.action) {
          await recordRejected(ws, runId, decisions, next.raw, next.error ?? "invalid action", decidedBy);
          consecutiveRejections += 1;
          decisions += 1;
          await step("agent.rejected", "failed", { error: next.error, raw: String(next.raw).slice(0, 500) });
          continue;
        }
        action = next.action;
      }
      decisions += 1;
      if (action.tool.endsWith(".finish")) {
        await recordCall(ws, runId, `${decisions}:finish`, action, decidedBy, "succeeded", { finished: true }, null);
        await step("agent.finish", "succeeded", { summary: action.decision_summary });
        break;
      }
      const tool = mod.tools.find((t) => t.name === action.tool);
      const parsed = tool?.args.safeParse(action.args);
      if (!tool || !parsed?.success) {
        await recordRejected(ws, runId, decisions, action, !tool ? `unknown tool ${action.tool}` : parsed!.error!.message.slice(0, 400), decidedBy);
        (ctx.memory.rejections ??= []).push(`${action.tool}: ${!tool ? "unknown tool" : "arguments failed validation"}`);
        await step("tool.rejected", "failed", { tool: action.tool, reason: !tool ? "unknown tool" : "arguments failed validation" });
        consecutiveRejections += 1;
        continue;
      }
      const argsHash = sha256(parsed.data);
      const duplicate = (ctx.memory.results ?? []).some((r: any) => r.tool === tool.name && sha256(r.args) === argsHash);
      if (duplicate && run.mode === "agent") {
        await recordRejected(ws, runId, decisions, action, "duplicate of an earlier successful action with identical arguments; it returns no new evidence", decidedBy);
        (ctx.memory.rejections ??= []).push(`${tool.name} ${JSON.stringify(parsed.data)}: duplicate, no new evidence`);
        consecutiveRejections += 1;
        continue;
      }
      if (costs(tool) && calls >= mod.budget) {
        await recordRejected(ws, runId, decisions, action, `experiment budget of ${mod.budget} exhausted`, decidedBy);
        (ctx.memory.rejections ??= []).push(`${tool.name}: experiment budget exhausted`);
        consecutiveRejections += 1;
        continue;
      }
      consecutiveRejections = 0;
      const actionId = `${costs(tool) ? `x${calls + 1}` : `r${decisions}`}:${tool.name}:${sha256(parsed.data).slice(0, 8)}`;
      const existing = (await inWorkspace(ws, (tx) => tx.query("select status, result from tool_calls where run_id = $1 and action_id = $2", [runId, actionId]))).rows[0];
      if (existing?.status === "succeeded") {
        if (costs(tool)) calls += 1;
        continue; // already done before a restart: reuse, never repeat the effect
      }
      await recordCall(ws, runId, actionId, action, decidedBy, "running", null, null);
      await step("tool.start", "running", { tool: tool.name, action_id: actionId, args: parsed.data });
      const result = await runTool(ctx, tool, parsed.data, actionId);
      await finishCall(ws, runId, actionId, result);
      await step("tool.done", result.status === "succeeded" ? "succeeded" : "failed",
        { tool: tool.name, action_id: actionId, error_category: result.error_category, observations: summarize(result.structured_observations) });
      if (result.status === "succeeded") applyToMemory(ctx, tool.name, parsed.data, result.structured_observations, result.evidence_refs);
      // A precondition/validation failure performed no experiment, so it doesn't spend budget.
      if (costs(tool) && result.error_category !== "validation") calls += 1;
      if (result.status !== "succeeded") (ctx.memory.rejections ??= []).push(`${tool.name}: ${String(result.structured_observations.error ?? "failed").slice(0, 160)}`);
      if (result.error_category === "infrastructure") break; // stop rather than misattribute an outage
    }

    const evaluation = mod.evaluate(ctx);
    await inWorkspace(ws, async (tx) => {
      for (const f of evaluation.findings)
        await tx.query("insert into findings (run_id, workspace_id, invariant_id, expected, observed, evidence_refs, severity, provenance, reproduction_ref) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [runId, ws, f.invariant_id, JSON.stringify(f.expected), JSON.stringify(f.observed), f.evidence_refs, f.severity, f.provenance, f.reproduction_ref]);
      await tx.query("update runs set status = 'completed', verdict = $2, summary = $3, finished_at = now(), lease_owner = null where id = $1",
        [runId, evaluation.verdict.result, JSON.stringify({ ...evaluation.summary, verdict: evaluation.verdict, model_tokens: tokens, tool_calls: calls })]);
    });
    await step("evaluate", "succeeded", { verdict: evaluation.verdict.result, reasons: evaluation.verdict.reasons });
    log("run.completed", { run_id: runId, verdict: evaluation.verdict.result });
    await mod.cleanup(ctx).catch((e) => log("cleanup.failed", { run_id: runId, message: (e as Error).message }));
  } catch (e) {
    const err = e as Error;
    const status = err instanceof Cancelled ? "cancelled" : "failed";
    const verdict = err instanceof Cancelled ? "not_evaluated" : "inconclusive";
    log(`run.${status}`, { run_id: runId, message: err.message });
    await inWorkspace(ws, (tx) => tx.query(
      "update runs set status = $2, verdict = $3, error = $4, finished_at = now(), lease_owner = null where id = $1",
      [runId, status, verdict, err.message.slice(0, 1000)])).catch(() => {});
    try {
      const { run } = await inWorkspace(ws, (tx) => loadRun(tx, runId));
      await getModule(run.module).cleanup({ runId, shortId: runId.slice(0, 8) } as RunContext);
    } catch {
      /* best effort; owned resources are prefixed and can be removed by reset */
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

/** One experiment at a time against the shared local stack. The lock is taken BEFORE claiming, so a
 * claimed run's lease never expires while it waits for another worker's experiment to finish. */
export async function withStackLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const c = await workerPool.connect();
  try {
    const got = (await c.query("select pg_try_advisory_lock($1) as ok", [STACK_LOCK])).rows[0].ok;
    if (!got) return null;
    try {
      return await fn();
    } finally {
      await c.query("select pg_advisory_unlock($1)", [STACK_LOCK]).catch(() => {});
    }
  } finally {
    c.release();
  }
}

async function runTool(ctx: RunContext, tool: ModuleDef["tools"][number], args: unknown, actionId: string): Promise<ToolResult> {
  const observedAt = () => new Date().toISOString();
  let timer: NodeJS.Timeout | undefined;
  try {
    const out = await Promise.race([
      tool.run(ctx, args),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new TargetError(`tool ${tool.name} exceeded ${tool.timeoutMs} ms`, "timeout")), tool.timeoutMs))),
    ]);
    return { action_id: actionId, status: "succeeded", observed_at: observedAt(), evidence_refs: out.evidence, structured_observations: out.observations, error_category: null };
  } catch (e) {
    if (e instanceof Cancelled || e instanceof DeadlineExceeded) throw e;
    const category = e instanceof TargetError ? e.category : "infrastructure";
    return { action_id: actionId, status: "failed", observed_at: observedAt(), evidence_refs: [], structured_observations: { error: (e as Error).message.slice(0, 500) }, error_category: category };
  } finally {
    clearTimeout(timer);
  }
}

async function recordCall(ws: string, runId: string, actionId: string, action: AgentAction, decidedBy: string, status: string, result: unknown, category: string | null) {
  await inWorkspace(ws, (tx) => tx.query(
    `insert into tool_calls (run_id, workspace_id, action_id, tool, args, args_hash, decided_by, decision_summary, status, result, error_category, finished_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, case when $9 <> 'running' then now() end)
     on conflict (run_id, action_id) do update set status = excluded.status, started_at = now(), finished_at = null`,
    [runId, ws, actionId, action.tool, JSON.stringify(action.args), sha256(action.args), decidedBy, action.decision_summary, status, result === null ? null : JSON.stringify(result), category]));
}

async function recordRejected(ws: string, runId: string, n: number, raw: unknown, reason: string, decidedBy: string) {
  const a = typeof raw === "object" && raw !== null && "tool" in raw ? (raw as AgentAction) : { tool: "invalid", args: {}, decision_summary: "" };
  await inWorkspace(ws, (tx) => tx.query(
    `insert into tool_calls (run_id, workspace_id, action_id, tool, args, args_hash, decided_by, decision_summary, status, result, error_category, finished_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'rejected',$9,'validation',now()) on conflict do nothing`,
    [runId, ws, `rej${n}-${randomUUID().slice(0, 6)}`, String(a.tool).slice(0, 80), JSON.stringify(a.args ?? {}), sha256(a.args ?? {}), decidedBy,
      String(a.decision_summary ?? "").slice(0, 400), JSON.stringify({ reason, raw: typeof raw === "string" ? raw.slice(0, 500) : undefined })]));
}

async function finishCall(ws: string, runId: string, actionId: string, r: ToolResult) {
  await inWorkspace(ws, (tx) => tx.query(
    "update tool_calls set status = $3, result = $4, error_category = $5, finished_at = now() where run_id = $1 and action_id = $2",
    [runId, actionId, r.status, JSON.stringify({ observations: r.structured_observations, evidence_refs: r.evidence_refs, observed_at: r.observed_at }), r.error_category]));
}

function applyToMemory(ctx: RunContext, tool: string, args: unknown, obs: Record<string, unknown>, evidence: string[] = []) {
  (ctx.memory.results ??= []).push({ tool, args, observations: obs, evidence });
}

async function rebuildMemory(ws: string, runId: string, _mod: ModuleDef, ctx: RunContext) {
  const rows = (await inWorkspace(ws, (tx) => tx.query("select tool, args, result from tool_calls where run_id = $1 and status = 'succeeded' and tool not like '%.finish' order by started_at", [runId]))).rows;
  for (const r of rows) applyToMemory(ctx, r.tool, r.args, r.result?.observations ?? {}, r.result?.evidence_refs ?? []);
}

/** After a crash, a tool call left 'running' had external effects in an unknown state. Remove the
 * run's owned resources and mark it interrupted; the planner then decides again with fresh state. */
async function reconcile(ws: string, runId: string, mod: ModuleDef, ctx: RunContext, step: (k: string, s: string, d: Record<string, unknown>) => Promise<void>) {
  const inflight = (await inWorkspace(ws, (tx) => tx.query("select action_id, tool from tool_calls where run_id = $1 and status = 'running'", [runId]))).rows;
  if (!inflight.length) return;
  await mod.cleanup(ctx);
  await inWorkspace(ws, (tx) => tx.query(
    "update tool_calls set status = 'failed', error_category = 'infrastructure', result = $2, finished_at = now() where run_id = $1 and status = 'running'",
    [runId, JSON.stringify({ observations: { error: "interrupted by worker restart; owned resources removed before retry" } })]));
  await step("recovery.reconciled", "succeeded", { interrupted: inflight.map((r) => r.action_id) });
  // Interrupted mutating calls don't consume budget: drop them from the count by renaming.
  await inWorkspace(ws, (tx) => tx.query("update tool_calls set action_id = action_id || ':interrupted' where run_id = $1 and status = 'failed' and result->'observations'->>'error' like 'interrupted%' and action_id not like '%:interrupted'", [runId]));
}

async function finishReplay(ws: string, run: any, step: (k: string, s: string, d: Record<string, unknown>) => Promise<void>) {
  // Replay re-evaluates the source run's recorded evidence; it performs no new experiment.
  await inWorkspace(ws, async (tx) => {
    const src = (await tx.query("select verdict, summary from runs where id = $1", [run.replay_of])).rows[0];
    await tx.query("update runs set status = 'completed', verdict = $2, summary = $3, finished_at = now(), lease_owner = null where id = $1",
      [run.id, src?.verdict ?? "inconclusive", JSON.stringify({ replay_of: run.replay_of, source_summary: src?.summary ?? null, note: "Replay of recorded evidence; no new experiment was executed." })]);
  });
  await step("replay", "succeeded", { replay_of: run.replay_of });
}

function summarize(obs: Record<string, unknown>): Record<string, unknown> {
  const s = JSON.stringify(obs);
  return s.length < 1500 ? obs : { truncated: true, keys: Object.keys(obs) };
}
