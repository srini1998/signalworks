import type { ReactNode } from "react";
// Readable views of each module's recorded evaluation summary. Values come straight from the
// run's saved summary (the evaluator's input); nothing here is computed or estimated anew.

const okBadge = (ok: boolean | null | undefined, labels = ["held", "violated", "not determined"]) => (
  <span className={`badge ${ok === true ? "pass" : ok === false ? "fail" : "inconclusive"}`}>{ok === true ? labels[0] : ok === false ? labels[1] : labels[2]}</span>
);

function Table({ head, rows }: { head: string[]; rows: (string | number | ReactNode)[][] }) {
  return (
    <div className="panel" style={{ padding: 0, overflowX: "auto", marginBottom: "0.8rem" }}>
      <table>
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function ModuleSummary({ module, summary }: { module: string; summary: any }) {
  if (!summary) return null;
  if (module === "metriccontract" && summary.checks) {
    return <Table head={["Metric", "Check", "Expected", "Observed", "Result"]}
      rows={summary.checks.map((c: any) => [<code>{c.metric}</code>, c.invariant.replace(/_/g, " "), c.expected, c.observed, okBadge(c.ok)])} />;
  }
  if (module === "routereplay" && summary.cases) {
    return <Table head={["Case", "Receipts (receiver × alerts @ seconds)", "Check", "Result"]}
      rows={summary.cases.map((c: any) => [
        `${c.args.team} × ${c.args.alerts}${c.args.silenced ? " (silenced)" : ""}`,
        c.deliveries.length ? c.deliveries.map((d: any) => `${d.receiver} × ${d.alerts_in_notification} @ ${d.seconds_after_rule_created}s`).join(", ") : "none before deadline",
        c.check.invariant.replace(/_/g, " "), okBadge(c.check.ok, ["held", "violated", "no receipt / not reproduced"]),
      ])} />;
  }
  if (module === "serieswatch" && summary.rows) {
    return (
      <>
        <p className="muted">Grafana's own state (left) and the workbench interpretation (right), side by side. Grafana's history is never modified.</p>
        <Table head={["Service", "Grafana observed", "Workbench classification", "Why"]}
          rows={summary.rows.map((r: any) => [<code>{r.service}</code>, r.grafana, <span className={`badge ${r.workbench === "inconclusive" ? "inconclusive" : r.workbench === "endpoint_down" ? "fail" : "pass"}`}>{r.workbench.replace(/_/g, " ")}</span>, r.why])} />
      </>
    );
  }
  if (module === "dashboardreplay" && summary.before && summary.after) {
    const row = (label: string, o: any) => [label, <code>{o.bound_query}</code>, o.series.map((s: any) => s.mean?.toFixed?.(3) ?? "?").join(", "), o.checks.map((c: any) => <div key={c.invariant}>{okBadge(c.ok)} {c.invariant.replace(/_/g, " ")}: {c.observed}</div>)];
    return (
      <>
        <p className="muted">Both revisions over the same frozen window {summary.after.window.from} → {summary.after.window.to}; reference: <code>{summary.after.reference_query}</code></p>
        <Table head={["Revision", "Bound query", "Series mean(s)", "Checks"]} rows={[row("before", summary.before), row("after", summary.after)]} />
      </>
    );
  }
  if (module === "dashboardreplay" && summary.support) {
    return <Table head={["Revision", "Unsupported features"]} rows={Object.entries<any>(summary.support).map(([k, v]) => [k, v.length ? v.join("; ") : "none"])} />;
  }
  if (module === "filterproof" && summary.cases) {
    return (
      <>
        <p className="muted">Counts per case. Missing entries stay in the denominator; sampling and timeouts are reported from Alloy's own counters.</p>
        <Table head={["Case", "Delivered", "Line secrets masked / partial / unredacted", "Benign altered", "Label canaries", "Alloy: bypassed · timed out · dropped", "Loki stored"]}
          rows={summary.cases.map((c: any) => {
            const s = c.summary;
            const m = c.metrics ?? {};
            if (!s) return [JSON.stringify(c.args), <span className="badge inconclusive">infrastructure</span>, c.infrastructure?.slice(0, 120) ?? "", "", "", "", ""];
            return [
              Object.entries(c.args).map(([k, v]) => `${k}=${v}`).join(" "),
              `${s.delivered}/${s.entries}`,
              `${s.line_secrets.masked} / ${s.line_secrets.partial} / ${s.line_secrets.unredacted.length}${s.line_secrets.unredacted.length ? ` (${s.line_secrets.unredacted.slice(0, 4).join(", ")})` : ""}`,
              s.benign_altered.length || 0,
              s.labels_unprotected.length ? `${s.labels_unprotected.length} survived (documented scope)` : "—",
              `${m.loki_secretfilter_entries_bypassed_total ?? "?"} · ${m.loki_secretfilter_lines_timed_out_total ?? "?"} · ${m.loki_secretfilter_lines_dropped_total ?? "?"}`,
              c.stored_in_loki ?? "n/a",
            ];
          })} />
      </>
    );
  }
  if (module === "alertscenario" && summary.scenarios) {
    return <Table head={["Scenario", "Invariant", "Expected", "Observed", "Result"]}
      rows={summary.scenarios.map((s: any) => [`${s.kind}${s.seconds ? ` ${s.seconds}s` : ""}`, s.check.invariant.replace(/_/g, " "), s.check.expected, s.check.observed, okBadge(s.check.ok)])} />;
  }
  return null;
}
