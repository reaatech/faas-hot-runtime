---
agent_id: "faas-hot-runtime"
display_name: "FaaS Hot Runtime"
version: "0.1.0"
description: "Low-latency FaaS runtime for agent execution"
type: "mcp"
confidence_threshold: 0.9
---

# faas-hot-runtime — Agent Development Guide

## What this is

This document defines how AI agents interact with `faas-hot-runtime` — an MCP-native
FaaS runtime where functions are exposed as callable tools. Point an AI agent at the
MCP endpoint and your serverless functions become instantly available as tools with
full schema validation, cost tracking, and sub-100ms latency.

**Target audience:** AI agent developers who need to invoke serverless functions via
MCP, platform engineers exposing functions to AI systems, and SREs managing FaaS
infrastructure at scale.

---

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   AI Client     │────▶│  faas-hot-runtime │────▶│  Function Pods  │
│  (Claude, etc)  │     │   (MCP Server)    │     │  (Warm Pool)    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │  Function        │
                       │  Registry        │
                       │  (YAML configs)  │
                       └──────────────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │  Triggers        │
                       │  HTTP + SQS +    │
                       │  Pub/Sub         │
                       └──────────────────┘
```

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| **MCP Server** | `src/mcp-server/` | Exposes functions as MCP tools |
| **Function Registry** | `src/registry/` | YAML-based function definitions |
| **Warm Pool Manager** | `src/pool-manager/` | Pre-warmed pods for sub-100ms invoke |
| **Invocation Engine** | `src/invoker/` | Routes requests to available pods |
| **Trigger Handlers** | `src/triggers/` | HTTP, SQS, Pub/Sub event handling |
| **Cost Tracker** | `src/cost/` | Per-invocation cost accounting |

---

## MCP Protocol Contract

The runtime implements the MCP (Model Context Protocol) server interface. AI agents
communicate with functions via standard MCP tool calls.

### Tool Discovery

Agents discover available functions via `tools/list`:

```json
// Request
{
  "jsonrpc": "2.0",
  "id": "discover-1",
  "method": "tools/list"
}

// Response
{
  "jsonrpc": "2.0",
  "id": "discover-1",
  "result": {
    "tools": [
      {
        "name": "process_payment",
        "description": "Process a payment transaction",
        "inputSchema": {
          "type": "object",
          "properties": {
            "amount": {
              "type": "number",
              "description": "Payment amount in cents"
            },
            "currency": {
              "type": "string",
              "description": "ISO 4217 currency code",
              "default": "USD"
            },
            "customer_id": {
              "type": "string",
              "description": "Customer identifier"
            }
          },
          "required": ["amount", "customer_id"]
        }
      },
      {
        "name": "generate_report",
        "description": "Generate an analytics report",
        "inputSchema": {
          "type": "object",
          "properties": {
            "report_type": {
              "type": "string",
              "enum": ["daily", "weekly", "monthly"]
            },
            "date_range": {
              "type": "object",
              "properties": {
                "start": { "type": "string", "format": "date" },
                "end": { "type": "string", "format": "date" }
              }
            }
          },
          "required": ["report_type", "date_range"]
        }
      }
    ]
  }
}
```

### Tool Invocation

Agents invoke functions via `tools/call`:

```json
// Request
{
  "jsonrpc": "2.0",
  "id": "invoke-1",
  "method": "tools/call",
  "params": {
    "name": "process_payment",
    "arguments": {
      "amount": 2999,
      "currency": "USD",
      "customer_id": "cust_abc123"
    }
  }
}

// Response (success)
{
  "jsonrpc": "2.0",
  "id": "invoke-1",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Payment processed successfully. Transaction ID: txn_xyz789"
      }
    ],
    "metadata": {
      "function": "process_payment",
      "pod": "process-payment-pod-abc123",
      "duration_ms": 45,
      "cost_usd": 0.000123,
      "cold_start": false
    }
  }
}

// Response (error)
{
  "jsonrpc": "2.0",
  "id": "invoke-1",
  "error": {
    "code": -32000,
    "message": "Function execution failed",
    "data": {
      "function": "process_payment",
      "error_type": "ValidationError",
      "error_message": "Invalid customer_id format",
      "duration_ms": 12
    }
  }
}
```

### Health Check

Agents can check runtime health via `ping`:

```json
// Request
{
  "jsonrpc": "2.0",
  "id": "health-1",
  "method": "ping"
}

// Response
{
  "jsonrpc": "2.0",
  "id": "health-1",
  "result": {
    "status": "healthy",
    "uptime_seconds": 86400,
    "pool_utilization": 0.45,
    "active_functions": 12
  }
}
```

---

## Function Configuration

Functions are defined via YAML configuration files. The registry loads these at
startup and hot-reloads on changes.

### Function YAML Schema

```yaml
# functions/my-function.yaml
name: my-function
description: >-
  Detailed description of what this function does.
  This text is shown to AI agents in tool discovery.

version: 1.0.0

# Container specification
container:
  image: myregistry/my-function:latest
  port: 8080
  resources:
    cpu: 250m
    memory: 256Mi
    gpu: 0  # Set to 1+ for GPU functions

# Warm pool configuration
pool:
  min_size: 2        # Minimum warm pods
  max_size: 10       # Maximum warm pods
  target_utilization: 0.7  # Scale when utilization exceeds this
  warm_up_time_seconds: 30  # Time to keep pods warm after use

# Triggers
triggers:
  - type: http
    path: /my-function
    methods: [POST]
    auth_required: true
  
  - type: sqs
    queue: my-function-queue
    batch_size: 10
    visibility_timeout_seconds: 300

# MCP tool configuration
mcp:
  enabled: true
  tool_name: my_function  # Snake_case tool name
  description: >-
    Short description for MCP tool discovery.
    Be specific about what this function does.
  input_schema:
    type: object
    properties:
      param1:
        type: string
        description: First parameter
      param2:
        type: number
        description: Second parameter
    required: [param1]

# Cost configuration
cost:
  budget_daily: 50.00
  cost_per_invocation_estimate: 0.001
  alert_thresholds: [0.5, 0.75, 0.9]

# Observability
observability:
  tracing_enabled: true
  metrics_enabled: true
  log_level: info
```

### Schema Reference

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | yes | string | Unique function identifier (lowercase, hyphens) |
| `description` | yes | string | Human-readable description |
| `version` | yes | string | Semantic version |
| `container.image` | yes | string | Container image URL |
| `container.port` | yes | number | Port the container listens on |
| `container.resources` | yes | object | CPU/memory/gpu resources |
| `pool.min_size` | yes | number | Minimum warm pods |
| `pool.max_size` | yes | number | Maximum warm pods |
| `pool.target_utilization` | no | number | Scale threshold (default: 0.7) |
| `mcp.enabled` | yes | boolean | Expose as MCP tool |
| `mcp.tool_name` | yes | string | MCP tool name (snake_case) |
| `mcp.input_schema` | yes | object | JSON Schema for inputs |
| `triggers` | yes | array | Trigger configurations |

### Invariants Enforced at Load Time

1. **Unique function names** — duplicate names cause reload abort
2. **Valid container images** — must be valid OCI image references
3. **MCP tool names unique** — no two functions can have the same tool_name
4. **Valid input schemas** — must be valid JSON Schema
5. **Pool size valid** — min_size <= max_size
6. **Resource limits** — must be within cluster quotas

---

## Skill System

Skills represent the atomic capabilities of the FaaS runtime. Each skill corresponds
to a component of the system.

### Available Skills

| Skill ID | File | Status | Description |
|----------|------|--------|-------------|
| `mcp-protocol` | `skills/mcp-protocol/skill.md` | ✅ Implemented | MCP server and tool registration |
| `warm-pool` | `skills/warm-pool/skill.md` | ✅ Implemented | Warm pod pool management |
| `http-trigger` | `skills/http-trigger/skill.md` | ✅ Implemented | HTTP trigger handling |
| `queue-trigger` | `skills/queue-trigger/skill.md` | ✅ Implemented | Queue trigger handling (SQS) |
| `otel-instrumentation` | `skills/otel-instrumentation/skill.md` | ✅ Implemented | Observability integration |
| `function-scaling` | `skills/function-scaling/skill.md` | ✅ Implemented | Auto-scaling policies |
| `cost-optimization` | `skills/cost-optimization/skill.md` | ✅ Implemented | Cost tracking and optimization |

### MCP Tools by Skill

#### Cost Optimization
- `get_cost_report` - Get cost report for function invocations
- `get_budget_status` - Get budget status for functions
- `update_budget` - Update budget configuration
- `estimate_cost` - Estimate cost for a function invocation

#### Function Scaling
- `get_scaling_policy` - Get scaling policy for a function
- `update_scaling_policy` - Update scaling policy
- `get_scaling_history` - Get scaling history

#### Warm Pool Management
- `get_pool_status` - Get warm pool status
- `scale_pool` - Scale the warm pool
- `get_pod_health` - Get health status of pods

#### Queue Trigger
- `get_queue_status` - Get status of message queues
- `get_dlq_messages` - Get messages from dead letter queue
- `replay_dlq` - Replay messages from DLQ

#### HTTP Trigger
- `get_http_endpoints` - Get registered HTTP endpoints
- `test_http_endpoint` - Test an HTTP endpoint

#### Observability
- `get_traces` - Get trace data
- `get_metrics` - Get metrics
- `get_logs` - Get log entries

---

## Cost Management

The runtime tracks costs per invocation and enforces budget limits.

### Cost Structure

| Cost Component | Calculation |
|----------------|-------------|
| **Compute** | (CPU + Memory) × Duration × Rate |
| **GPU** | GPU count × Duration × GPU rate |
| **Network** | Data transferred × Network rate |
| **Queue** | SQS/Pub/Sub operations × Operation rate |

### Budget Configuration

```yaml
cost:
  budget_daily: 50.00
  budget_monthly: 1500.00
  alert_thresholds: [0.5, 0.75, 0.9]
  hard_limit: true  # Stop invocations when budget exceeded
```

### Cost in Responses

Every MCP response includes cost metadata:

```json
{
  "result": {
    "content": [...],
    "metadata": {
      "cost_usd": 0.000123,
      "cost_breakdown": {
        "compute": 0.000100,
        "network": 0.000015,
        "queue": 0.000008
      }
    }
  }
}
```

### Budget Enforcement

When budget is exceeded:
- **Soft limit**: Warning logged, invocations continue
- **Hard limit**: Invocations rejected with 429 status

---

## Security Model

### Authentication

The MCP endpoint requires API key authentication:

```bash
# Include API key in request header
curl -H "X-API-Key: your-api-key" \
  -X POST http://runtime:8080/mcp \
  -d '{"jsonrpc":"2.0","method":"tools/list"}'
```

### Input Validation

All function inputs are validated against the declared JSON Schema:
- Type checking (string, number, boolean, object, array)
- Required field validation
- Format validation (date, email, uuid, etc.)
- Custom validation rules

### Pod Isolation

Functions run in isolated pods with:
- Network policies restricting inter-pod communication
- Resource quotas preventing resource exhaustion
- Security contexts with minimal privileges
- Read-only root filesystems (configurable)

### Rate Limiting

Per-client rate limits prevent abuse:
- Default: 100 requests/minute
- Configurable per API key
- 429 response with `Retry-After` header

---

## Observability

### Tracing

Every invocation generates an OpenTelemetry trace:

| Span | Attributes |
|------|------------|
| `faas.invoke` | function, pod, cold_start, duration_ms |
| `pool.select` | pool_size, available_pods, selection_strategy |
| `function.execute` | function, input_size, output_size |
| `cost.calculate` | cost_usd, cost_breakdown |

### Metrics

The runtime exposes these metrics:

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `faas.invocations.total` | Counter | `function`, `status` | Total invocations |
| `faas.invocations.duration_ms` | Histogram | `function` | Invocation latency |
| `faas.cold_starts.total` | Counter | `function` | Cold start count |
| `faas.pool.utilization` | Gauge | `function` | Pool utilization |
| `faas.pool.size` | Gauge | `function`, `state` | Pool size by state |
| `faas.cost.total` | Counter | `function` | Total cost |
| `faas.errors.total` | Counter | `function`, `error_type` | Error count |

### Structured Logging

All logs are structured JSON:

```json
{
  "timestamp": "2026-04-15T23:00:00Z",
  "service": "faas-hot-runtime",
  "request_id": "req-123",
  "function": "process_payment",
  "pod": "process-payment-pod-abc123",
  "level": "info",
  "message": "Function invoked successfully",
  "duration_ms": 45,
  "cost_usd": 0.000123,
  "cold_start": false
}
```

---

## Integration with Multi-Agent Systems

### Integration with agent-mesh

Register faas-hot-runtime as an agent in agent-mesh:

```yaml
# agents/faas-hot-runtime.yaml
agent_id: faas-hot-runtime
display_name: FaaS Hot Runtime
description: >-
  Serverless function runtime with sub-100ms invocations.
  Functions are exposed as MCP tools for AI agent integration.
  Supports HTTP, SQS, and Pub/Sub triggers.
endpoint: "${FAAS_HOT_RUNTIME_ENDPOINT:-http://localhost:8084}"
type: mcp
is_default: false
confidence_threshold: 0.9
examples:
  - "List available functions"
  - "Invoke the payment processing function"
  - "What's the cost of running function X?"
```

### Agent-to-Agent Workflow

```
User Query → agent-mesh (orchestrator)
                  │
                  ▼
           faas-hot-runtime (agent)
                  │
                  ▼
           Function Pod (warm pool)
                  │
                  ▼
           Function Result → agent-mesh
```

---

## Checklist: Production Readiness

Before deploying functions to production:

- [ ] Function container is production-ready (health checks, graceful shutdown)
- [ ] Input schema is complete and validated
- [ ] MCP tool name is unique and follows naming conventions
- [ ] Warm pool size is appropriate for expected traffic
- [ ] Cost budget is configured and alerts are set up
- [ ] Observability is enabled (tracing, metrics, logging)
- [ ] Authentication is configured (API keys)
- [ ] Rate limits are set appropriately
- [ ] Triggers are configured and tested
- [ ] Function has proper error handling
- [ ] Function is idempotent (for retry safety)
- [ ] PII is not logged
- [ ] Resource limits are within cluster quotas
- [ ] Network policies are configured
- [ ] Disaster recovery plan is documented

---

## References

- **ARCHITECTURE.md** — System design deep dive
- **DEV_PLAN.md** — Development checklist
- **README.md** — Quick start and overview
- **config/examples/** — Example function definitions
- **MCP Specification** — https://modelcontextprotocol.io/
- **agent-mesh/AGENTS.md** — Multi-agent orchestration patterns
