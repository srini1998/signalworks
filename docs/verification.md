# Verification record

Everything below was observed on this machine. Nothing is simulated or copied from documentation,
and planned items are not listed as verified.

## Environment (recorded 2026-10-18)

| Component | Version / identity |
|---|---|
| macOS | 26.5.2 (Apple silicon) |
| Docker | server 29.5.2 via Colima 0.10.3, profile `breakroom` (4 CPU, 6 GiB) |
| Grafana OSS | `grafana/grafana:13.2.4@sha256:dbbc38ea2110…` (health reports 13.2.4, commit 0e79aef9d91a) |
| Prometheus | `prom/prometheus:v3.15.0@sha256:efd719c99d83…` (buildinfo 3.15.0) |
| Loki | `grafana/loki:3.7.8@sha256:1107dd5274e0…` |
| Alloy | `grafana/alloy:v1.20.1@sha256:2aa2099af76c…` |
| Test services | `node:24-alpine@sha256:44fce696f38b…` (exporter, webhook sink) |
| Control DB | PostgreSQL 14.17 (Homebrew) on 127.0.0.1:54563 |
| Runtime | Node 26.0.0, TypeScript 7.0.2, React 19.3.1, Vite 8.3.4, Express 5.3.0, zod 4.6.7 |
| Model | Ollama 0.40.6, `qwen2.5:3b` (digest 357c53fb659c…), temperature 0, local, $0 |

## Sources consulted (2026-10-17/18)

- Grafana alert-rule provisioning API and Prometheus-compatible rules API: behavior verified by
  calls against 13.2.4 (`/api/v1/provisioning/alert-rules`, `/api/prometheus/grafana/api/v1/rules`,
  `/api/v1/rules/history`).
- Grafana missing data and MissingSeries:
  https://grafana.com/docs/grafana/latest/alerting/guides/missing-data/ (behavior reproduced below).
- Alloy `loki.secretfilter` v1.20:
  https://grafana.com/docs/alloy/v1.20/reference/components/loki/loki.secretfilter/ (GA; arguments
  `rate`, `processing_timeout`, `drop_on_timeout`, `label_timed_out`, `redact_with`,
  `gitleaks_config`; scans log lines only, not labels).
- Supabase × Grafana NYC event context: https://luma.com/supabase-grafana-nyc (from the brief; not re-verified).

## Version behaviors observed (not assumed)

1. Grafana 13.2.4 refuses to start with `GF_UNIFIED_ALERTING_MIN_INTERVAL=5s`: *"value of setting
   'min_interval' should be greater than the base interval (10s)"*.
2. State-history frames carry time in **microseconds**, and instance labels only inside the `text`
   column (`title {k=v, …} - value`).
3. Partial disappearance: a shard removed while Alerting stayed Alerting for about two evaluations
   (20 s), dropped out of the live API, and was recorded as `Alerting → Normal (MissingSeries)`.
4. All series absent with `noDataState=NoData`: a separate no-data instance
   (`datasource_uid`, `ref_id` labels) went `Normal → Pending (NoData) → NoData`, honoring the
   30 s pending period. With `noDataState=OK` every instance reported `Normal (NoData)`.
5. A notification policy saved through the provisioning API was not always active for an alert
   fired immediately afterwards. The worker's Editor service account cannot read Alertmanager status
   (`alert.notifications.system-status:read`), so RouteReplay waits 15 s and requires a mismatch to
   reproduce.
6. Alloy 1.20.1: the custom rule redacted random-looking `swtok_` values, but
   `swtok_abcdefghijklmnopqrstuvwxyz012345` passed **unredacted** in every control case. The cause
   (e.g. a default Gitleaks allowlist or stopword) is **not** diagnosed; it is recorded as an
   observation.
7. Alloy's `loki_secretfilter_*` counters reset when the container restarts (13 processed after
   restart vs 27 delivered), so delivery accounting uses captured output, not the counters.
8. A 5 ms `processing_timeout` never triggered on 60 KB lines (p99 about 4 ms here).

## Automated tests

`npm test`: **16/16 pass**. Covers domain evaluators for all six modules and schema rejection of
malformed agent actions. Security tests run through the ordinary `sw_app` role: cross-workspace read
and write denial, no access to `private_faults`, `users` or `sessions`, empty view without a session,
worker confinement to its workspace, queued-run cancellation, and idempotency-key deduplication.

## Bugs found by running against the real stack

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | Baseline repeated its first read-only step | plan index advanced only on budgeted tools | separate baseline index |
| 2 | Reviewed MetricContract v1 "missing labels" | counters had no series before traffic | deploy seeds steady traffic; witness uses deltas |
| 3 | Webhook sink unreachable | EACCES writing a root-owned volume as `node` | node-owned mount dir on a new volume |
| 4 | 13 s "sustained" breach that fired was not flagged | bursts judged by scenario name | judged by duration |
| 5 | v2 (`noDataState=OK`) passed | `Normal (NoData)` not treated as Normal | base-state comparison |
| 6 | Payments alert sometimes at default receiver | alert fired before new policy active | settle + reproduction rule |
| 7 | Agent proposals rejected for long explanations | 400-char limit on decision summary | truncate, don't reject |
| 8 | Agent burned budget on duplicates and on preconditions | executor accepted identical repeats; precondition failures cost budget | duplicate guard; validation failures don't spend budget |
| 9 | Claimed run waited on the stack lock with an expiring lease | claim happened before the lock | lock before claim |
| 10 | Queued agent runs "failed: deadline exceeded" | deadline counted from creation, including queue wait | migration 002: deadline starts at first claim |

## Seeded-defect results (latest completed run per candidate, after the fixes above)

Scored offline by `scripts/report.ts` against `private_faults`, which the agent and the API role
can't read. The full history of every run, including runs before the fixes, is in
`docs/evidence/runs-table.md` and `docs/evidence/planner-comparison.json`.

| Module | Candidate | Truth | Baseline verdict | Correct |
|---|---|---|---|---|
| AlertScenario | v1-reviewed | clean | pass | yes |
| AlertScenario | v2 | missing data mapped to OK | fail (`missing_data_not_reported_as_recovery`) | yes |
| AlertScenario | v3 | pending removed | fail (`short_spike_does_not_fire`, 10 s spike fired) | yes |
| AlertScenario | v4 | pending shortened to 10 s | pass | **no**: the fixed 10 s spike can't reveal it |
| MetricContract | v1 | clean | pass | yes |
| MetricContract | v2 / v3 / v4 / v5 | missing metric / renamed label / cardinality / ms-as-seconds | fail with the matching invariant each | yes ×4 |
| RouteReplay | v1-reviewed | clean | pass (routing, grouping, silence) | yes |
| RouteReplay | v2 | matcher typo | fail (`routed_to_intended_receiver`, reproduced) | yes |
| RouteReplay | v3 | per-alert grouping | fail (`grouped_by_team`) | yes |
| SeriesWatch | v1 / v2 | four cases / unapproved retirement | pass, 4/4 classifications match truth | yes ×2 |
| SeriesWatch | v3 | stale inventory | inconclusive (required) | yes |
| DashboardReplay | r2 | valid revision | pass | yes |
| DashboardReplay | r3 / r4 | dropped env filter / per-minute unit | fail (+37.5% vs reference / unit opm, ×60) | yes ×2 |
| DashboardReplay | r5 | transformation + unresolved variable | unsupported (rejected before comparison) | yes |
| FilterProof | corpus-v1 | policy run | fail: sampling bypass (25 bypassed, 14 secrets unredacted at rate 0.5), label canaries (documented scope), FP-007 low-variety token | n/a |

Baseline runs created after the matrix-1 fixes (02:58 UTC): **25 of 27 correct**. The two misses
are runs that predate later fixes, both re-run correctly afterwards: RouteReplay v3 before the
policy-settle rule (payments was routed by the previous policy), and AlertScenario v2 before the
`Normal (NoData)` fix. The AlertScenario v4 baseline miss, a known limit of the fixed 10 s probe,
predates that window and is shown in the table above.

## Agent (local qwen2.5:3b) vs baseline, same tools and budget

12 scored agent runs: **1 correct** (RouteReplay v3, where it found the grouping defect with 3
simultaneous payments alerts). The baseline was correct on the same candidates. 40 agent proposals
were rejected by the executor (invalid arguments, duplicates, budget).

Recorded agent behaviors:

- Repeated an identical experiment instead of exploring: 8× `query_series billing` in SeriesWatch,
  2× the same 50 × 50 ms workload in MetricContract.
- Skipped preconditions: called DashboardReplay `execute` before freezing a window.
- Picked weak probes: AlertScenario "sustained" breaches of 5–13 s instead of a spike near the 20 s
  burst limit.
- After the duplicate guard and rejection feedback, it kept re-proposing the rejected action until
  the 3-rejection stop.
- Partial credit not scored: in one v4 run a 60 s sustained breach fired at 18.3 s, below the 20 s
  lower bound, a real symptom of the shortened pending period. Two similar probes fired at 20.3 s
  and 20.5 s, so the signal depends on evaluation alignment.

Conclusion for this setup: **the deterministic matrix is the better planner. The 3B local model
isn't reliable at choosing discriminating experiments.** The agent adapter is real and logged
end to end. A stronger model may behave differently, but that is untested here.

## Durability, isolation, UI

- **Crash recovery** (`docs/evidence/recovery.json`): the worker was SIGKILLed during
  `x2:alertscenario.run_scenario`. A fresh worker reclaimed the run after the 30 s lease (attempt
  2), removed the run's Grafana folder, marked the call interrupted, reused the already-succeeded
  step without repeating it, and completed with verdict pass. All four checks true.
- **Browser** (`docs/evidence/browser-check.json`, Playwright, production build served by the API):
  sign-in, start a real MetricContract v5 run, verdict and `unit_witnessed` finding visible,
  bundle download with SHA-256, keyboard-opened evidence drawer, 390 px mobile layout with no
  horizontal scroll, zero page errors. The expected pre-login 401 probe is excluded.
- **Example bundle**: `docs/evidence/example-bundle.json` (DashboardReplay r3), scanned for
  credential patterns before saving.
