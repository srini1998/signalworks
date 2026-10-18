// Clients for the local systems under test. Every URL is fixed here; nothing a user or the
// model supplies can change the host, so tools cannot be pointed at arbitrary targets.
import "dotenv/config";

const GRAFANA = "http://127.0.0.1:3300";
const PROMETHEUS = "http://127.0.0.1:9390";
const EXPORTER_ADMIN = "http://127.0.0.1:9311";
const EXPORTER = "http://127.0.0.1:9310";
const SINK = "http://127.0.0.1:9300";

export class TargetError extends Error {
  constructor(message: string, readonly category: "infrastructure" | "timeout" | "validation" = "infrastructure") {
    super(message);
  }
}

async function call(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? 8000);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    throw new TargetError(`${new URL(url).host} unreachable: ${(e as Error).message}`, (e as Error).name === "AbortError" ? "timeout" : "infrastructure");
  } finally {
    clearTimeout(timer);
  }
}

async function json<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new TargetError(`${what}: HTTP ${res.status} ${text.slice(0, 300)}`, res.status >= 400 && res.status < 500 ? "validation" : "infrastructure");
  return (text ? JSON.parse(text) : {}) as T;
}

const grafanaAuth = () => {
  const token = process.env.GRAFANA_SA_TOKEN;
  if (token) return `Bearer ${token}`;
  return "Basic " + Buffer.from(`admin:${process.env.GRAFANA_ADMIN_PASSWORD}`).toString("base64");
};

export const grafana = {
  async req<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await call(`${GRAFANA}${path}`, {
      method,
      headers: { Authorization: grafanaAuth(), "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return json<T>(res, `grafana ${method} ${path}`);
  },
  health: () => call(`${GRAFANA}/api/health`).then((r) => json<{ version: string; database: string }>(r, "grafana health")),
  async status(path: string): Promise<number> {
    const res = await call(`${GRAFANA}${path}`, { headers: { Authorization: grafanaAuth() } });
    await res.text();
    return res.status;
  },
};

export type PromSample = { metric: Record<string, string>; value?: [number, string]; values?: [number, string][] };

export const prometheus = {
  async query(q: string, time?: number): Promise<PromSample[]> {
    const p = new URLSearchParams({ query: q, ...(time ? { time: String(time) } : {}) });
    const r = await json<{ data: { result: PromSample[] } }>(await call(`${PROMETHEUS}/api/v1/query?${p}`), "prometheus query");
    return r.data.result;
  },
  async range(q: string, start: number, end: number, step: number): Promise<PromSample[]> {
    const p = new URLSearchParams({ query: q, start: String(start), end: String(end), step: String(step) });
    const r = await json<{ data: { result: PromSample[] } }>(await call(`${PROMETHEUS}/api/v1/query_range?${p}`), "prometheus range");
    return r.data.result;
  },
  async metadata(metric?: string): Promise<Record<string, { type: string; help: string; unit: string }[]>> {
    const p = metric ? `?metric=${encodeURIComponent(metric)}` : "";
    return (await json<{ data: Record<string, { type: string; help: string; unit: string }[]> }>(await call(`${PROMETHEUS}/api/v1/metadata${p}`), "prometheus metadata")).data;
  },
  async targets(): Promise<{ labels: Record<string, string>; health: string; lastError: string; lastScrape: string }[]> {
    return (await json<{ data: { activeTargets: { labels: Record<string, string>; health: string; lastError: string; lastScrape: string }[] } }>(
      await call(`${PROMETHEUS}/api/v1/targets?state=active`), "prometheus targets")).data.activeTargets;
  },
  buildinfo: async () => (await json<{ data: { version: string } }>(await call(`${PROMETHEUS}/api/v1/status/buildinfo`), "prometheus buildinfo")).data,
};

export const SERVICES = ["checkout", "search", "billing", "legacy-report", "payments"] as const;
const adminHeaders = () => ({ Authorization: `Bearer ${process.env.EXPORTER_ADMIN_TOKEN}`, "Content-Type": "application/json" });

export const exporter = {
  async setState(service: string, state: Record<string, unknown>) {
    if (!(SERVICES as readonly string[]).includes(service)) throw new TargetError(`service ${service} is not allowlisted`, "validation");
    return json(await call(`${EXPORTER_ADMIN}/admin/svc/${service}/state`, { method: "POST", headers: adminHeaders(), body: JSON.stringify(state) }), "exporter state");
  },
  async reset(service: string) {
    return json(await call(`${EXPORTER_ADMIN}/admin/svc/${service}/reset`, { method: "POST", headers: adminHeaders(), body: "{}" }), "exporter reset");
  },
  async workload(service: string, requests: number, latencyMs: number) {
    return json<{ true_latency_seconds: number }>(await call(`${EXPORTER_ADMIN}/admin/svc/${service}/workload`, {
      method: "POST", headers: adminHeaders(), body: JSON.stringify({ requests, latency_ms: latencyMs }) }), "exporter workload");
  },
  /** Raw scrape of one service's exposition text (bounded). */
  async scrape(service: string): Promise<{ status: number; text: string }> {
    const res = await call(`${EXPORTER}/svc/${service}/metrics`);
    const text = (await res.text()).slice(0, 200_000);
    return { status: res.status, text };
  },
  /** Allowlisted application health probe. */
  async health(service: string): Promise<{ status: number; ok: boolean }> {
    if (!(SERVICES as readonly string[]).includes(service)) throw new TargetError(`service ${service} is not allowlisted`, "validation");
    const res = await call(`${EXPORTER}/svc/${service}/health`, { timeoutMs: 3000 });
    await res.text();
    return { status: res.status, ok: res.ok };
  },
};

export type Receipt = { seq: number; receiver: string; received_at: string; payload: any };
export const sink = {
  async receipts(after = 0): Promise<{ receipts: Receipt[]; last_seq: number }> {
    return json(await call(`${SINK}/receipts?after=${after}`, { headers: { Authorization: `Bearer ${process.env.SINK_READ_TOKEN}` } }), "sink receipts");
  },
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `probe` until `done` or the deadline; never a fixed sleep standing in for an observation. */
export async function pollUntil<T>(probe: () => Promise<T>, done: (v: T) => boolean, opts: { timeoutMs: number; intervalMs: number; onTick?: (v: T) => void }): Promise<{ value: T; met: boolean }> {
  const end = Date.now() + opts.timeoutMs;
  let value = await probe();
  while (!done(value) && Date.now() < end) {
    opts.onTick?.(value);
    await sleep(opts.intervalMs);
    value = await probe();
  }
  return { value, met: done(value) };
}
