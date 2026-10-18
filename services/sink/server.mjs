// Local notification webhook sink. Grafana contact points post here instead of email/Slack.
// Every receipt is appended to a JSONL file with the sink's own receive timestamp, so the
// worker can prove actual delivery (or its absence before a deadline).
import fs from "node:fs";
import http from "node:http";

const PORT = Number(process.env.PORT ?? 9300);
const LOG = process.env.SINK_LOG ?? "/srv/sink/receipts.jsonl";
const TOKEN = process.env.SINK_READ_TOKEN ?? "";
fs.mkdirSync(LOG.replace(/\/[^/]+$/, ""), { recursive: true });
let seq = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).length : 0;

http
  .createServer((req, res) => {
    const reply = (code, obj) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(obj));
    const hook = req.url.match(/^\/hook\/([a-z0-9-]{1,40})$/);
    if (req.method === "POST" && hook) {
      let data = "";
      req.on("data", (c) => (data += c.length + data.length < 1_000_000 ? c : ""));
      req.on("end", () => {
        let payload = null;
        try {
          payload = JSON.parse(data);
        } catch {
          payload = { unparsed: data.slice(0, 2000) };
        }
        const receipt = { seq: seq + 1, receiver: hook[1], received_at: new Date().toISOString(), payload };
        try {
          fs.appendFileSync(LOG, JSON.stringify(receipt) + "\n");
        } catch (e) {
          console.error(JSON.stringify({ event: "sink.write_failed", message: e.message }));
          return reply(500, { error: "could not persist receipt" });
        }
        seq = receipt.seq;
        reply(200, { ok: true, seq: receipt.seq });
      });
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/receipts")) {
      if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: "unauthorized" });
      const after = Number(new URL(req.url, "http://x").searchParams.get("after") ?? 0);
      const rows = fs.existsSync(LOG)
        ? fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.seq > after)
        : [];
      return reply(200, { receipts: rows.slice(0, 500), last_seq: seq });
    }
    if (req.url === "/healthz") return reply(200, { ok: true, last_seq: seq });
    reply(404, { error: "not found" });
  })
  .listen(PORT, () => console.log(JSON.stringify({ event: "sink.listening", port: PORT })));
