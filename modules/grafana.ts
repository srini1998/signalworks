// Grafana-managed alerting helpers over the documented provisioning and Prometheus-compatible
// rule APIs (verified against Grafana 13.2.4; see docs/verification.md). Every resource a run
// creates lives in a folder whose uid starts with "sw-<shortId>", so cleanup is scoped.
import { grafana, TargetError } from "../worker/targets.ts";

const NO_PROVENANCE = { "X-Disable-Provenance": "true" };

export type RuleSpec = {
  uid: string;
  title: string;
  folderUid: string;
  group: string;
  expr: string;
  threshold: number;
  forSeconds: number;
  noDataState: "NoData" | "Alerting" | "OK" | "KeepLast";
  intervalSeconds: number;
  labels?: Record<string, string>;
  missingSeriesEvalsToResolve?: number;
};

export async function ensureFolder(uid: string, title: string): Promise<void> {
  const status = await grafana.status(`/api/folders/${uid}`);
  if (status === 200) return;
  await grafana.req("POST", "/api/folders", { uid, title });
}

export async function deleteFolder(uid: string): Promise<boolean> {
  if (!uid.startsWith("sw-")) throw new TargetError(`refusing to delete non-Signalworks folder ${uid}`, "validation");
  const status = await grafana.status(`/api/folders/${uid}`);
  if (status === 404) return false;
  await grafana.req("DELETE", `/api/folders/${uid}?forceDeleteRules=true`);
  return true;
}

/** Create or replace a rule (idempotent by uid) and pin its group's evaluation interval. */
export async function upsertRule(spec: RuleSpec): Promise<any> {
  const rule: any = {
    uid: spec.uid,
    title: spec.title,
    ruleGroup: spec.group,
    folderUID: spec.folderUid,
    orgID: 1,
    noDataState: spec.noDataState,
    execErrState: "Error",
    for: `${spec.forSeconds}s`,
    condition: "C",
    labels: spec.labels ?? {},
    data: [
      { refId: "A", relativeTimeRange: { from: 120, to: 0 }, datasourceUid: "sw-prom", model: { refId: "A", expr: spec.expr, instant: true } },
      { refId: "B", datasourceUid: "__expr__", model: { refId: "B", type: "reduce", expression: "A", reducer: "last" } },
      { refId: "C", datasourceUid: "__expr__", model: { refId: "C", type: "threshold", expression: "B", conditions: [{ evaluator: { type: "gt", params: [spec.threshold] } }] } },
    ],
  };
  if (spec.missingSeriesEvalsToResolve) rule.missing_series_evals_to_resolve = spec.missingSeriesEvalsToResolve;
  const exists = (await grafana.status(`/api/v1/provisioning/alert-rules/${spec.uid}`)) === 200;
  const saved = exists
    ? await grafana.req<any>("PUT", `/api/v1/provisioning/alert-rules/${spec.uid}`, rule, NO_PROVENANCE)
    : await grafana.req<any>("POST", "/api/v1/provisioning/alert-rules", rule, NO_PROVENANCE);
  const group = await grafana.req<any>("GET", `/api/v1/provisioning/folder/${spec.folderUid}/rule-groups/${spec.group}`);
  if (group.interval !== spec.intervalSeconds) {
    await grafana.req("PUT", `/api/v1/provisioning/folder/${spec.folderUid}/rule-groups/${spec.group}`,
      { ...group, interval: spec.intervalSeconds }, NO_PROVENANCE);
  }
  return saved;
}

export type InstanceState = { labels: Record<string, string>; state: string; activeAt: string | null; value: string };

/** Current rule health and per-instance states from Grafana's Prometheus-compatible rules API. */
export async function ruleState(uid: string): Promise<{ health: string; lastEvaluation: string | null; instances: InstanceState[] }> {
  const res = await grafana.req<any>("GET", `/api/prometheus/grafana/api/v1/rules?rule_uid=${encodeURIComponent(uid)}`);
  const rule = res.data.groups.flatMap((g: any) => g.rules).find((r: any) => r.uid === uid);
  if (!rule) return { health: "missing", lastEvaluation: null, instances: [] };
  const ev = rule.lastEvaluation && !rule.lastEvaluation.startsWith("0001") ? rule.lastEvaluation : null;
  return {
    health: rule.health,
    lastEvaluation: ev,
    instances: (rule.alerts ?? []).map((a: any) => ({ labels: a.labels, state: a.state, activeAt: a.activeAt ?? null, value: a.value ?? "" })),
  };
}

export type HistoryEntry = { time: string; prev: string; next: string; labels: Record<string, string> };

/** Grafana's own recorded state history for a rule (annotation backend). Read-only; never edited. */
export async function stateHistory(uid: string, fromMs: number): Promise<HistoryEntry[]> {
  const res = await grafana.req<any>("GET", `/api/v1/rules/history?ruleUID=${encodeURIComponent(uid)}&from=${Math.floor(fromMs / 1000)}`);
  const v = res?.data?.values;
  if (!v || !v[0]) return [];
  const out: HistoryEntry[] = [];
  for (let i = 0; i < v[0].length; i++) {
    // Grafana 13.2.4 returns time in microseconds and the instance labels inside the text
    // column ("<title> {k=v, k=v} - <value>"), not as structured fields.
    const raw = Number(v[0][i]);
    const ms = raw > 1e14 ? raw / 1000 : raw;
    const labels: Record<string, string> = {};
    const m = String(v[1][i] ?? "").match(/\{([^}]*)\}/);
    for (const pair of m ? m[1].split(", ") : []) {
      const eq = pair.indexOf("=");
      if (eq > 0) labels[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    out.push({ time: new Date(ms).toISOString(), prev: v[2][i], next: v[3][i], labels });
  }
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

/** Split a Grafana state string like "Normal (MissingSeries)" into state and reason. */
export function splitState(s: string): { state: string; reason: string } {
  const m = s.match(/^(\w+)(?:\s*\((.+)\))?$/);
  return m ? { state: m[1], reason: m[2] ?? "" } : { state: s, reason: "" };
}
