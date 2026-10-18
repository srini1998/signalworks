# Signalworks status

Local-only implementation of graf1 (five modules) and graf2 (FilterProof). Never pushed or hosted, per
the user's instruction. Owner: Claude Code (took over from Codex on 2026-10-18; see
`../delivery/status.md`).

## Implemented (all six modules)

| Module | Real systems | Baseline verified | Agent runs |
|---|---|---|---|
| AlertScenario | Grafana 13.2.4 managed rules, live states, state history | v1 pass; v2/v3 seeded defects; v4 needs a boundary probe | recorded (weak) |
| MetricContract | exporter exposition, Prometheus 3.15.0 ingestion, latency witness | v1 pass, v2–v5 fail with correct invariants | recorded |
| RouteReplay | Grafana notification policies/contact points, webhook sink receipts | v1 pass, v2 matcher typo, v3 grouping (re-verifying with settle + reproduction rule) | recorded |
| SeriesWatch | Prometheus targets/freshness, health probes, inventory and ledger | v1/v2 pass with 4/4 supported cases; v3 stale inventory is inconclusive | recorded |
| DashboardReplay | Grafana dashboards + `/api/ds/query`, frozen window, reference query | r2 pass, r3 scope fail (+37.5%), r4 unit fail, r5 unsupported | recorded |
| FilterProof | Alloy 1.20.1 secretfilter, loki.echo capture, Loki 3.7.8 | control/sampling/stress/label/restart cases executed | recorded |

## Decisions

- **Control plane**: separate local PostgreSQL 14.17 (Homebrew, port 54563) with RLS for `sw_app` (API) and
  `sw_worker`. Breakroom's local Supabase was left untouched. Auth uses scrypt passwords and
  HttpOnly session cookies, with SECURITY DEFINER functions for lookup and sessions.
- **No bind mounts**: the Colima `breakroom` VM does not mount the Mac home folder, so configs are
  baked into small images (Grafana, Prometheus, exporter, sink) or copied with `docker cp` (Alloy).
- **Grafana alert interval is 10 s**: 13.2.4 rejects `min_interval` below its base interval.
- **Sink volume**: the first volume was created root-owned while the sink runs as `node`. The
  sink now mounts `/srv/sink` on a new volume `signalworks-sink-v2`; the old `signalworks-sink`
  volume is unused, not deleted.
- **RouteReplay**: 15 s settle after each policy change (the Editor service account cannot read
  Alertmanager status), and a wrong receiver must reproduce on an identical repeat case.
- **Agent**: once the experiment budget is spent, the model is offered only read-only tools and
  finish, and runs stop after 3 consecutive rejected proposals.

## Bugs found by running the real stack (and fixed)

1. Baseline plan index advanced only on mutating tools, so read-only steps repeated.
2. MetricContract inspected a release before it had traffic, so counters had no series.
3. Sink crashed with EACCES on a root-owned volume.
4. AlertScenario judged bursts by scenario name rather than duration.
5. RouteReplay fired alerts before a new policy was active.
6. Grafana state-history parsing: time is in microseconds, and labels live in the text column.

## Commands that exist

`npm run stack:up|stack:down|stack:status`, `npm run db:up`, `npm run migrate`, `npm run seed`,
`node --import tsx scripts/grafana-setup.ts`, `npm run dev`, `npm run worker`, `npm run web:dev`,
`npm run build`, `npm test`, `npm run smoke -- <module:mode:fixture>...`,
`node --import tsx scripts/verify-recovery.ts`, `npm run browser`, `node --import tsx scripts/report.ts`.

## Completed verification (2026-10-18)

- RouteReplay baselines re-verified with settle + reproduction: v1 pass, v2 matcher typo, v3 grouping.
- Agent comparisons rerun with guardrails (duplicate guard, rejection feedback, read-only after
  budget): 1 of 12 scored agent runs correct vs baseline 25 of 27. See `docs/verification.md`.
- Worker SIGKILL recovery: 4/4 checks (`docs/evidence/recovery.json`).
- Playwright end-to-end flow including 390 px mobile: all checks, zero page errors
  (`docs/evidence/browser-check.json`).
- 16/16 automated tests; migrations 001 and 002 (deadline starts at first claim).

## Open items (not done)

- AlertScenario v4 is missed by the fixed matrix; a boundary-spike probe would catch it but isn't in the baseline.
- Upstream Alloy issue #7293 was not investigated.
- FP-007 (low-variety `swtok_` value not redacted) is an observation; the cause isn't diagnosed.
- Leftovers that need the user's OK to delete: the unused volume `signalworks-sink`, and empty
  directories under `/Users/srinivenigalla/My-Projects/signalworks` inside the Colima VM's own
  filesystem (created by an early bind-mount attempt).
