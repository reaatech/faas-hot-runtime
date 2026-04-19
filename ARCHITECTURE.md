# faas-hot-runtime — Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Client Layer                                │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                  │
│  │  AI Agent   │    │  HTTP Client│    │  Queue      │                  │
│  │  (MCP)      │    │  (REST)     │    │  Producer   │                  │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘                  │
│         │                   │                   │                         │
│         └───────────────────┼───────────────────┘                         │
│                             │                                               │
└─────────────────────────────┼─────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Gateway Layer                                  │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────┐    ┌──────────┐  │
│  │   Auth   │───▶│  Rate Limit  │───▶│    Request    │───▶│    TLS   │  │
│  │Middleware│    │  Middleware  │    │  Validation   │    │Middleware│  │
│  └──────────┘    └──────────────┘    └───────────────┘    └──────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           MCP Server                                     │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                      MCP Protocol Layer                           │   │
│  │                                                                   │   │
│  │  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐           │   │
│  │  │   tools/    │    │   tools/    │    │    ping     │           │   │
│  │  │    list     │    │    call     │    │   (health)  │           │   │
│  │  └─────────────┘    └─────────────┘    └─────────────┘           │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Orchestration Core                                │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                      Request Pipeline                             │   │
│  │                                                                   │   │
│  │  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐           │   │
│  │  │  Function   │───▶│   Pool      │───▶│  Invoker    │           │   │
│  │  │  Registry   │    │   Manager   │    │   Engine    │           │   │
│  │  └─────────────┘    └─────────────┘    └─────────────┘           │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Warm Pod Pool                                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │   Pod 1     │  │   Pod 2     │  │   Pod 3     │  │   Pod N     │    │
│  │   (warm)    │  │   (warm)    │  │  (active)   │  │  (cooling)  │    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       Cross-Cutting Concerns                             │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐       │
│  │    Cost Track    │  │   Observability  │  │   Kubernetes     │       │
│  │  - Per-request   │  │  - Tracing (OTel)│  │  - Pod mgmt      │       │
│  │  - Budget track  │  │  - Metrics (OTel)│  │  - Scaling       │       │
│  │  - Anomaly detect│  │  - Logging (pino)│  │  - Networking    │       │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘       │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Design Principles

### 1. MCP-Native First
- Functions are MCP tools first, HTTP endpoints second
- The MCP interface is the primary API for AI agent integration
- All function metadata is exposed via MCP tool schemas

### 2. Sub-100ms Invocation
- Warm pool eliminates cold starts
- Pre-warmed pods ready for immediate execution
- Optimized dispatch pipeline minimizes overhead

### 3. Cost Transparency
- Every invocation's cost is calculated and reported
- Budget enforcement prevents runaway costs
- Cost-aware scaling decisions

### 4. Observability Built-In
- OpenTelemetry tracing for every invocation
- GenAI semantic conventions for AI functions
- Structured logging with request correlation

### 5. Multi-Cloud Kubernetes
- EKS as the reference platform
- Abstracted K8s client for GKE/AKS compatibility
- Cloud-agnostic function definitions

---

## Component Deep Dive

### MCP Server

The MCP server exposes functions as callable tools:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        MCP Server                                    │
│                                                                      │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐              │
│  │  Streamable │    │   Session   │    │    Tool     │              │
│  │    HTTP     │    │  Manager    │    │   Registry  │              │
│  │  Transport  │    │             │    │             │              │
│  └─────────────┘    └─────────────┘    └─────────────┘              │
│                                                                      │
│  MCP Methods:                                                        │
│  - tools/list: Return all registered functions as tools             │
│  - tools/call: Invoke a function with arguments                     │
│  - ping: Health check with pool status                              │
│                                                                      │
│  Authentication:                                                     │
│  - API key validation (X-API-Key header)                            │
│  - Rate limiting per client                                         │
│  - Request signing for sensitive operations                         │
└─────────────────────────────────────────────────────────────────────┘
```

**Tool Registration:**
- Functions are automatically converted to MCP tools
- Input schemas are generated from function YAML
- Tool names are normalized to snake_case
- Descriptions are indexed for AI agent discovery

### Function Registry

The registry manages function definitions:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Function Registry                                │
│                                                                      │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐              │
│  │   YAML      │    │   Schema    │    │   Atomic    │              │
│  │   Loader    │───▶│  Validator  │───▶│    Swap     │              │
│  │             │    │             │    │             │              │
│  └─────────────┘    └─────────────┘    └─────────────┘              │
│                                                                      │
│  Hot-Reload:                                                         │
│  - File system watching (chokidar)                                  │
│  - Debounced reload (5s window)                                     │
│  - Atomic swap (old config serves during reload)                    │
│  - Validation before activation                                     │
│                                                                      │
│  Invariants:                                                         │
│  - Unique function names                                            │
│  - Unique MCP tool names                                            │
│  - Valid container images                                           │
│  - Valid JSON schemas                                               │
│  - Pool size constraints                                            │
└─────────────────────────────────────────────────────────────────────┘
```

### Warm Pod Pool Manager

The pool manager maintains pre-warmed pods:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Warm Pod Pool Manager                             │
│                                                                      │
│  Pod States:                                                         │
│                                                                      │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐      │
│  │  WARM    │───▶│  ACTIVE  │───▶│  COOLING │───▶│ WARM     │      │
│  │ (ready)  │    │(invoking)│    │(cooldown)│    │(ready)   │      │
│  └──────────┘    └──────────┘    └──────────┘    └──────────┘      │
│       ▲                                              │               │
│       │                                              │               │
│       └──────────────────────────────────────────────┘               │
│                                                                      │
│  Scaling:                                                            │
│  - Predictive: Based on traffic patterns                            │
│  - Reactive: Based on queue depth and utilization                   │
│  - Cost-aware: Balances latency vs cost                             │
│                                                                      │
│  Health Monitoring:                                                  │
│  - Periodic health checks (HTTP/TCP)                                │
│  - Latency monitoring per pod                                       │
│  - Automatic unhealthy pod replacement                              │
└─────────────────────────────────────────────────────────────────────┘
```

**Pod Selection Strategies:**
- **Round-robin**: Distribute load evenly
- **Least-loaded**: Select pod with fewest active invocations
- **Latency-based**: Select pod with lowest recent latency
- **Sticky**: Route to same pod for stateful functions

### Invocation Engine

The engine handles function execution:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Invocation Engine                                │
│                                                                      │
│  Request Flow:                                                       │
│                                                                      │
│  1. Validate input against JSON Schema                              │
│  2. Select pod from warm pool                                       │
│  3. Route request to pod                                            │
│  4. Wait for response (with timeout)                                │
│  5. Validate response                                               │
│  6. Calculate cost                                                  │
│  7. Return result with metadata                                     │
│                                                                      │
│  Timeout Handling:                                                   │
│  - Per-function timeout configuration                               │
│  - Graceful timeout (cancel in-flight request)                      │
│  - Cleanup of timed-out invocations                                 │
│                                                                      │
│  Error Handling:                                                     │
│  - Retry on transient failures (configurable)                       │
│  - Circuit breaker for failing functions                            │
│  - Detailed error responses with context                            │
└─────────────────────────────────────────────────────────────────────┘
```

### Trigger Handlers

Multiple trigger types are supported:

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Trigger Handlers                                │
│                                                                      │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐              │
│  │    HTTP     │    │     SQS     │    │   Pub/Sub   │              │
│  │   Trigger   │    │   Trigger   │    │   Trigger   │              │
│  │             │    │             │    │             │              │
│  │ - RESTful   │    │ - Polling   │    │ - Push      │              │
│  │   endpoints │    │ - Batch     │    │ - Streaming │              │
│  │ - CORS      │    │ - DLQ       │    │ - Ack       │              │
│  │ - Auth      │    │ - Visibility│    │ - Sub mgmt  │              │
│  └─────────────┘    └─────────────┘    └─────────────┘              │
│                                                                      │
│  Trigger Routing:                                                    │
│  - Event filtering and transformation                               │
│  - Multi-trigger support per function                               │
│  - Trigger-level rate limiting                                      │
│  - Dead-letter handling for failed invocations                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### Complete Invocation Flow

```
1. AI agent sends MCP tools/call request
        │
2. Gateway middleware:
   - TLS check
   - Auth validation (API key)
   - Rate limit check
   - Request validation
        │
3. MCP server processes request:
   - Parse tool name and arguments
   - Look up function in registry
   - Validate arguments against schema
        │
4. Pool manager selects pod:
   - Check warm pool for available pods
   - Select pod based on strategy
   - If no pods available, scale up
        │
5. Invoker executes function:
   - Send request to pod
   - Wait for response (with timeout)
   - Handle errors and retries
        │
6. Cost tracker calculates cost:
   - Compute cost (CPU + Memory + Duration)
   - Network cost
   - Queue cost (if applicable)
        │
7. Observability pipeline:
   - Create trace span
   - Record metrics
   - Write structured log
        │
8. Response sent to client:
   - Function result
   - Cost metadata
   - Execution metadata (pod, duration, cold_start)
```

---

## Security Model

### Defense in Depth

```
┌─────────────────────────────────────────────────────────────────────┐
│ Layer 1: Network                                                     │
│ - HTTPS required in production                                       │
│ - API key validation on all endpoints                                │
│ - Rate limiting per client                                           │
│ - Network policies for pod isolation                                 │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 2: Input                                                       │
│ - JSON Schema validation for all inputs                              │
│ - Size limits on request bodies                                      │
│ - Sanitization of string inputs                                      │
│ - Type checking and format validation                                │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 3: Execution                                                   │
│ - Pod isolation (network policies, resource quotas)                  │
│ - Timeouts on all invocations                                        │
│ - Circuit breakers for failing functions                             │
│ - Read-only root filesystems                                         │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 4: Observability                                               │
│ - PII redaction in logs                                              │
│ - Structured error responses (no stack traces)                       │
│ - Audit logging for sensitive operations                             │
│ - Cost anomaly detection                                             │
└─────────────────────────────────────────────────────────────────────┘
```

### Pod Isolation

Each function runs in an isolated pod with:
- **Network policies**: Restrict inter-pod communication
- **Resource quotas**: Prevent resource exhaustion
- **Security contexts**: Minimal privileges (non-root, read-only FS)
- **Service accounts**: Per-function IAM roles

### API Key Management

- API keys stored in environment variables or secret manager
- Never logged or included in responses
- Key rotation supported without downtime
- Per-key rate limits and budgets

---

## Deployment Architecture

### EKS Topology

```
┌─────────────────────────────────────────────────────────────────────┐
│                         EKS Cluster                                  │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    System Namespace                          │    │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐                │    │
│  │  │  CoreDNS  │  │kube-proxy │  │   VPC     │                │    │
│  │  │           │  │           │  │  CNI      │                │    │
│  │  └───────────┘  └───────────┘  └───────────┘                │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                  faas-hot-runtime Namespace                  │    │
│  │  ┌───────────────────────────────────────────────────────┐  │    │
│  │  │              Runtime Deployment                        │  │    │
│  │  │  ┌─────────┐  ┌─────────┐  ┌─────────┐                │  │    │
│  │  │  │  Pod 1  │  │  Pod 2  │  │  Pod 3  │   (HA)         │  │    │
│  │  │  └─────────┘  └─────────┘  └─────────┘                │  │    │
│  │  └───────────────────────────────────────────────────────┘  │    │
│  │                                                              │    │
│  │  ┌───────────────────────────────────────────────────────┐  │    │
│  │  │           Function Pod Pools (per function)            │  │    │
│  │  │  ┌─────────┐  ┌─────────┐  ┌─────────┐                │  │    │
│  │  │  │ func-a  │  │ func-b  │  │ func-c  │   (warm)       │  │    │
│  │  │  │ pool    │  │ pool    │  │ pool    │                │  │    │
│  │  │  └─────────┘  └─────────┘  └─────────┘                │  │    │
│  │  └───────────────────────────────────────────────────────┘  │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                   Observability Namespace                    │    │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐                │    │
│  │  │  Jaeger   │  │ Prometheus│  │ Grafana   │                │    │
│  │  │           │  │           │  │           │                │    │
│  │  └───────────┘  └───────────┘  └───────────┘                │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

### Networking

- **VPC CNI**: Native networking for pods
- **Service Mesh** (optional): Istio/Linkerd for advanced routing
- **Ingress Controller**: NGINX or ALB for external traffic
- **Private endpoints**: Functions accessible only within VPC (configurable)

---

## Failure Modes

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Pod crash | K8s health check failure | Auto-recreate pod, route to healthy pod |
| Pod timeout | Invocation timeout exceeded | Kill pod, return error, scale up |
| Pool exhausted | No available pods | Queue request, scale up pool |
| Function error | Non-2xx response from pod | Return error, update circuit breaker |
| Registry reload fail | YAML validation error | Keep old config, log error |
| K8s API unavailable | Connection error | Use cached state, retry with backoff |
| Cost budget exceeded | Budget check | Reject request with 429 |
| Rate limit exceeded | Token bucket empty | Return 429 with Retry-After |

---

## Observability

### Tracing

Every invocation generates an OpenTelemetry trace:

| Span | Attributes |
|------|------------|
| `faas.invoke` | function, pod, cold_start, duration_ms, status |
| `pool.select` | pool_size, available_pods, selection_strategy, duration_ms |
| `function.execute` | function, input_size, output_size, status_code |
| `cost.calculate` | cost_usd, cost_breakdown, budget_remaining |
| `trigger.process` | trigger_type, event_id, batch_size |

### Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `faas.invocations.total` | Counter | `function`, `status` | Total invocations |
| `faas.invocations.duration_ms` | Histogram | `function` | Invocation latency |
| `faas.cold_starts.total` | Counter | `function` | Cold start count |
| `faas.pool.utilization` | Gauge | `function` | Pool utilization (0-1) |
| `faas.pool.size` | Gauge | `function`, `state` | Pool size by state |
| `faas.cost.total` | Counter | `function` | Total cost (USD) |
| `faas.cost.per_invocation` | Histogram | `function` | Cost per invocation |
| `faas.errors.total` | Counter | `function`, `error_type` | Error count |
| `faas.triggers.processed` | Counter | `trigger_type`, `function` | Trigger events processed |

### Logging

All logs are structured JSON with standard fields:

```json
{
  "timestamp": "2026-04-15T23:00:00Z",
  "service": "faas-hot-runtime",
  "request_id": "req-123",
  "trace_id": "abc123def456",
  "span_id": "xyz789",
  "level": "info",
  "message": "Function invoked successfully",
  "function": "process_payment",
  "pod": "process-payment-pod-abc123",
  "duration_ms": 45,
  "cost_usd": 0.000123,
  "cold_start": false,
  "status_code": 200
}
```

---

## GenAI Semantic Conventions

For AI/LLM functions, the runtime applies OpenTelemetry GenAI semantic conventions:

| Attribute | Description |
|-----------|-------------|
| `gen_ai.operation.name` | Operation (chat, completion, embedding) |
| `gen_ai.request.model` | Model identifier |
| `gen_ai.request.temperature` | Sampling temperature |
| `gen_ai.response.model` | Actual model used |
| `gen_ai.usage.input_tokens` | Input token count |
| `gen_ai.usage.output_tokens` | Output token count |
| `gen_ai.usage.total_tokens` | Total token count |

This enables consistent observability across AI workloads.

---

## References

- **AGENTS.md** — Agent development guide
- **DEV_PLAN.md** — Development checklist
- **README.md** — Quick start and overview
- **config/examples/** — Example function definitions
- **MCP Specification** — https://modelcontextprotocol.io/
- **OpenTelemetry GenAI Semconv** — https://opentelemetry.io/docs/specs/semconv/gen-ai/
