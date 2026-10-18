# Gaming signals

The main UI uses actual public Valve Steam player counts for Counter-Strike 2 (730), Dota 2 (570), Apex Legends (1172470). scripts/capture-steam.py captures a clearly timestamped snapshot. The GET-only /api/steam endpoint refreshes the fixed three-game allowlist without a key, validates nonnegative integer counts, applies eight-second upstream timeouts, uses a five-minute CDN cache and explicitly reports failures without replacing them with zero. Offline players are excluded. This independent portfolio is not affiliated with Valve. Player counts do not establish service health.

Counts are converted to Prometheus gauge samples. Cards read the current text, including visitor edits. The checker expects game/appid labels. “Try a broken label” removes one appid from the recorded snapshot and is explicitly a deliberate fault fixture. The existing PromLabs service example and six-module real local Grafana/Prometheus/Loki/Alloy lab remain accessible. Local-lab recorded evaluation is separate from browser text checks.

Plain deterministic findings appear immediately. Optional cloud-generated prose is secondary, unverified and disabled without a confirmed Groq Free Plan key. Generating an explanation sends that task's metric findings to the provider. No key/billing/paid fallback or model download was configured.

Checks: 12 parser/contract regressions, game valid/broken-label, GET-only/API upstream schema/cache fixtures, actual Chrome refresh through the real Steam API handler, both examples, invalidation, English-only/390px, zero weight downloads. HTTP fixtures are labeled mocked; the browser refresh uses actual Steam responses.
