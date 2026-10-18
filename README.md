# Signalworks: does your monitoring still tell the truth?

A local lab that turns observability promises into contracts and tests them against a **real,
version-pinned Grafana stack**: Grafana OSS 13.2.4, Prometheus 3.15.0, Loki 3.7.8 and Alloy 1.20.1.
Every run records what actually happened as exportable evidence.

Six modules, one workbench:

| Module | The promise it checks | Real system exercised |
|---|---|---|
| **AlertScenario** | "Pages wait 30 s, ignore blips, and never go green when data vanishes" | Grafana-managed alert rules, live instance states, Grafana state history |
| **MetricContract** | "This release kept our metric names, labels, cardinality and units" | Exporter exposition, Prometheus ingestion, a controlled-latency unit witness |
| **RouteReplay** | "Payments alerts reach the payments on-call, grouped, and silences hold" | Grafana notification policies and contact points, real webhook receipts |
| **SeriesWatch** | "When a service goes quiet we know whether it's down, unmonitored or retired" | Prometheus targets and freshness, health probes, an independent inventory |
| **DashboardReplay** | "The edited panel still shows production only, in the same unit" | Grafana dashboards and the datasource query API over a frozen window |
| **FilterProof** | "Secrets never reach Loki, and redaction doesn't eat our logs" | Alloy `loki.secretfilter`, `loki.echo` capture, Loki storage |

Each module page explains the job in plain language with an example. Technical evidence sits one
click below.

## How a run works

1. Pick a **candidate**: the reviewed configuration, or a proposed change (some carry seeded defects).
2. A background **worker** runs real experiments. It creates rules, drives test metrics, fires
   alerts, sends logs, and polls Grafana, Prometheus, Loki and the webhook sink.
3. **Baseline** mode follows a fixed scenario list. **Agent** mode has a local model (Ollama
   `qwen2.5:3b`, free) choose each next experiment from the same tools under the same budget.
4. A **deterministic evaluator**, never the model, compares observations with the contract and
   writes findings with evidence references. You can export a bundle with every input, config hash,
   tool call and artifact.

## Results on the local stack (details in `docs/verification.md`)

Every reviewed candidate passed, and the baseline matrix found every seeded defect except one
(AlertScenario v4, whose shortened pending period a fixed 10 s spike can't reveal):

| Module | Reviewed candidate | Seeded defects detected |
|---|---|---|
| AlertScenario | pass | missing data mapped to OK (v2), pending removed (v3); v4 missed by the fixed matrix |
| MetricContract | pass | missing metric, renamed label, 301-series cardinality, ms-under-seconds (witness ratio ×1000) |
| RouteReplay | pass | matcher typo to default receiver; per-alert grouping |
| SeriesWatch | pass (4/4 cases explained) | unapproved retirement treated as outage; stale inventory is inconclusive |
| DashboardReplay | pass | dropped env filter (+37.5% = staging), per-minute unit; transformation rejected as unsupported |
| FilterProof | n/a (policy run) | sampling bypass (Alloy reports 25 bypassed), label scope, one low-variety token left unredacted |

**Grafana and Alloy behaviors observed on these pinned versions:**
- Grafana 13.2.4 refuses an alert evaluation interval below its 10 s base interval.
- A vanished series stays Alerting for about two evaluations, then resolves as
  `Normal (MissingSeries)`.
- When every series vanishes, a separate no-data instance goes `Pending (NoData) → NoData` through
  the pending period.
- Alloy's `loki.secretfilter` counters reset on restart.
- A custom-rule value like `swtok_abcdefghijklmnopqrstuvwxyz012345` passed unredacted while
  random-looking values were masked. That is recorded as an observation, not a diagnosed defect.

**Agent vs baseline:** the 3B local model is measurably weaker than the fixed matrix. It got
1 of 12 scored agent runs right (RouteReplay v3), against the baseline's 25 of 27. It repeated
identical experiments, skipped preconditions, and kept re-proposing rejected actions. Details and
every recorded decision are in `docs/verification.md`. Crash recovery and the Playwright
end-to-end flow are verified (`docs/evidence/`).

## Run it (free, local)

```bash
cp .env.example .env            # fill with generated values (see comments)
npm install
npm run stack:up                # Grafana, Prometheus, Loki, exporter, sink on 127.0.0.1 (Colima)
npm run db:up && npm run migrate && npm run seed
node --import tsx scripts/grafana-setup.ts   # dedicated Grafana service account token
npm run dev                     # API on http://127.0.0.1:4400
npm run worker                  # in a second terminal
npm run build                   # UI served by the API from dist/ (or `npm run web:dev` on :5180)
```

Sign in as a fictional user (Maya or Omar, separate workspaces). Generated passwords are in
`.local/demo-users.json`.

Checks:

```bash
npm test                                         # domain + RLS security tests
npm run smoke -- metriccontract:baseline:v5      # queue real runs through the API and print verdicts
node --import tsx scripts/verify-recovery.ts     # SIGKILL the worker mid-run, verify reconciliation
npm run browser                                  # Playwright end-to-end flow + mobile layout
```

`npm run stack:down` stops containers without deleting volumes.

## Boundaries

Local only, synthetic fixtures, no real credentials, nothing deployed publicly. Grafana already
provides alert testing, missing-series handling, routing previews and query help. Signalworks adds
repeatable contracts, end-to-end evidence and regression runs around them, and doesn't claim those
features as new. See `docs/limitations.md` and `docs/architecture.md`.
