import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { anon, asUser } from "./db.ts";
import { newToken, tokenHash, verifyPassword } from "./auth.ts";
import { MODULE_DEFS, getModule } from "../modules/registry.ts";
import { ExperimentSpec, sha256 } from "../agent/schemas.ts";
import { grafana, prometheus, sink } from "../worker/targets.ts";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});

type Authed = Request & { user: { id: string; email: string; name: string } };
const COOKIE = "sw_session";
const cookieToken = (req: Request) => (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);

async function requireUser(req: Request, res: Response, next: NextFunction) {
  const token = cookieToken(req);
  if (!token) return res.status(401).json({ error: "sign in required" });
  const u = await anon((tx) => tx.query("select * from sw_session_user($1)", [tokenHash(token)]));
  if (!u.rowCount) return res.status(401).json({ error: "session expired" });
  (req as Authed).user = u.rows[0];
  next();
}
const wrap = (fn: (req: Authed, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req as Authed, res).catch(next);

app.post("/api/auth/login", wrap(async (req, res) => {
  const body = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "email and password required" });
  const row = (await anon((tx) => tx.query("select * from sw_auth_lookup($1)", [body.data.email]))).rows[0];
  if (!row || !verifyPassword(body.data.password, row.password_hash)) return res.status(401).json({ error: "invalid credentials" });
  const token = newToken();
  await anon((tx) => tx.query("select sw_session_create($1, $2, $3)", [row.id, tokenHash(token), 12 * 3600]));
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}`);
  res.json({ id: row.id, name: row.name });
}));
app.post("/api/auth/logout", wrap(async (req, res) => {
  const token = cookieToken(req);
  if (token) await anon((tx) => tx.query("select sw_session_delete($1)", [tokenHash(token)]));
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
}));

app.get("/api/status", wrap(async (_req, res) => {
  const check = async (name: string, fn: () => Promise<unknown>) => {
    try {
      return { name, ok: true, detail: await fn() };
    } catch (e) {
      return { name, ok: false, detail: (e as Error).message.slice(0, 200) };
    }
  };
  res.json(await Promise.all([
    check("grafana", async () => (await grafana.health()).version),
    check("prometheus", async () => (await prometheus.buildinfo()).version),
    check("webhook-sink", async () => `${(await sink.receipts(1e12)).last_seq} receipts`),
    check("model", async () => {
      const r = await fetch(`${process.env.OLLAMA_URL ?? "http://127.0.0.1:11434"}/api/tags`, { signal: AbortSignal.timeout(2000) });
      return (await r.json()).models.map((m: any) => m.name).join(", ");
    }),
  ]));
}));

app.get("/api/modules", (_req, res) => {
  res.json(MODULE_DEFS.map((m) => ({
    id: m.id, title: m.title, tagline: m.tagline, plain: m.plain, defaultContract: m.defaultContract, budget: m.budget,
    contractSchema: z.toJSONSchema(m.contractSchema),
    fixtures: m.fixtures.map((f) => ({ name: f.name, version: f.version, title: f.title, manifest: f.manifest })), // public part only
    tools: m.tools.map((t) => ({ name: t.name, description: t.description, mutating: t.mutating })),
  })));
});

app.use("/api", requireUser);
app.get("/api/me", wrap(async (req, res) => {
  const ws = await asUser(req.user.id, (tx) => tx.query("select w.id, w.name, m.role from workspaces w join memberships m on m.workspace_id = w.id and m.user_id = app_user() order by w.created_at"));
  res.json({ user: req.user, workspaces: ws.rows });
}));

app.get("/api/workspaces/:ws/projects", wrap(async (req, res) => {
  const r = await asUser(req.user.id, (tx) => tx.query("select * from projects where workspace_id = $1 order by module, created_at", [req.params.ws]));
  res.json(r.rows);
}));

app.put("/api/projects/:id/contract", wrap(async (req, res) => {
  const project = (await asUser(req.user.id, (tx) => tx.query("select * from projects where id = $1", [req.params.id]))).rows[0];
  if (!project) return res.status(404).json({ error: "project not found" });
  const parsed = getModule(project.module).contractSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: "contract failed validation", issues: parsed.error.issues.slice(0, 10) });
  const r = await asUser(req.user.id, (tx) => tx.query("update projects set contract = $2, contract_hash = $3 where id = $1 returning *", [req.params.id, JSON.stringify(parsed.data), sha256(parsed.data)]));
  res.json(r.rows[0]);
}));

const StartRun = z.object({
  mode: z.enum(["baseline", "agent"]),
  fixture_version: z.string().max(80),
  idempotency_key: z.string().min(8).max(100).optional(),
  seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
});
app.post("/api/projects/:id/runs", wrap(async (req, res) => {
  const body = StartRun.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "invalid run request", issues: body.error.issues });
  const out = await asUser(req.user.id, async (tx) => {
    const project = (await tx.query("select * from projects where id = $1", [req.params.id])).rows[0];
    if (!project) return { status: 404, body: { error: "project not found" } };
    const mod = getModule(project.module);
    const fixture = mod.fixtures.find((f) => f.version === body.data.fixture_version);
    if (!fixture) return { status: 422, body: { error: `unknown fixture ${body.data.fixture_version} for ${mod.title}` } };
    const contract = mod.contractSchema.safeParse(project.contract);
    if (!contract.success) return { status: 422, body: { error: "saved contract no longer validates" } };
    const seed = body.data.seed ?? randomInt(1, 2 ** 31 - 1);
    const spec = ExperimentSpec.parse({
      version: 1, project_id: project.id, module: mod.id, contract_hash: project.contract_hash, fixture_version: `${fixture.name}@${fixture.version}`, seed,
      supported_parameters: { tools: mod.tools.map((t) => t.name), budget: mod.budget },
      limits: { max_steps: mod.budget + 6, deadline_seconds: 1500, max_model_tokens: 60_000 },
    });
    const key = body.data.idempotency_key ?? randomUUID();
    const existing = (await tx.query("select id, status from runs where workspace_id = $1 and idempotency_key = $2", [project.workspace_id, key])).rows[0];
    if (existing) return { status: 200, body: { ...existing, deduplicated: true } };
    const r = await tx.query(
      `insert into runs (workspace_id, project_id, module, mode, spec, spec_hash, seed, idempotency_key, deadline_at, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(secs => $9), $10) returning id, status`,
      [project.workspace_id, project.id, mod.id, body.data.mode, JSON.stringify({ ...spec, fixture_name: fixture.name, fixture_version: fixture.version }),
        sha256(spec), seed, key, spec.limits.deadline_seconds, req.user.id]);
    return { status: 201, body: r.rows[0] };
  });
  res.status(out.status).json(out.body);
}));

app.get("/api/workspaces/:ws/runs", wrap(async (req, res) => {
  const r = await asUser(req.user.id, (tx) => tx.query(
    `select r.id, r.module, r.mode, r.status, r.verdict, r.created_at, r.started_at, r.finished_at, r.spec->>'fixture_version' as fixture, r.replay_of, r.error, p.name as project
     from runs r join projects p on p.id = r.project_id where r.workspace_id = $1 order by r.created_at desc limit 100`, [req.params.ws]));
  res.json(r.rows);
}));

app.get("/api/runs/:id", wrap(async (req, res) => {
  const data = await asUser(req.user.id, async (tx) => {
    const run = (await tx.query("select * from runs where id = $1", [req.params.id])).rows[0];
    if (!run) return null;
    const [steps, calls, findings, artifacts] = await Promise.all([
      tx.query("select seq, kind, status, detail, started_at from steps where run_id = $1 order by seq", [run.id]),
      tx.query("select action_id, tool, args, decided_by, decision_summary, status, result, error_category, started_at, finished_at from tool_calls where run_id = $1 order by started_at", [run.id]),
      tx.query("select * from findings where run_id = $1 order by created_at", [run.id]),
      tx.query("select id, kind, name, sha256, created_at from artifacts where run_id = $1 order by created_at", [run.id]),
    ]);
    return { run, steps: steps.rows, tool_calls: calls.rows, findings: findings.rows, artifacts: artifacts.rows };
  });
  if (!data) return res.status(404).json({ error: "run not found" });
  res.json(data);
}));

app.get("/api/runs/:id/artifacts/:artifact", wrap(async (req, res) => {
  const r = await asUser(req.user.id, (tx) => tx.query("select * from artifacts where run_id = $1 and id = $2", [req.params.id, req.params.artifact]));
  if (!r.rowCount) return res.status(404).json({ error: "artifact not found" });
  res.json(r.rows[0]);
}));

app.post("/api/runs/:id/cancel", wrap(async (req, res) => {
  const r = await asUser(req.user.id, (tx) => tx.query(
    `update runs set cancel_requested = true,
       status = case when status = 'queued' then 'cancelled' else status end,
       finished_at = case when status = 'queued' then now() else finished_at end
     where id = $1 and status in ('queued', 'running') returning id, status`, [req.params.id]));
  if (!r.rowCount) return res.status(409).json({ error: "run is not active" });
  res.json(r.rows[0]);
}));

app.post("/api/runs/:id/replay", wrap(async (req, res) => {
  const out = await asUser(req.user.id, async (tx) => {
    const src = (await tx.query("select * from runs where id = $1", [req.params.id])).rows[0];
    if (!src || src.status !== "completed") return null;
    return (await tx.query(
      `insert into runs (workspace_id, project_id, module, mode, spec, spec_hash, seed, idempotency_key, deadline_at, created_by, replay_of)
       values ($1,$2,$3,'replay',$4,$5,$6,$7, now() + interval '5 minutes', $8, $9) returning id, status`,
      [src.workspace_id, src.project_id, src.module, src.spec, src.spec_hash, src.seed, `replay-${randomUUID()}`, req.user.id, src.id])).rows[0];
  });
  if (!out) return res.status(409).json({ error: "only completed runs can be replayed" });
  res.status(201).json(out);
}));

app.get("/api/runs/:id/bundle", wrap(async (req, res) => {
  const bundle = await asUser(req.user.id, async (tx) => {
    const run = (await tx.query("select * from runs where id = $1", [req.params.id])).rows[0];
    if (!run) return null;
    const project = (await tx.query("select id, module, name, contract, contract_hash from projects where id = $1", [run.project_id])).rows[0];
    const fixture = (await tx.query("select module, name, version, manifest, content_hash from fixture_versions where module = $1 and name = $2 and version = $3",
      [run.module, run.spec.fixture_name, run.spec.fixture_version])).rows[0];
    const tables = await Promise.all(["steps", "tool_calls", "findings", "artifacts"].map((t) => tx.query(`select * from ${t} where run_id = $1 order by 1`, [run.id])));
    const { lease_owner, ...publicRun } = run;
    return {
      bundle_version: 1, exported_at: new Date().toISOString(),
      provenance: run.mode === "replay" ? `replay of ${run.replay_of}; no new experiment` : `${run.mode} run executed on the local stack`,
      run: publicRun, project, fixture,
      steps: tables[0].rows, tool_calls: tables[1].rows, findings: tables[2].rows, artifacts: tables[3].rows,
    };
  });
  if (!bundle) return res.status(404).json({ error: "run not found" });
  res.setHeader("Content-Disposition", `attachment; filename="signalworks-run-${req.params.id.slice(0, 8)}.json"`);
  res.json({ ...bundle, sha256: sha256(bundle) });
}));

if (existsSync("dist")) {
  app.use(express.static("dist"));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile("index.html", { root: "dist" }));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const invalidId = /invalid input syntax for type uuid/.test(err.message);
  if (!invalidId) console.error(JSON.stringify({ ts: new Date().toISOString(), event: "api.error", message: err.message }));
  res.status(invalidId ? 404 : 500).json({ error: invalidId ? "not found" : "internal error" });
});

const port = Number(process.env.SW_PORT ?? 4400);
app.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ event: "api.listening", url: `http://127.0.0.1:${port}` })));
