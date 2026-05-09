# DelegateAgent Runtime Monitoring — Prometheus + Grafana Integration

## 1. Requirements Summary

Wire DelegateAgent's host process and container lifecycle into the existing
`delegate-core` Prometheus + Grafana stack so that liveness, throughput, queue
depth, container churn, and error-rate signals are observable alongside Caddy,
ClickHouse, Supabase, and the droplet itself. This is purely runtime telemetry
— LLM cost analytics already live in `deploy/token-dashboard/` and remain
out of scope. Sentry cron-monitor heartbeats stay; Prometheus is additive.

The work spans two repos:

- **DelegateAgent** (`/Volumes/Projects/Delegate/DelegateAgent/`): expose
  `/metrics` on the existing group-api listener (port 3001 by default,
  overridable via `GROUP_API_PORT`), wire the ring-buffered container-telemetry
  recorder into `container-runner.ts`, and emit counters/gauges from queue,
  dispatch, channel-poll, JWT-mint, and credential-resolution code paths.
- **delegate-core / Delegate repo** (`/Volumes/Projects/Delegate/deploy/`):
  add a Prometheus scrape job for DelegateAgent reachable across hosts,
  provision a Grafana dashboard, and add an alert-rule group covering
  process-down, container crash rate, queue saturation, and channel poll error
  rate.

## 2. Preconditions

- DA host is the production droplet at `agent.delegate.ws` (Caddy already
  terminates TLS for it — verified in
  `/Volumes/Projects/Delegate/DelegateAgent/deploy/Caddyfile`).
- DA host runs ntpd / chronyd / native macOS time sync (default).
  Histograms and `process_start_time_seconds`-derived uptime depend on a
  monotonic, well-synced clock.
- delegate-core droplet runs Prometheus 2.x with file-based credentials
  support (`authorization.credentials_file`), Grafana 11 with
  `provisioning/dashboards/dashboards.yml` and
  `provisioning/alerting/rules.yaml` already wired (see existing droplet /
  ClickHouse dashboards as the model).
- Local-dev laptop (Henry's Mac) is **invisible** to core-droplet Prometheus.
  `/metrics` on a dev laptop is local-only; production scrape job's
  `static_configs.targets` contains ONLY `agent.delegate.ws:443`.

## 3. Acceptance Criteria

A1. `curl -sf -H "Authorization: Bearer $DELEGATE_AGENT_TOKEN" http://localhost:${GROUP_API_PORT:-3001}/metrics`
on the DA host returns HTTP 200 with a valid Prometheus exposition body
containing at least the following metric families:

- `delegate_agent_container_spawned_total`
- `delegate_agent_container_duration_seconds_bucket`
- `delegate_agent_containers_active`
- `delegate_agent_queue_depth`
- `delegate_agent_messages_processed_total`
- `delegate_agent_chat_fastpath_total`
- `delegate_agent_idle_timeout_total`
- `delegate_agent_credentials_resolved_total`
- `delegate_agent_credentials_attempt_total`
- `delegate_agent_jwt_mint_total`
- `delegate_agent_channel_poll_errors_total`
- `delegate_agent_channel_messages_delivered_total`
- `delegate_agent_ipc_messages_processed_total`
- `delegate_agent_session_resumes_total`
- Standard `process_*` and `nodejs_*` families from `collectDefaultMetrics()`
  (prefixed `delegate_agent_node_`).

(There is no `delegate_agent_up` gauge; absolute liveness is taken from
Prometheus' built-in `up{job="delegate-agent"}` series.)

A2. In the delegate-core Prometheus UI (`/targets`), the `delegate-agent`
job shows `state=UP` with `scrape_duration_seconds < 1` and the
`host="delegate-agent-prod"` label attached.

A3. In Grafana, a `Delegate Agent` dashboard renders without "No data" panels
when DelegateAgent is processing at least one message. It includes:

- Liveness / uptime panel (built from `up{job="delegate-agent"}` and
  `time() - process_start_time_seconds{job="delegate-agent"}`)
- Active containers (gauge)
- Container spawn rate (per-second by `jid_kind`)
- Container exit-status pie (success / timeout / error)
- p50 / p95 container duration (histogram heatmap)
- Queue depth per `jid_kind` (messages and tasks)
- Fast-path hit ratio
- Channel poll error rate by channel
- Channel messages delivered rate by channel
- JWT-mint failure rate
- Credential resolution tier breakdown (resolved + per-tier attempt outcomes)

A4. Alert group `DelegateAgent` is provisioned in Grafana 11 and contains
at minimum:

- `DelegateAgentProcessDown` — `up{job="delegate-agent",host="delegate-agent-prod"} == 0`
  for 2m, severity=critical, `noDataState: OK`.
- `DelegateAgentContainerCrashRateHigh` — error/timeout exits exceed 20% of
  spawns over 5m, for 2m dampening, severity=warning, `noDataState: OK`.
- `DelegateAgentQueueDepthSaturated` — any `jid_kind` × `kind` queue depth
  exceeds 25 for 5m, severity=warning, `noDataState: OK`.
- `DelegateAgentChannelPollErrors` — channel poll error rate exceeds 0.1/s
  for 5m, severity=warning, `noDataState: OK`.

A5a. Ring buffer populated. Opening the existing admin UI at
`http://<da-host>:${GROUP_API_PORT:-3001}/admin/partials/containers` and
triggering the workload of V3 shows the new entry in the
`Container Telemetry` panel within 5 seconds (proves
`recordContainerStart/End` are now actually called).

A5b. Prometheus counters increment on the same workload:
`delegate_agent_container_spawned_total` and
`delegate_agent_container_duration_seconds_count` both rise by 1 (observable
via `curl /metrics | grep`).

A6. `make -f deploy/Makefile.core targets` reports the `delegate-agent` job
healthy.

A7. Sentry cron-monitor heartbeat for the delegate channel
(`CRON_SLUG = 'delegate-agent-poll'`) still fires (no regression).

## 4. File-By-File Changes

### 4.1 DelegateAgent — new dependency

**`/Volumes/Projects/Delegate/DelegateAgent/package.json`**

- Add `prom-client@15.1.3` to `dependencies` (exact pin).
  `prom-client` is the de-facto Node Prometheus library, MIT-licensed, no
  native deps, ~30 KB. Lock with
  `npm install prom-client@15.1.3 --save-exact` to keep deterministic builds.

### 4.2 DelegateAgent — metrics module (NEW)

**`/Volumes/Projects/Delegate/DelegateAgent/src/metrics.ts`** (new file)

Responsibilities:

- Construct a **custom** `Registry` (NOT `prom-client`'s default global
  registry). Export it as `metricsRegistry`.
- **Hot-reload safe.** On module load, when
  `process.env.NODE_ENV !== 'production'`, call `metricsRegistry.clear()`
  before constructing metrics. This handles `tsx --watch` / `nodemon`
  reloads that re-import the module without restarting the process and would
  otherwise throw "metric already registered".
- Call `collectDefaultMetrics({ register: metricsRegistry, prefix: 'delegate_agent_node_' })`
  for process / event-loop / GC metrics.
- Define and export every metric in the catalog (§5) on the custom registry,
  with explicit label names and bucket arrays for histograms.
- Export `metricsHandler(req, res)`: writes
  `metricsRegistry.contentType` header, streams `await metricsRegistry.metrics()`.
- Export typed convenience functions; **all of them MUST route
  through a private `safeMetric` wrapper.** Public surface:

  - `recordContainerSpawn(jidKind, isMain)`
  - `recordContainerExit(jidKind, status, durationSeconds)` —
    decrements active gauge, observes histogram
  - `setQueueDepth(jidKind, kind, depth)`
  - `recordMessageDelivered(channel)` — see Architect answer #3
  - `recordFastpath(outcome)`
  - `recordIdleTimeout(jidKind)`
  - `recordCredentialResolution(tier)` — winner-takes-all per
    `buildContainerArgs` call
  - `recordCredentialAttempt(tier, outcome)` — see catalog §5
  - `recordJwtMint(outcome)`
  - `recordChannelPollError(channel, kind)` — `kind ∈ {http_4xx, http_5xx, network, timeout, parse}`
  - `recordIpcMessage(type)`
  - `recordSessionResume(jidKind)`

- Export the **`jidKind(jid: string): JidKind` helper.**
  Derives the bounded enum
  `'main' | 'delegate_task' | 'delegate_conv' | 'delegate_agent' | 'whatsapp' | 'telegram' | 'slack' | 'discord' | 'gmail' | 'unknown'`
  from the JID prefix (e.g., `delegate:task:abc123` → `delegate_task`,
  `whatsapp:1234@s.whatsapp.net` → `whatsapp`, bare group folder `main` →
  `main`). Anything unrecognised maps to `'unknown'` and the metrics module
  logs a warning once per unrecognised prefix per process lifetime.
- Honor `DELEGATE_AGENT_METRICS_DISABLED=1` to short-circuit all
  `record*` / `set*` functions to no-ops AND make `/metrics` return 404.

`safeMetric` contract:

```ts
function safeMetric(fn: () => void): void {
  if (process.env.DELEGATE_AGENT_METRICS_DISABLED === '1') return;
  try { fn(); } catch (err) {
    logger.warn({ err }, 'metric emission failed');
  }
}
```

Every public `record*` / `set*` body is a single `safeMetric(() => { ... })`
call. **No direct `.inc()` / `.observe()` / `.set()` calls anywhere outside
this module.** Add to the code-review checklist:

> No direct `.inc()`/`.observe()`/`.set()` calls outside `src/metrics.ts`.

### 4.3 DelegateAgent — expose `/metrics`

**`/Volumes/Projects/Delegate/DelegateAgent/src/group-api.ts`**

Add a route handler before the existing `/admin` block. The endpoint MUST be
authenticated with the same bearer-token middleware that already gates
`/admin/*` and `/api/admin/*`. Reuse — do not duplicate — the existing
`requireAuth` helper. Route signature:

```
GET /metrics
  → 401 if Authorization header missing/invalid
  → 200 text/plain; version=0.0.4; charset=utf-8
  → body: await metricsRegistry.metrics()
```

No `delegate_agent_up` gauge is exported. Liveness is taken from
Prometheus' built-in `up{job="delegate-agent"}` series.

### 4.4 DelegateAgent — wire container telemetry + metrics

**`/Volumes/Projects/Delegate/DelegateAgent/src/container-runner.ts`**

The relevant block lives in `runContainerAgent()` (~L425–L820). There are
exactly TWO terminal event handlers in the existing code:

1. `container.on('close', (code, signal) => { ... })` — covers normal exits,
   non-zero exits, and the timeout-kill path (kills flow through `close` with
   `timedOut=true`).
2. `container.on('error', (err) => { ... })` — covers spawn failures
   (image missing, exec error before the process attaches).

There is NO separate "killed" handler.

Status enum is aligned with the existing
`web-ui/container-telemetry.ts:19` enum:
**`'success' | 'error' | 'timeout'`** (no `'killed'`).

**Reuse the existing `startTime = Date.now()` (line 431).** Do NOT introduce
`process.hrtime.bigint()`.

Edits:

1. Just before `spawn(...)` (~L477), call:
   - `recordContainerStart({ groupFolder, isMain, sessionId, startedAt: startTime })`
     from `web-ui/container-telemetry.ts`
   - `recordContainerSpawn(jidKind(groupFolder), isMain)` from `src/metrics.ts`
2. Inside `container.on('close', ...)`:
   - Compute `durationSeconds = (Date.now() - startTime) / 1000`.
   - Determine `status`:
     - if `timedOut === true` → `'timeout'`
     - else if `code === 0` OR `hadStreamingOutput` (existing variable in
       this scope, treat as "useful work was produced") → `'success'`
     - else → `'error'`
   - Call `recordContainerEnd({ id, status, exitCode: code, endedAt: Date.now() })`
   - Call `recordContainerExit(jidKind(groupFolder), status, durationSeconds)`
3. Inside `container.on('error', ...)`:
   - Compute `durationSeconds = (Date.now() - startTime) / 1000`.
   - status is unconditionally `'error'`.
   - Same two `recordContainerEnd` / `recordContainerExit` calls.

Important: do NOT label metrics with per-container ID, session ID, PID, or
group-folder name. `jid_kind` is the bounded label. Per-group debugging is
handled by the admin UI ring buffer + SQLite, not Prometheus.

### 4.5 DelegateAgent — queue, dispatch, channel, JWT, credentials wire-ins

**`/Volumes/Projects/Delegate/DelegateAgent/src/group-queue.ts`**

- Where `pendingMessages`, `pendingTasks`, `activeCount` are mutated, call
  `setQueueDepth(jidKind(group), 'messages', pendingMessages.length)` and
  the equivalent for tasks. Emit on every change (cheap; gauge `.set` is
  O(1)).
- `delegate_agent_containers_active` is owned exclusively by
  `container-runner.ts` (increment on spawn, decrement in close/error
  branches). Queue is a separate concern and does not touch this gauge.

**`/Volumes/Projects/Delegate/DelegateAgent/src/chat/dispatch.ts`** and
**`/Volumes/Projects/Delegate/DelegateAgent/src/chat/heuristic.ts`**

- Where the heuristic returns hit/miss/skip, call
  `recordFastpath(outcome)`. Outcome label values must be a closed set:
  `'hit' | 'miss' | 'skip-cooldown' | 'skip-tool-required' | 'skip-multi-turn'`
  (or whatever finite set the existing classifier emits — confirm at
  implementation time, do not invent new label values).

**`/Volumes/Projects/Delegate/DelegateAgent/src/index.ts`**

- In `runAgent()` (~L345): when an idle-timeout terminates the agent, call
  `recordIdleTimeout(jidKind(group))`.
- When a session resumes from disk vs starts fresh, call
  `recordSessionResume(jidKind(group))`.

**Channel error / delivery wiring — per-channel emission (Architect answer #3).**
There is NO registry-level wrapper. Each channel skill emits its own metric
calls, and the reference implementation is in
`src/channels/delegate.ts`:

- In the catch block of the polling loop in `delegate.ts`, call
  `recordChannelPollError('delegate', kind)` where `kind` is derived from
  the error (HTTP status range / `ECONNRESET` / `AbortError` etc.).
- On every successful inbound message dispatched downstream, call
  `recordChannelMessageDelivered('delegate')`.
- Leave the existing Sentry cron-monitor heartbeat alone — both
  Prometheus and Sentry are kept (intentional double-instrumentation; see
  R7 / R12).

Other channel skills (whatsapp, telegram, slack, discord, gmail) are
NOT modified in this PR. They will be updated in their own follow-ups by
their owners; branches that don't update will simply produce no metric for
that channel, which is fine. CONTRIBUTING.md gets a `SHOULD` addendum in a
follow-up doc-only PR (NOT in this PR — keep scope tight).

**`/Volumes/Projects/Delegate/DelegateAgent/src/jwt-mint.ts`**

- On successful mint: `recordJwtMint('success')`.
- On HTTP / signing failure: `recordJwtMint('failure')`.

**`/Volumes/Projects/Delegate/DelegateAgent/src/credential-client.ts`**

- After resolution returns, call
  `recordCredentialResolution(tier)` where
  `tier ∈ {workspace, onecli, static, none}` — winner-takes-all (one
  increment per `buildContainerArgs` call).
- For each credential lookup attempt during the same call, also call
  `recordCredentialAttempt(tier, outcome)` per the catalog §5 enum.
  OneCLI hit/miss is genuinely unobservable from the SDK boolean — emit
  `success | unavailable | skipped`, do not fabricate a `miss` outcome.

**`/Volumes/Projects/Delegate/DelegateAgent/src/ipc.ts`**

- For each IPC message type processed, call `recordIpcMessage(type)`.
  Bound the `type` label to the existing closed set in this file's switch
  statement; if a new type appears, alert review will catch it.

### 4.6 DelegateAgent — env-flag escape hatch

Already documented in §4.2: `DELEGATE_AGENT_METRICS_DISABLED=1`.

### 4.7 DelegateAgent — systemd / launchd unchanged

`deploy/delegate-agent.service` and `launchd/*.plist` need no changes; the
new endpoint lives on the same listener. Document the env vars in the
service unit's adjacent `.env` template if one exists in the deploy/
directory — otherwise just call it out in the runbook.

### 4.8 delegate-core — Prometheus scrape job

**`/Volumes/Projects/Delegate/deploy/grafana/prometheus.yml`**

Add a new job. Final shape:

```yaml
- job_name: 'delegate-agent'
  scrape_interval: 30s
  scrape_timeout: 10s
  metrics_path: /metrics
  scheme: https
  authorization:
    type: Bearer
    credentials_file: /etc/prometheus/delegate-agent.token
  static_configs:
    - targets: ['agent.delegate.ws:443']
  relabel_configs:
    - target_label: host
      replacement: 'delegate-agent-prod'
```

Notes:

- `scheme: https` and the production hostname `agent.delegate.ws` are
  required — that's the actual public DNS record (verified in the DA
  Caddyfile).
- `host="delegate-agent-prod"` is **mandatory** so alert PromQL can scope
  `up{job="delegate-agent",host="delegate-agent-prod"} == 0` and prevent
  any future staging instance from polluting prod alerts.
- `authorization.credentials_file` is re-read by Prometheus 2.x on every
  scrape — no SIGHUP needed when the token rotates.
- Local-dev laptops are deliberately NOT in `static_configs.targets`. The
  `/metrics` endpoint on a laptop is local-only; core-droplet Prometheus
  cannot reach it, by design.

### 4.9 delegate-core — compose update

**`/Volumes/Projects/Delegate/deploy/docker-compose.grafana.yml`**

- Mount the secret file read-only into prometheus:
  `./prometheus-secrets/delegate-agent.token:/etc/prometheus/delegate-agent.token:ro`
- No new container required.

**`/Volumes/Projects/Delegate/deploy/.gitignore`** (or whichever .gitignore
is closest to the secrets dir): add `prometheus-secrets/` so the bearer
token is never committed.

### 4.10 DA host — Caddy reverse proxy for `/metrics`

**`/Volumes/Projects/Delegate/DelegateAgent/deploy/Caddyfile`** (NOT the
parent Delegate repo's `deploy/Caddyfile` — that's a different file).

The DA Caddyfile already defines an `agent.delegate.ws` site. Add a
`/metrics` handle block inside the existing site (do not duplicate the
site declaration):

```
agent.delegate.ws {
    # ... existing handles preserved verbatim ...

    handle /metrics {
        reverse_proxy localhost:{$GROUP_API_PORT:-3001}
    }
}
```

Bearer-token authentication is enforced inside DelegateAgent itself
(reusing `requireAuth`), so Caddy is just a path-scoped pass-through. The
admin UI and `/api/admin/*` remain on whatever paths they're already on
(unchanged). The `{$GROUP_API_PORT:-3001}` env-var fallback keeps the
config working in every environment without hard-coding the port.

### 4.11 delegate-core — Grafana dashboard

**`/Volumes/Projects/Delegate/deploy/grafana/dashboards/delegate/delegate-agent.json`** (new file in a new `delegate/` subdir)

Match the schema and stylistic conventions of `droplet.json`:

- `schemaVersion: 39` (Grafana 11)
- `tags: ["delegate-agent"]`, `uid: "delegate-agent"`

Template variables:

- `$jid_kind` — `label_values(delegate_agent_container_spawned_total, jid_kind)`,
  multi-select, `All` default, `includeAll: true`. All panel queries that
  break down by `jid_kind` use `{jid_kind=~"$jid_kind"}`.

Layout:

- Top row stat panels:
  - Process up: `up{job="delegate-agent"}`
  - Uptime: `time() - process_start_time_seconds{job="delegate-agent"}`
  - Active containers: `delegate_agent_containers_active`
  - p95 container duration:
    `histogram_quantile(0.95, sum(rate(delegate_agent_container_duration_seconds_bucket{jid_kind=~"$jid_kind"}[5m])) by (le))`
  - Containers spawned 24h:
    `sum(increase(delegate_agent_container_spawned_total{jid_kind=~"$jid_kind"}[24h]))`
- Row 2 — Throughput: messages delivered rate by channel
  (`sum by (channel)(rate(delegate_agent_channel_messages_delivered_total[5m]))`),
  container spawn rate by `jid_kind`
  (`sum by (jid_kind)(rate(delegate_agent_container_spawned_total{jid_kind=~"$jid_kind"}[5m]))`).
- Row 3 — Latency: heatmap of
  `delegate_agent_container_duration_seconds_bucket{jid_kind=~"$jid_kind"}`
  (counter-reset handled by `rate(...[5m])` per §6.2).
- Row 4 — Errors:
  - Container exit-status pie:
    `sum by (status)(rate(delegate_agent_container_duration_seconds_count{jid_kind=~"$jid_kind"}[5m]))`
  - Channel poll error rate by channel + kind:
    `sum by (channel, kind)(rate(delegate_agent_channel_poll_errors_total[5m]))`
  - JWT mint failure rate:
    `sum by (outcome)(rate(delegate_agent_jwt_mint_total[5m]))`
- Row 5 — Resource pressure:
  - Queue depth gauges:
    `max by (jid_kind, kind)(delegate_agent_queue_depth{jid_kind=~"$jid_kind"})`
  - Fast-path hit ratio:
    `sum(rate(delegate_agent_chat_fastpath_total{outcome="hit"}[5m])) / sum(rate(delegate_agent_chat_fastpath_total[5m]))`
- Row 6 — Credential & IPC breakdown:
  - Credential resolved tier pie:
    `sum by (tier)(rate(delegate_agent_credentials_resolved_total[5m]))`
  - Credential attempt outcome bar gauge:
    `sum by (tier, outcome)(rate(delegate_agent_credentials_attempt_total[5m]))`
  - IPC message type breakdown:
    `sum by (type)(rate(delegate_agent_ipc_messages_processed_total[5m]))`

Folder placement: add a second provider entry to
`/Volumes/Projects/Delegate/deploy/grafana/provisioning/dashboards/dashboards.yml`
that points at `/var/lib/grafana/dashboards/delegate` with `name: Delegate`.
Move the new JSON into the matching `delegate/` subdir under
`deploy/grafana/dashboards/`. Existing stress-test / droplet dashboards
stay where they are.

### 4.12 delegate-core — alert rules

**`/Volumes/Projects/Delegate/deploy/grafana/provisioning/alerting/rules.yaml`**

Add a new group `DelegateAgent` following the existing three-step
`refId A → B → C` pattern (instant query → reduce → threshold). All rules
**MUST** specify `noDataState: OK` (matches the existing rules.yaml
convention) — especially the crash-rate rule, whose denominator can be
zero during quiet periods. All rules **MUST** scope the host label to
`host="delegate-agent-prod"`.

1. `DelegateAgentProcessDown` — severity=critical, `for: 2m`, `noDataState: OK`
   - A: `up{job="delegate-agent",host="delegate-agent-prod"}`
   - C: less than 1
2. `DelegateAgentContainerCrashRateHigh` — severity=warning, `for: 2m`, `noDataState: OK`
   - A:
     `sum(rate(delegate_agent_container_duration_seconds_count{status=~"error|timeout"}[5m])) / sum(rate(delegate_agent_container_duration_seconds_count[5m]))`
   - C: ratio > 0.2
3. `DelegateAgentQueueDepthSaturated` — severity=warning, `for: 5m`, `noDataState: OK`
   - A: `max by (jid_kind, kind)(delegate_agent_queue_depth)`
   - C: > 25
4. `DelegateAgentChannelPollErrors` — severity=warning, `for: 5m`, `noDataState: OK`
   - A: `sum by (channel)(rate(delegate_agent_channel_poll_errors_total[5m]))`
   - C: > 0.1
5. (Optional, recommended) `DelegateAgentIdleTimeoutSpike` — severity=info, `for: 10m`, `noDataState: OK`
   - rate of `delegate_agent_idle_timeout_total` > baseline×3 — catches
     resource-ceiling thrash without paging.

Contact-points / policies already wired in `contact-points.yaml` and
`policies.yaml` — no change required if `severity` labels match existing
routing; verify the labels match before merge.

## 5. Cross-Host Scrape Decision

**Decision: Caddy reverse-proxy on the DelegateAgent host
(`agent.delegate.ws`), scraped over HTTPS with bearer-token auth, allow-listed
by `path /metrics` inside the existing site.**

Options considered:

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Caddy reverse-proxy + bearer auth | Reuses existing TLS termination on the DA host (DelegateAgent already deploys behind Caddy at `agent.delegate.ws`). No new components. Token lives in a single file on both hosts. Path-scoped handle keeps `/admin` private. | Requires DA host to have a public DNS record. Already does. | **Selected.** |
| SSH tunnel (autossh from delegate-core to DA host) | No public exposure of the metrics port. | Adds a long-lived process to monitor and recover. Tunnel flap == false `up==0` alerts. Op'l burden across reboots, launchd vs systemd asymmetry between Henry's Mac and prod droplet. | Rejected. |
| Push gateway | DA-side pushes; PR side scrapes locally; works through NAT. | Pushgateway is a documented anti-pattern for service-level metrics (counters never reset, stale metrics linger after process death — kills `up`-style alerting). Adds a stateful component. | Rejected. |

Mitigations applied:

- The `/admin` UI and `/api/admin/*` JSON endpoints are NOT exposed via the
  public Caddy site (path-scoped handle for `/metrics` only).
- Token rotation procedure: regenerate `DELEGATE_AGENT_TOKEN`, write to
  both hosts (DA `.env` and
  `delegate-core/prometheus-secrets/delegate-agent.token`), bounce DA. No
  Prometheus restart required — Prom 2.x re-reads `credentials_file` on
  every scrape.

## 6. Auth, Counter Resets, NTP, Sentry

### 6.1 Auth for `/metrics`

Bearer-token-gated, same `DELEGATE_AGENT_TOKEN` as the rest of the admin
surface. Reuse the existing `requireAuth` middleware. Do not add new auth
surface.

### 6.2 Counter resets

All `*_total` PromQL uses `rate(...[5m])` so prom-client process restarts
(which reset counters to 0) are absorbed naturally by Prometheus. Uptime
panel uses `time() - process_start_time_seconds{job="delegate-agent"}`.

### 6.3 NTP / clock

DA host runs ntpd / chronyd / native macOS time sync (default).

### 6.4 Sentry overlap

Channel poll errors are double-instrumented (Prometheus counter + Sentry
capture) intentionally; Prometheus gives rate, Sentry gives stack trace.
**Do NOT remove Sentry.**

### 6.5 Token-dashboard separation guardrail

Do NOT add `delegate_agent_llm_tokens_total` /
`delegate_agent_llm_cost_usd` (or any LLM token / cost metric) to this
registry. LLM token / cost metrics belong in token-dashboard's own
exporter. This registry is for runtime / lifecycle telemetry only.

## 7. Rollout Sequence

Step 1 — Foundation, no public surface (mergeable independently)

- 4.1 add `prom-client@15.1.3`
- 4.2 create `src/metrics.ts` (custom Registry, `safeMetric` wrapper,
  hot-reload `clear()`, `jidKind` helper, escape-hatch env flag)
- 4.3 expose `/metrics` (auth-gated)
- Verify locally: `curl -H "Authorization: Bearer $TOKEN" localhost:${GROUP_API_PORT:-3001}/metrics`
  returns process_* / nodejs_* metrics (no `delegate_agent_up` — that's
  expected; liveness is `up{job="delegate-agent"}` from Prom).

Step 2 — Wire telemetry sources

- 4.4 container-runner integration (most valuable single edit; also
  activates the existing-but-dead `container-telemetry.ts` ring buffer)
- 4.5 queue / dispatch / channel / JWT / credentials / IPC wire-ins
  (`delegate.ts` is the only channel skill modified in this PR)
- Verify: trigger a chat, confirm container metrics increment and admin UI
  Container Telemetry panel populates (Acceptance A5a + A5b).

Step 3 — Cross-host plumbing (delegate-core / DA host)

- 4.10 Caddy `/metrics` handle inside the existing `agent.delegate.ws`
  site in `DelegateAgent/deploy/Caddyfile`.
- 4.8 Prometheus scrape job
- 4.9 mount token secret into prometheus container; add
  `prometheus-secrets/` to `.gitignore`
- `make -f deploy/Makefile.core deploy && make -f deploy/Makefile.core targets`
- Verify Acceptance A2 + A6.

Step 4 — Visualization & alerting

- 4.11 dashboard JSON + new `Delegate` folder provider entry
- 4.12 alert group
- Reload Grafana provisioning (compose restart grafana, or use API).
- Verify Acceptance A3 + A4.

Step 5 — Ops handoff

- Update relevant runbooks.
- Add the dashboard URL and alert routing summary to memory
  (`droplet_ops_cheatsheet.md` adjacent / new memory file).

Steps 1–2 ship as a single PR to DelegateAgent. Steps 3–4 ship as a single
PR to the Delegate repo. Step 5 is doc-only.

## 8. Risks & Mitigations

R1. **Label cardinality (corrected).**
The `group` folder name is replaced with the bounded `jid_kind` enum
(~9 values). Histogram series count for `container_duration_seconds`
is `9 jid_kind × 3 statuses × 11 bucket boundaries = 297` series — bounded
and well within budget. Metrics module's typed wrappers only accept the
closed-set labels documented in §5; `jidKind()` quarantines unknown
prefixes to a single `'unknown'` value. Per-group debugging stays in the
admin UI / SQLite.

R2. **`/metrics` cost in the hot path.**
Counters/gauges from prom-client are atomic increments; histogram observe
is O(log n). Negligible. *Mitigation:* `safeMetric` wrapper has a
`process.env` short-circuit; no synchronous I/O in the metrics module.

R3. **Token leak via shared secret with admin UI.**
`DELEGATE_AGENT_TOKEN` is already a high-value credential. Rotation
procedure documented in §5. *Mitigation:* nothing new; the metrics
endpoint does not widen the blast radius.

R4. **Caddy public exposure.**
Path-scoped `/metrics` handle inside the existing `agent.delegate.ws`
site is essential. *Mitigation:* config snippet in §4.10 is a `handle
/metrics { reverse_proxy ... }` only — admin paths remain on whatever
gating they already have. Add a smoke-test in the runbook:
`curl https://agent.delegate.ws/metrics` without bearer → 401 from DA
itself (Caddy is pass-through).

R5. **Conflict with existing Caddyfile changes (already modified per git status).**
*Mitigation:* coordinate with the in-flight
`DelegateAgent/deploy/Caddyfile` edit — read that diff before adding the
new `/metrics` handle; merge order matters.

R6. **prom-client version incompat with current Node version on DA host.**
prom-client v15 requires Node >= 16. *Mitigation:* DA already runs on
Node 20+; confirm `node --version` on prod DA host during Step 1 verify.

R7. **Sentry double-instrument.**
Sentry cron-monitor heartbeat coexists. *Mitigation:* see §6.4 — keep
both, by design.

R8. **Stress Test folder collision in Grafana.**
Default dashboards provider lands new files in the `Stress Test` folder.
*Mitigation:* §4.11 introduces a separate provider entry for a
`Delegate` folder and places the JSON in `dashboards/delegate/`.

R9. **Alert flap on DA host restarts (launchd vs systemd unit reload).**
*Mitigation:* `for: 2m` on `DelegateAgentProcessDown` covers normal
restart; upgrade-window mute can be applied via Grafana silence if needed.

R10. **Container-runner is on the critical path.**
A bug in metrics emission that throws would kill containers.
*Mitigation:* the `safeMetric` wrapper wraps every `.inc()`/`.observe()`/
`.set()` in `try/catch` that logs via `src/logger.ts` and never re-throws.
This is non-negotiable. Code review checklist enforces no direct
metric-API calls outside `src/metrics.ts`.

R11. **Laptop-out-of-scope confusion.**
Henry's Mac runs DA in dev too. Prometheus on the core droplet **cannot**
reach the laptop. *Mitigation:* `static_configs.targets` is hardcoded to
`agent.delegate.ws:443` and ALL alert PromQL is scoped to
`host="delegate-agent-prod"` (mandatory `relabel_configs`). Dev-laptop
metrics are local-only by design; `/metrics` on a laptop is for ad-hoc
`curl` debugging, never alerting.

R12. **Hot-reload dup registration.**
`tsx --watch` re-imports `metrics.ts` and would otherwise throw "metric
already registered". *Mitigation:* in non-prod, `metricsRegistry.clear()`
runs at the top of the module. Production never reloads.

## 9. Verification Steps

V1. Build: `npm run build` in DelegateAgent — TypeScript clean.

V2. Local run on DA prod host: `systemctl status delegate-agent` (or
`launchctl print` on macOS dev) shows running, then
`curl -sf -H "Authorization: Bearer $DELEGATE_AGENT_TOKEN" http://localhost:${GROUP_API_PORT:-3001}/metrics | head -40`
shows `# HELP` / `# TYPE` lines for at least 5 of our families plus
default Node families.

V3. Synthetic workload — concrete recipe.

The simplest reproducible trigger is to inject a row directly into the DA
SQLite messages.db for the `main` group, mimicking an inbound message;
the orchestrator's IPC watcher will pick it up and spawn a container:

```bash
# On the DA host:
DA_DIR=/opt/delegate-agent   # adjust to the DA install path
GROUP=main
JID="delegate:task:smoke-$(date +%s)"
sqlite3 "$DA_DIR/store/messages.db" <<SQL
INSERT INTO messages (jid, group_name, body, direction, created_at)
VALUES ('$JID', '$GROUP', 'monitoring smoke test', 'inbound', strftime('%s','now'));
SQL

# Then watch /metrics:
curl -sf -H "Authorization: Bearer $DELEGATE_AGENT_TOKEN" \
  http://localhost:${GROUP_API_PORT:-3001}/metrics \
  | grep -E 'container_spawned_total|containers_active|container_duration_seconds_count'
```

(If the SQLite schema differs from this snippet, adjust to match the
existing columns observed in `src/db.ts` — the point is "INSERT a row that
the IPC watcher will route to `runContainerAgent`". An equivalent magic-
login-style harness is acceptable; pick the simplest path that works on
the box being verified.)

After the container exits, expect:

- `delegate_agent_container_spawned_total{jid_kind="delegate_task",isMain="false"} == 1`
- `delegate_agent_container_duration_seconds_count{jid_kind="delegate_task",status="success"} == 1`
- `delegate_agent_containers_active 0` (back to baseline)
- Admin UI ring buffer at `/admin/partials/containers` shows the entry.

V4. Auth: `curl -sf http://localhost:${GROUP_API_PORT:-3001}/metrics`
(no header) → 401.

V5. Cross-host scrape: from the delegate-core droplet,
`docker compose exec prometheus wget -qO- --header="Authorization: Bearer $(cat /etc/prometheus/delegate-agent.token)" https://agent.delegate.ws/metrics | head`
returns metrics. Then `make -f deploy/Makefile.core targets` shows
`delegate-agent` up.

V6. Dashboard: Grafana → `Delegate` folder → `Delegate Agent` dashboard
renders non-empty panels with last 1h workload. `$jid_kind` template
variable populates from real series.

V7. Alerts:

- Stop the DA process for 3 minutes (`systemctl stop delegate-agent` on
  prod) → `DelegateAgentProcessDown` fires → contact-point delivers
  (Discord/Telegram per existing config).
- Force a container error path. The simplest reproducible recipe is:
  `CONTAINER_IMAGE=does-not-exist:nope npm run dev` on a non-prod DA
  instance (or a temporary env override on prod's service unit). This
  forces the `container.on('error')` branch on every spawn. Within 5–7
  minutes, `DelegateAgentContainerCrashRateHigh` fires.
- Restart DA → alerts auto-resolve.

V8. Cardinality check:
`count({__name__=~"delegate_agent_.*"}) by (__name__)` shows each
family's series count well under 100 except the histogram, which sits at
~297 (see R1).

V9. Sentry parity check: trigger normal channel poll → Sentry cron monitor
still records check-in for `delegate-agent-poll`.

## 10. Out of Scope (explicit)

- **LLM token / cost metrics.** No
  `delegate_agent_llm_tokens_total` / `delegate_agent_llm_cost_usd` here.
  That is token-dashboard's job (`deploy/token-dashboard/`). Adding them
  here would split the source of truth.
- Replacing Sentry — Sentry cron monitor for the delegate channel stays.
- Tracing / OpenTelemetry spans — only metrics in this plan. Tracing can be
  a follow-up that reuses the same metrics module pattern.
- Token-dashboard public exposure — separate Caddy work.
- Multi-tenant / per-workspace metric labels — `jid_kind` is the
  granularity; workspace IDs are explicitly out to keep cardinality
  bounded.
- Container-internal metrics (inside the agent VM/container) — only host
  process and container lifecycle from the orchestrator's perspective.
- Migrating delegate-core's existing alert groups — no edits to the
  `Stress Test Alerts` group; we add a new group only.
- Refactoring `web-ui/container-telemetry.ts` API — wire it as-is; ring
  buffer remains capped at 50.
- Authn/authz model changes — `DELEGATE_AGENT_TOKEN` remains the single
  shared bearer credential for the admin surface, including `/metrics`.
- Wiring metrics emission into channel skills other than `delegate.ts`
  in this PR — those land per-channel in follow-ups; CONTRIBUTING.md
  addendum is also a separate doc-only PR.
- Per-group debugging via Prometheus — bounded to `jid_kind`; the admin
  UI and SQLite are the right surface for per-group forensics.

## 11. Metric Catalog (final)

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `delegate_agent_container_spawned_total` | counter | `jid_kind`, `isMain` | `isMain` as string `"true"`/`"false"` for label discipline. |
| `delegate_agent_container_duration_seconds` | histogram | `jid_kind`, `status` | Buckets: `[0.5, 2, 5, 15, 60, 300, 900, 1800, 3600]` (bimodal: <1s auth-fail through ~1h long-task). `status ∈ {success, error, timeout}`. Series count = 9 × 3 × 11 = 297, bounded. |
| `delegate_agent_containers_active` | gauge | (none) | Increment on spawn, decrement in container-runner's two terminal handlers. Single-source. |
| `delegate_agent_queue_depth` | gauge | `jid_kind`, `kind` | `kind ∈ {messages, tasks}`. |
| `delegate_agent_session_resumes_total` | counter | `jid_kind` | |
| `delegate_agent_messages_processed_total` | counter | `channel` | Channel from `channels/registry.ts`. (Retained as a pre-dispatch counter; complemented by `_channel_messages_delivered_total` for post-dispatch counting.) |
| `delegate_agent_channel_messages_delivered_total` | counter | `channel` | Per-channel emission (Architect answer #3); reference impl in `delegate.ts`. |
| `delegate_agent_chat_fastpath_total` | counter | `outcome` | Closed enum (see §4.5). |
| `delegate_agent_idle_timeout_total` | counter | `jid_kind` | |
| `delegate_agent_credentials_resolved_total` | counter | `tier` | `tier ∈ {workspace, onecli, static, none}`. Winner-takes-all per `buildContainerArgs` call. |
| `delegate_agent_credentials_attempt_total` | counter | `tier`, `outcome` | Per-tier outcomes: workspace → `{success, miss, error}`; onecli → `{success, unavailable, skipped}`; static → `{success, missing, skipped}`. ~8 series total. |
| `delegate_agent_jwt_mint_total` | counter | `outcome` | `outcome ∈ {success, failure}`. |
| `delegate_agent_channel_poll_errors_total` | counter | `channel`, `kind` | `kind ∈ {http_4xx, http_5xx, network, timeout, parse}`. |
| `delegate_agent_ipc_messages_processed_total` | counter | `type` | Bound to `ipc.ts` switch arms. |
| `delegate_agent_node_*` (default) | various | (default) | From `collectDefaultMetrics({ prefix: 'delegate_agent_node_' })`. |

Dropped vs prior draft:

- **`delegate_agent_up`** — removed; use `up{job="delegate-agent"}` from
  Prometheus' built-in target liveness signal everywhere.

PLAN_READY: /Volumes/Projects/Delegate/DelegateAgent/.omc/plans/delegate-agent-monitoring.md
