# Architecture

```
 browser (React/Vite)                     control plane (PostgreSQL 14.17, :54563)
   │  session cookie                        roles: sw_owner (migrations only)
   ▼                                               sw_app    (API; RLS by app.user_id membership)
 API (Express 5, :4400) ── sw_app ──────────────► sw_worker (worker; RLS by app.workspace_id)
   │ queue run (idempotency key)                   SECURITY DEFINER: auth lookup, sessions,
   ▼                                               sw_claim_run (lease), sw_heartbeat
 worker (Node, tsx) ── sw_worker ──┐
   │ lease + heartbeat (30 s)      │ steps, tool_calls (action_id unique), artifacts (sha256), findings
   │ pg_advisory_lock(stack)       │
   ▼                               │
 planner ── baseline: fixed matrix │
        └─ agent: Ollama qwen2.5:3b, schema-constrained AgentAction
   ▼
 executor: validates tool + zod args, budget, per-tool timeout, run deadline, cancellation
   ▼
 module tools ──────────────► systems under test (Colima "breakroom" socket, network signalworks-net)
   ▼                            grafana 13.2.4 :3300   prometheus 3.15.0 :9390   loki 3.7.8 :3100
 deterministic evaluator        exporter (test app, admin API) :9310/:9311   webhook sink :9300
   ▼                            alloy 1.20.1 (per FilterProof case, sw-fp-* containers)
 verdict + findings + evidence bundle
```

## Separation of concerns

- **The model chooses; it never executes.** `agent/planner.ts` asks the local model for one
  `AgentAction` (tool name from an enum, JSON args, short decision summary). `worker/runtime.ts`
  validates it against the module's zod schema and budget. Invalid actions are stored as `rejected`
  tool calls and never executed.
- **The evaluator decides; the model can't.** Each module's `evaluate()` is a pure function of
  recorded observations and the contract. The model never sees `private_faults`. The API role can't
  read that table, and the worker reads it only in offline scoring scripts.
- **Fixed targets.** Every host and port lives in `worker/targets.ts` and `worker/docker.ts`.
  Tool arguments can't name a URL, file path, SQL statement or container. Docker operations are
  limited to creating, starting, logging, restarting and removing `sw-fp-*` containers from one
  pinned image.

## Durable execution

| Concern | Mechanism |
|---|---|
| Claiming | `sw_claim_run` picks `queued`, or `running` with an expired lease, using `FOR UPDATE SKIP LOCKED` |
| Liveness | heartbeat extends the lease every 10 s; lease is 30 s |
| Idempotency | runs: `(workspace_id, idempotency_key)` unique; tool calls: `(run_id, action_id)` unique with deterministic `action_id` |
| Restart | succeeded calls are reused, not re-executed; calls left `running` are reconciled (owned resources removed, call marked interrupted) before the planner decides again |
| Cancellation / deadline | `checkpoint()` before every decision and inside long tools; `cancel_requested` and `deadline_at` on the run |
| Shared stack | one experiment at a time through `pg_advisory_lock(4242)`, since modules drive shared test services |
| Cleanup | only run-owned resources: Grafana folders `sw-<run8>`, `sw-fp-<run8>-*` containers, exporter state reset; RouteReplay restores the previous notification policy |

Status (`queued → running → completed | failed | cancelled`) is separate from verdict
(`pass | fail | inconclusive | unsupported | not_evaluated`). A completed run can prove a defect.
An infrastructure error yields `failed/inconclusive` and is never reported as a domain failure.

## Data model

`workspaces`, `memberships`, `projects` (contract plus hash), `fixture_versions` (public
manifests plus content hash), `private_faults`, `runs` (spec, spec hash, seed, lease, attempts,
deadline, summary), `steps`, `tool_calls`, `artifacts` (JSON plus sha256), `findings` (invariant,
expected, observed, evidence refs, severity, provenance, reproduction ref) and `approvals`. RLS is
enabled on every workspace table for both application roles.
