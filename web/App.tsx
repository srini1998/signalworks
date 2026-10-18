import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, post, put } from "./api.ts";
import { ModuleEvidence } from "./viz.tsx";
import { ModuleSummary } from "./summaries.tsx";

type Me = { user: { id: string; name: string; email: string }; workspaces: { id: string; name: string; role: string }[] };
type Mod = any;
type View = { page: "overview" } | { page: "module"; id: string } | { page: "runs" } | { page: "run"; id: string };

const parseHash = (): View => {
  const [, a, b] = location.hash.split("/");
  if (a === "module" && b) return { page: "module", id: b };
  if (a === "runs") return { page: "runs" };
  if (a === "run" && b) return { page: "run", id: b };
  return { page: "overview" };
};
const go = (v: View) => {
  location.hash = v.page === "overview" ? "#/" : v.page === "runs" ? "#/runs" : `#/${v.page}/${(v as any).id}`;
};
const when = (s?: string | null) => (s ? new Date(s).toLocaleString() : "—");

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [modules, setModules] = useState<Mod[]>([]);
  const [view, setView] = useState<View>(parseHash());
  const [ws, setWs] = useState<string>("");
  const [status, setStatus] = useState<any[]>([]);

  const loadMe = useCallback(async () => {
    try {
      const m = await api<Me>("/api/me");
      setMe(m);
      setWs((cur) => cur || m.workspaces[0]?.id || "");
      setNeedLogin(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedLogin(true);
    }
  }, []);
  useEffect(() => {
    loadMe();
    api("/api/modules").then(setModules);
    api("/api/status").then(setStatus).catch(() => setStatus([]));
    const onHash = () => setView(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [loadMe]);

  if (needLogin) return <Login onDone={loadMe} />;
  if (!me) return <main><p>Loading…</p></main>;
  return (
    <div className="shell">
      <nav className="side" aria-label="Signalworks">
        <div className="brand">Signalworks<small>Observability assurance · local lab</small></div>
        <div className="navlist">
          <button aria-current={view.page === "overview" ? "page" : undefined} onClick={() => go({ page: "overview" })}>Overview</button>
          <div className="group">Modules</div>
          {modules.map((m) => (
            <button key={m.id} aria-current={view.page === "module" && view.id === m.id ? "page" : undefined} onClick={() => go({ page: "module", id: m.id })}>{m.title}</button>
          ))}
          <div className="group">Evidence</div>
          <button aria-current={view.page === "runs" || view.page === "run" ? "page" : undefined} onClick={() => go({ page: "runs" })}>All runs</button>
        </div>
      </nav>
      <main>
        <header className="top">
          <div className="row">
            <label htmlFor="ws" className="muted">Workspace</label>
            <select id="ws" value={ws} onChange={(e) => setWs(e.target.value)}>
              {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          <div className="row">
            <div className="chips" aria-label="Local stack status">
              {status.map((s) => <span key={s.name} className={`chip ${s.ok ? "ok" : "bad"}`} title={String(s.detail)}>{s.name}: {s.ok ? "up" : "down"}</span>)}
            </div>
            <span className="muted">{me.user.name}</span>
            <button onClick={async () => { await post("/api/auth/logout", {}); setMe(null); setNeedLogin(true); }}>Sign out</button>
          </div>
        </header>
        {view.page === "overview" && <Overview modules={modules} />}
        {view.page === "module" && <ModulePage key={view.id + ws} mod={modules.find((m) => m.id === view.id)} ws={ws} />}
        {view.page === "runs" && <RunsPage ws={ws} modules={modules} />}
        {view.page === "run" && <RunPage key={view.id} id={view.id} modules={modules} />}
      </main>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("maya@signalworks.local");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  return (
    <main className="login">
      <form className="panel" onSubmit={async (e) => {
        e.preventDefault();
        setErr("");
        try {
          await post("/api/auth/login", { email, password });
          onDone();
        } catch (x) {
          setErr((x as Error).message);
        }
      }}>
        <h1>Signalworks</h1>
        <p className="muted">Local lab for checking that alerts, metrics, routes, inventories, dashboards and log filters behave as promised.</p>
        <p className="muted" style={{ fontSize: "0.85rem" }}>Maya and Omar are fictional test users with separate workspaces; their generated passwords are in <code>.local/demo-users.json</code>.</p>
        <div className="form-grid">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          <label htmlFor="pw">Password</label>
          <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </div>
        {err && <p className="error" role="alert">{err}</p>}
        <p><button className="primary" type="submit">Sign in</button></p>
      </form>
    </main>
  );
}

function Overview({ modules }: { modules: Mod[] }) {
  return (
    <>
      <h1>Does your monitoring still tell the truth?</h1>
      <p className="lead">
        Dashboards and alerts are built on promises: this alert waits 30 seconds, that metric is in seconds, this team gets paged,
        this panel shows production only. Signalworks turns those promises into contracts and tests them against a real local
        Grafana, Prometheus and Alloy stack, recording what actually happened.
      </p>
      <div className="grid cards">
        {modules.map((m) => (
          <button className="card" key={m.id} onClick={() => go({ page: "module", id: m.id })}>
            <h3>{m.title}</h3>
            <p>{m.tagline}</p>
          </button>
        ))}
      </div>
      <h2>How a run works</h2>
      <ol className="steps">
        <li>You pick a candidate configuration (a reviewed one, or a proposed change) and a contract.</li>
        <li>A background worker runs real experiments against the local stack: it creates rules, drives test metrics, sends logs.</li>
        <li>In <b>baseline</b> mode it follows a fixed scenario list. In <b>agent</b> mode a local model (qwen2.5:3b via Ollama, free) chooses the next experiment from the same tools and budget.</li>
        <li>A deterministic evaluator, not the model, compares observations with the contract and records findings with evidence.</li>
      </ol>
      <p className="notice">Everything runs on this machine. Seeded defects are labeled as seeded; replays are labeled as replays.</p>
    </>
  );
}

function ContractEditor({ mod, project, onSaved }: { mod: Mod; project: any; onSaved: (p: any) => void }) {
  const [draft, setDraft] = useState<any>(project.contract);
  const [msg, setMsg] = useState<string>("");
  const props = mod.contractSchema.properties ?? {};
  const set = (k: string, v: unknown) => setDraft((d: any) => ({ ...d, [k]: v }));
  return (
    <form className="panel" onSubmit={async (e) => {
      e.preventDefault();
      try {
        onSaved(await put(`/api/projects/${project.id}/contract`, draft));
        setMsg("Saved.");
      } catch (x) {
        setMsg((x as Error).message);
      }
    }}>
      <h3>Contract</h3>
      <div className="form-grid">
        {Object.entries<any>(props).map(([k, s]) => {
          const id = `c-${k}`;
          const label = <label htmlFor={id} title={s.description}>{k.replace(/_/g, " ")}</label>;
          if (s.const !== undefined) return [label, <span key={k} id={id}>{String(s.const)} <span className="muted">(fixed)</span></span>];
          if (s.enum) return [label, <select key={k} id={id} value={draft[k]} onChange={(e) => set(k, e.target.value)}>{s.enum.map((o: string) => <option key={o}>{o}</option>)}</select>];
          if (s.type === "boolean") return [label, <input key={k} id={id} type="checkbox" checked={!!draft[k]} onChange={(e) => set(k, e.target.checked)} />];
          if (s.type === "number" || s.type === "integer")
            return [label, <input key={k} id={id} type="number" min={s.minimum} max={s.maximum} step={s.type === "integer" ? 1 : "any"} value={draft[k]} onChange={(e) => set(k, Number(e.target.value))} />];
          return [label, <code key={k} id={id}>{JSON.stringify(draft[k])}</code>];
        })}
      </div>
      <div className="row" style={{ marginTop: "0.8rem" }}>
        <button type="submit">Save contract</button>
        {msg && <span className="muted" role="status">{msg}</span>}
      </div>
    </form>
  );
}

function ModulePage({ mod, ws }: { mod?: Mod; ws: string }) {
  const [projects, setProjects] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [fixture, setFixture] = useState<string>("");
  const [mode, setMode] = useState<"baseline" | "agent">("baseline");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!mod || !ws) return;
    api(`/api/workspaces/${ws}/projects`).then((ps) => setProjects(ps.filter((p: any) => p.module === mod.id)));
    api(`/api/workspaces/${ws}/runs`).then((rs) => setRuns(rs.filter((r: any) => r.module === mod.id)));
    setFixture(mod.fixtures[0]?.version ?? "");
  }, [mod?.id, ws]);
  if (!mod) return <p>Unknown module.</p>;
  const project = projects[0];
  const fx = mod.fixtures.find((f: any) => f.version === fixture);
  return (
    <>
      <h1>{mod.title}</h1>
      <p className="lead">{mod.tagline}</p>
      <div className="grid two">
        <section className="panel">
          <h3>What it's for</h3>
          <p>{mod.plain.job}</p>
          <h3>Example</h3>
          <p>{mod.plain.example}</p>
          <h3>How it works</h3>
          <ol className="steps">{mod.plain.howItWorks.map((s: string) => <li key={s}>{s}</li>)}</ol>
          <p className="muted" style={{ fontSize: "0.88rem" }}>{mod.plain.notThis}</p>
        </section>
        <section className="grid" style={{ alignContent: "start" }}>
          <div className="panel">
            <h3>Run an experiment</h3>
            <div className="form-grid">
              <label htmlFor="fx">Candidate</label>
              <select id="fx" value={fixture} onChange={(e) => setFixture(e.target.value)}>
                {mod.fixtures.map((f: any) => <option key={f.version} value={f.version}>{f.title}</option>)}
              </select>
              <label htmlFor="mode">Planner</label>
              <select id="mode" value={mode} onChange={(e) => setMode(e.target.value as any)}>
                <option value="baseline">Baseline: fixed scenario matrix</option>
                <option value="agent">Agent: local model chooses experiments</option>
              </select>
            </div>
            {fx && <p className="muted" style={{ fontSize: "0.88rem" }}>{fx.manifest.description} <code>{JSON.stringify(fx.manifest.rule ?? fx.manifest.candidate ?? {})}</code></p>}
            <p className="muted" style={{ fontSize: "0.85rem" }}>Budget: {mod.budget} experiments for either planner. Runs take a few minutes of real time.</p>
            {err && <p className="error" role="alert">{err}</p>}
            <button className="primary" disabled={!project || busy} onClick={async () => {
              setBusy(true);
              setErr("");
              try {
                const r = await post(`/api/projects/${project.id}/runs`, { mode, fixture_version: fixture, idempotency_key: crypto.randomUUID() });
                go({ page: "run", id: r.id });
              } catch (x) {
                setErr((x as Error).message);
              } finally {
                setBusy(false);
              }
            }}>Start run</button>
          </div>
          {project && <ContractEditor mod={mod} project={project} onSaved={(p) => setProjects([p])} />}
        </section>
      </div>
      <h2>Recent {mod.title} runs</h2>
      <RunsTable runs={runs} />
    </>
  );
}

function RunsTable({ runs }: { runs: any[] }) {
  if (!runs.length) return <p className="muted">No runs yet in this workspace.</p>;
  return (
    <div className="panel" style={{ padding: 0, overflowX: "auto" }}>
      <table>
        <thead><tr><th>Started</th><th>Module</th><th>Candidate</th><th>Planner</th><th>Status</th><th>Verdict</th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="clickable" tabIndex={0} onClick={() => go({ page: "run", id: r.id })} onKeyDown={(e) => e.key === "Enter" && go({ page: "run", id: r.id })}>
              <td>{when(r.created_at)}</td><td>{r.module}</td><td>{r.fixture}</td><td>{r.mode}{r.replay_of ? " (replay)" : ""}</td>
              <td><span className={`badge ${r.status}`}>{r.status}</span></td><td><span className={`badge ${r.verdict}`}>{r.verdict.replace("_", " ")}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunsPage({ ws }: { ws: string; modules: Mod[] }) {
  const [runs, setRuns] = useState<any[]>([]);
  useEffect(() => {
    if (ws) api(`/api/workspaces/${ws}/runs`).then(setRuns);
  }, [ws]);
  return (
    <>
      <h1>All runs</h1>
      <p className="lead">Every experiment in this workspace, across modules. Replays are re-evaluations of recorded evidence, not new experiments.</p>
      <RunsTable runs={runs} />
    </>
  );
}

function RunPage({ id, modules }: { id: string; modules: Mod[] }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");
  const [drawer, setDrawer] = useState<any>(null);
  const load = useCallback(() => api(`/api/runs/${id}`).then(setData).catch((e) => setErr(e.message)), [id]);
  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (!data || ["queued", "running"].includes(data?.run?.status)) load();
    }, 2500);
    return () => clearInterval(t);
  }, [id, data?.run?.status]);
  const loadArtifact = useCallback((aid: string) => api(`/api/runs/${id}/artifacts/${aid}`), [id]);
  const artifacts = useMemo(() => data?.artifacts ?? [], [data?.artifacts?.length]);
  if (err) return <p className="error">{err}</p>;
  if (!data) return <p>Loading…</p>;
  const { run, steps, tool_calls, findings } = data;
  const mod = modules.find((m) => m.id === run.module);
  const verdict = run.summary?.verdict;
  const active = ["queued", "running"].includes(run.status);
  return (
    <>
      <p><a href={`#/module/${run.module}`}>← {mod?.title ?? run.module}</a></p>
      <h1>{mod?.title} run <span className="muted" style={{ fontSize: "1rem" }}>{run.id.slice(0, 8)}</span></h1>
      <div className="row">
        <span className={`badge ${run.status}`}>{run.status}</span>
        <span className={`badge ${run.verdict}`}>verdict: {run.verdict.replace("_", " ")}</span>
        <span className="muted">{run.mode === "agent" ? "Agent (local model) planner" : run.mode === "baseline" ? "Baseline fixed matrix" : `Replay of ${run.replay_of?.slice(0, 8)}`}</span>
        <span className="muted">candidate {run.spec.fixture_name}@{run.spec.fixture_version} · seed {run.seed}</span>
      </div>
      <div className="row" style={{ margin: "0.8rem 0" }}>
        {active && <button onClick={async () => { await post(`/api/runs/${id}/cancel`, {}); load(); }}>Cancel run</button>}
        {run.status === "completed" && run.mode !== "replay" && <button onClick={async () => { const r = await post(`/api/runs/${id}/replay`, {}); go({ page: "run", id: r.id }); }}>Replay evidence</button>}
        <a href={`/api/runs/${id}/bundle`} download><button>Download evidence bundle</button></a>
      </div>
      {run.error && <p className="error">Run stopped: {run.error}</p>}
      {run.mode === "replay" && <p className="notice">This is a replay: it re-reads the recorded result of run {run.replay_of?.slice(0, 8)} and executed no new experiment.</p>}
      {verdict && (
        <section className={`panel verdict ${verdict.result}`}>
          <h3 style={{ marginTop: 0 }}>Verdict: {verdict.result}</h3>
          <p className="muted">{verdict.scope}</p>
          <ul>{verdict.reasons.map((r: string) => <li key={r}>{r}</li>)}</ul>
          <p className="muted" style={{ fontSize: "0.85rem" }}>Limits: {verdict.limitations.join(" ")}</p>
        </section>
      )}
      {findings.length > 0 && (
        <>
          <h2>Findings</h2>
          {findings.map((f: any) => (
            <div className="panel" key={f.id} style={{ marginBottom: "0.6rem" }}>
              <strong>{f.invariant_id}</strong> <span className="badge fail">{f.severity}</span> <span className="badge">{f.provenance}</span>
              <p style={{ margin: "0.3rem 0" }}><b>Expected:</b> {typeof f.expected === "string" ? f.expected : JSON.stringify(f.expected)}</p>
              <p style={{ margin: "0.3rem 0" }}><b>Observed:</b> {typeof f.observed === "string" ? f.observed : JSON.stringify(f.observed)}</p>
              {f.reproduction_ref && <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>Reproduce: <code>{f.reproduction_ref}</code></p>}
            </div>
          ))}
        </>
      )}
      {run.summary && run.mode !== "replay" && (
        <>
          <h2>What was observed</h2>
          <ModuleSummary module={run.module} summary={run.summary} />
        </>
      )}
      <h2>Evidence artifacts</h2>
      <ModuleEvidence module={run.module} artifacts={artifacts} load={loadArtifact} />
      <h2>Decisions and tool calls</h2>
      <div className="panel" style={{ padding: 0, overflowX: "auto" }}>
        <table>
          <thead><tr><th>Tool</th><th>Decided by</th><th>Why</th><th>Status</th></tr></thead>
          <tbody>
            {tool_calls.map((c: any) => (
              <tr key={c.action_id} className="clickable" tabIndex={0} onClick={() => setDrawer(c)} onKeyDown={(e) => e.key === "Enter" && setDrawer(c)}>
                <td><code>{c.tool}</code> <span className="muted">{JSON.stringify(c.args)}</span></td>
                <td>{c.decided_by === "model" ? "local model" : c.decided_by}</td>
                <td>{c.decision_summary}</td>
                <td><span className={`badge ${c.status === "succeeded" ? "pass" : c.status === "running" ? "running" : "fail"}`}>{c.status}</span>{c.error_category ? ` ${c.error_category}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details style={{ marginTop: "1rem" }}>
        <summary>Execution log ({steps.length} steps)</summary>
        <ol className="steps">{steps.map((s: any) => <li key={s.seq}><code>{s.kind}</code> {s.status} <span className="muted">{when(s.started_at)}</span></li>)}</ol>
      </details>
      {drawer && (
        <aside className="drawer" role="dialog" aria-label="Tool call evidence">
          <div className="row" style={{ justifyContent: "space-between" }}><h3 style={{ margin: 0 }}>{drawer.tool}</h3><button onClick={() => setDrawer(null)}>Close</button></div>
          <p className="muted">{drawer.action_id}</p>
          <pre>{JSON.stringify({ args: drawer.args, result: drawer.result }, null, 2)}</pre>
        </aside>
      )}
    </>
  );
}
