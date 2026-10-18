// Module-specific views of *recorded* observations. Every shape drawn here comes from samples
// the worker saved; nothing is interpolated or invented.

const STATE_COLOR: Record<string, string> = {
  Normal: "var(--st-normal)",
  Pending: "var(--st-pending)",
  Alerting: "var(--st-alerting)",
  NoData: "var(--st-nodata)",
};

type Sample = { t: number; shards: Record<string, string>; other: string[] };

export function AlertTimeline({ artifact }: { artifact: any }) {
  const r = artifact.content;
  const samples: Sample[] = r.samples ?? [];
  if (!samples.length) return <p className="muted">No samples recorded.</p>;
  const tMax = Math.max(...samples.map((s) => s.t), 1);
  const lanes = ["a", "b", "c", "no-data"];
  const W = 760, left = 70, laneH = 26, top = 24;
  const x = (t: number) => left + (t / tMax) * (W - left - 10);
  const stateOf = (s: Sample, lane: string) => {
    if (lane === "no-data") {
      const o = s.other.find((v) => v.startsWith("no-data"));
      return o ? o.split(":")[1].replace(/ \(.*\)/, "") : null;
    }
    return s.shards[lane] ?? null;
  };
  const H = top + lanes.length * laneH + 30;
  return (
    <figure className="timeline" aria-label={`Observed alert states for scenario ${r.kind}`}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img">
        {r.phases.map((p: any, i: number) => (
          <g key={i}>
            <line x1={x(p.start)} x2={x(p.start)} y1={top - 8} y2={H - 26} stroke="var(--muted)" strokeDasharray="3 3" />
            <text x={x(p.start) + 3} y={top - 10} fontSize="11" fill="var(--muted)">{p.name}</text>
          </g>
        ))}
        {lanes.map((lane, li) => (
          <g key={lane}>
            <text x={4} y={top + li * laneH + 16} fontSize="12" fill="var(--ink)">{lane === "no-data" ? "no-data" : `shard ${lane}`}</text>
            {samples.map((s, i) => {
              const st = stateOf(s, lane);
              const next = samples[i + 1]?.t ?? s.t + 2;
              return <rect key={i} x={x(s.t)} y={top + li * laneH + 3} width={Math.max(1, x(next) - x(s.t))} height={laneH - 8}
                fill={st ? STATE_COLOR[st] ?? "var(--st-nodata)" : "var(--st-absent)"}><title>{`${s.t}s ${lane}: ${st ?? "no instance"}`}</title></rect>;
            })}
          </g>
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <text key={f} x={x(f * tMax)} y={H - 8} fontSize="11" fill="var(--muted)" textAnchor="middle">{Math.round(f * tMax)}s</text>
        ))}
      </svg>
      <div className="legend">
        <span style={{ "--c": STATE_COLOR.Normal } as any}>Normal</span>
        <span style={{ "--c": STATE_COLOR.Pending } as any}>Pending</span>
        <span style={{ "--c": STATE_COLOR.Alerting } as any}>Alerting</span>
        <span style={{ "--c": STATE_COLOR.NoData } as any}>NoData</span>
        <span style={{ "--c": "var(--st-absent)" } as any}>no instance in Grafana</span>
      </div>
      <figcaption className="muted">
        Polled from Grafana every 2 s. Grafana's own state history: {r.history.length ? r.history.map((h: any) => `${h.shard} ${h.prev} → ${h.next} (+${h.t}s)`).join(" · ") : "none recorded"}
      </figcaption>
    </figure>
  );
}

export function ModuleEvidence({ module, artifacts, load }: { module: string; artifacts: any[]; load: (id: string) => Promise<any> }) {
  return <EvidenceList module={module} artifacts={artifacts} load={load} />;
}

import { useEffect, useState } from "react";

function EvidenceList({ module, artifacts, load }: { module: string; artifacts: any[]; load: (id: string) => Promise<any> }) {
  const [loaded, setLoaded] = useState<Record<string, any>>({});
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const a of artifacts) {
        if (loaded[a.id]) continue;
        const full = await load(a.id);
        if (!alive) return;
        setLoaded((m) => ({ ...m, [a.id]: full }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [artifacts.map((a) => a.id).join(",")]);
  if (!artifacts.length) return <p className="muted">No evidence recorded yet.</p>;
  return (
    <div className="grid">
      {artifacts.map((a) => {
        const full = loaded[a.id];
        const check = full?.content?.check;
        return (
          <div className="panel" key={a.id}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{a.name}</strong>
              {check && <span className={`badge ${check.ok === true ? "pass" : check.ok === false ? "fail" : "inconclusive"}`}>{check.ok === true ? "held" : check.ok === false ? "violated" : "not determined"}</span>}
            </div>
            {check && <p className="muted" style={{ margin: "0.3rem 0" }}><b>{check.invariant}</b>: expected {check.expected}; observed {check.observed}.</p>}
            {full && module === "alertscenario" && <AlertTimeline artifact={full} />}
            {full && module !== "alertscenario" && <GenericEvidence content={full.content} />}
            {!full && <p className="muted">Loading…</p>}
            <p className="muted" style={{ fontSize: "0.75rem", margin: 0 }}>sha256 {a.sha256.slice(0, 16)}…</p>
          </div>
        );
      })}
    </div>
  );
}

export function GenericEvidence({ content }: { content: any }) {
  return (
    <details>
      <summary>Recorded observations</summary>
      <pre>{JSON.stringify(content, null, 2)}</pre>
    </details>
  );
}
