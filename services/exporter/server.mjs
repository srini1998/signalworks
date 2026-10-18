// Controlled test exporter for Signalworks. It is the system under test's "application":
// several virtual services, each with a Prometheus /metrics endpoint and an HTTP /health
// endpoint, whose behavior the worker drives through an admin API on a separate port.
// Nothing here talks to the internet. All values are synthetic and labeled as such.
import http from "node:http";

const PORT = Number(process.env.PORT ?? 9310);
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 9311);
const ADMIN_TOKEN = process.env.EXPORTER_ADMIN_TOKEN ?? "";

/** Per-service state. `metrics`: ok | error (HTTP 500) | absent (404). `health`: ok | down. */
const services = new Map();
const defaults = () => ({
  metrics: "ok",
  health: "ok",
  queue: { a: 5, b: 5, c: 5 }, // sw_queue_depth by shard; a missing key removes that series
  release: "v1",
  durations: [], // observed request durations in the release's *declared* unit
  requests: {}, // "route|status" -> count
  cardinality_users: 0,
});
for (const name of ["checkout", "search", "billing", "legacy-report", "payments"]) services.set(name, defaults());
// "orders" is a fixed-rate dataset for DashboardReplay: counters grow at constant, known rates per
// environment and region, so any frozen past window has exactly known values.
const STARTED = Date.now();
const ORDER_RATES = { production: { eu: 3, us: 5 }, staging: { eu: 1, us: 2 } };
services.set("orders", defaults());

const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 50, 100, 250, 500, 1000, 2500];

function render(name, s) {
  const out = [];
  const L = (labels) => Object.entries(labels).map(([k, v]) => `${k}="${esc(v)}"`).join(",");
  if (name === "orders") {
    const elapsed = (Date.now() - STARTED) / 1000;
    out.push("# HELP sw_orders_total Orders placed (synthetic fixed-rate dataset).");
    out.push("# TYPE sw_orders_total counter");
    for (const [env, regions] of Object.entries(ORDER_RATES))
      for (const [region, rate] of Object.entries(regions)) out.push(`sw_orders_total{${L({ env, region })}} ${Math.floor(rate * elapsed)}`);
    return out.join("\n") + "\n";
  }
  out.push("# HELP sw_queue_depth Items waiting in the service queue (synthetic).");
  out.push("# TYPE sw_queue_depth gauge");
  for (const [shard, v] of Object.entries(s.queue)) out.push(`sw_queue_depth{${L({ service: name, shard })}} ${v}`);

  // MetricContract releases. v1 is the reviewed contract; the others are candidate regressions.
  const statusLabel = s.release === "v3-renamed-label" ? "code" : "status";
  if (s.release !== "v2-missing-metric") {
    out.push("# HELP sw_requests_total Requests handled.");
    out.push("# TYPE sw_requests_total counter");
    for (const [key, count] of Object.entries(s.requests)) {
      const [route, status] = key.split("|");
      out.push(`sw_requests_total{${L({ service: name, route, [statusLabel]: status })}} ${count}`);
    }
    if (s.release === "v4-cardinality") {
      for (let i = 0; i < s.cardinality_users; i++)
        out.push(`sw_requests_total{${L({ service: name, route: "/pay", status: "200", user_id: `u${i}` })}} 1`);
    }
  }
  out.push("# HELP sw_request_duration_seconds Request latency.");
  out.push("# TYPE sw_request_duration_seconds histogram");
  let cum = 0;
  const sorted = [...s.durations].sort((a, b) => a - b);
  for (const b of BUCKETS) {
    while (cum < sorted.length && sorted[cum] <= b) cum++;
    out.push(`sw_request_duration_seconds_bucket{${L({ service: name, le: b })}} ${cum}`);
  }
  out.push(`sw_request_duration_seconds_bucket{${L({ service: name, le: "+Inf" })}} ${sorted.length}`);
  out.push(`sw_request_duration_seconds_sum{${L({ service: name })}} ${sorted.reduce((a, b) => a + b, 0)}`);
  out.push(`sw_request_duration_seconds_count{${L({ service: name })}} ${sorted.length}`);
  return out.join("\n") + "\n";
}

http
  .createServer((req, res) => {
    const m = req.url.match(/^\/svc\/([a-z-]+)\/(metrics|health)$/);
    const s = m && services.get(m[1]);
    if (!s) return res.writeHead(404).end("unknown service\n");
    if (m[2] === "health") {
      if (s.health === "down") return res.writeHead(503).end("down\n");
      return res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    }
    if (s.metrics === "error") return res.writeHead(500).end("exporter failure\n");
    if (s.metrics === "absent" || s.health === "down") return res.writeHead(404).end("gone\n");
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(render(m[1], s));
  })
  .listen(PORT, () => console.log(JSON.stringify({ event: "exporter.listening", port: PORT })));

const body = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 65536) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });

const ALLOWED_RELEASES = new Set(["v1", "v2-missing-metric", "v3-renamed-label", "v4-cardinality", "v5-milliseconds"]);

http
  .createServer(async (req, res) => {
    const reply = (code, obj) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(obj));
    if (ADMIN_TOKEN && req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return reply(401, { error: "unauthorized" });
    try {
      if (req.method === "GET" && req.url === "/admin/state")
        return reply(200, Object.fromEntries([...services].map(([k, v]) => [k, { ...v, durations: v.durations.length }])));
      const m = req.url.match(/^\/admin\/svc\/([a-z-]+)\/(state|workload|reset)$/);
      const s = m && services.get(m[1]);
      if (!s || req.method !== "POST") return reply(404, { error: "unknown admin route" });
      const b = await body(req);
      if (m[2] === "reset") {
        services.set(m[1], defaults());
        return reply(200, { ok: true });
      }
      if (m[2] === "state") {
        if (b.metrics && !["ok", "error", "absent"].includes(b.metrics)) return reply(422, { error: "metrics" });
        if (b.health && !["ok", "down"].includes(b.health)) return reply(422, { error: "health" });
        if (b.release && !ALLOWED_RELEASES.has(b.release)) return reply(422, { error: "release" });
        if (b.queue && (typeof b.queue !== "object" || Object.values(b.queue).some((v) => typeof v !== "number")))
          return reply(422, { error: "queue" });
        if (b.cardinality_users !== undefined && !(Number.isInteger(b.cardinality_users) && b.cardinality_users <= 2000))
          return reply(422, { error: "cardinality_users" });
        Object.assign(s, Object.fromEntries(Object.entries(b).filter(([k]) => ["metrics", "health", "queue", "release", "cardinality_users"].includes(k))));
        return reply(200, { ok: true, state: { ...s, durations: s.durations.length } });
      }
      // Known request workload: n requests with a fixed true latency. The exporter records each in
      // the unit its release *actually* uses, which is how a seconds->milliseconds drift appears.
      const n = Math.min(Number(b.requests ?? 0), 1000);
      const trueSeconds = Number(b.latency_ms ?? 0) / 1000;
      if (!(n > 0 && trueSeconds > 0 && trueSeconds < 30)) return reply(422, { error: "workload" });
      const recorded = s.release === "v5-milliseconds" ? trueSeconds * 1000 : trueSeconds;
      for (let i = 0; i < n; i++) s.durations.push(recorded);
      const key = `/pay|200`;
      s.requests[key] = (s.requests[key] ?? 0) + n;
      return reply(200, { ok: true, requests: n, true_latency_seconds: trueSeconds });
    } catch (e) {
      return reply(400, { error: e.message });
    }
  })
  .listen(ADMIN_PORT, () => console.log(JSON.stringify({ event: "exporter.admin.listening", port: ADMIN_PORT })));
