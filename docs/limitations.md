# Limitations and supported scope

**Everything is local and synthetic.** The test services, metrics, alert rules, dashboards and log
corpus are fixtures built for this lab. No production system was probed, and no real credential
appears anywhere (FilterProof values are generated and nonfunctional).

## Per module

- **AlertScenario**: one metric (`sw_queue_depth`) with three shards, Grafana-managed rules with a
  10 s evaluation interval (Grafana 13.2.4's minimum; 5 s was rejected at startup) and a 2 s scrape
  interval. Timing assertions are ranges because polling is 2 s and evaluation alignment varies.
  Short-spike verdicts close to the pending boundary are reported as *not covered by the contract*
  rather than guessed.
- **MetricContract**: units are judged only with the controlled workload witness, and only the
  seconds/milliseconds confusion is classified. Other ratios are reported as undetermined. One
  service and two contracted metrics.
- **RouteReplay**: local webhook receipts only, with no email or Slack. Repeat-interval behavior over
  hours isn't exercised. The notification policy tree is global in Grafana, so the run snapshots and
  restores it. A "no receipt before the deadline" result is not treated as a routing mismatch.
- **SeriesWatch**: the four documented cases only. The classifier relies on an inventory snapshot
  and ledger that are part of the fixture, so it shows the method; it doesn't integrate a real CMDB.
- **DashboardReplay**: direct Prometheus queries, `custom`/`constant` variables with fixed values,
  `timeseries`/`stat` panels, one contracted panel. Transformations, plugins and unresolved variables
  are rejected as unsupported. The orders dataset is a fixed-rate synthetic counter.
- **FilterProof**: Alloy 1.20.1 `loki.secretfilter` with the default Gitleaks rules plus one
  custom rule, corpus-v1 (31 fixtures). Verdicts hold for that corpus, policy, version and config
  hash, and aren't a certification of secret detection. Throughput and CPU numbers describe this
  laptop. The 5 ms processing-timeout case did not time out on 60 KB lines here. Alloy's internal
  counters reset on container restart, so delivery accounting uses the captured output, not the
  counters. Upstream issue #7293 was **not** investigated or reproduced.

## Agent

The agent is a 3B local model (`qwen2.5:3b`) with no fine-tuning. Its choices are often weaker
than the fixed matrix (see `docs/verification.md`). It is reported as measured, not presented as
an improvement. Cost is $0 (local inference); token counts are recorded per run.

## Not done

- Supabase was not used for the control plane. The spec suggests Supabase/Postgres; this lab uses a
  separate local Postgres with RLS to stay independent of Breakroom's local Supabase instance.
- No public deployment, by design. The user asked for Grafana work to stay local.
