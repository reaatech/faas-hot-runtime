# faas-hot-runtime

**Lambda without cold starts, exposed as MCP tools for AI agents.**

MCP-native FaaS runtime with warm pod pools for sub-100ms invocations. Functions are exposed as MCP tools — point an AI agent at the MCP endpoint and your functions become callable tools. Supports HTTP and queue triggers (SQS primary, Pub/Sub secondary), built on EKS with multi-K8s support, and includes comprehensive OpenTelemetry observability and cost tracking.

## Features

- **Sub-100ms Invocation** — Warm pool eliminates cold starts
- **MCP-Native** — Functions are MCP tools first, HTTP endpoints second
- **Cost Transparency** — Every invocation's cost is tracked and reportable
- **Observability Built-In** — OpenTelemetry tracing for every invocation
- **Multi-Cloud Kubernetes** — Works on EKS, GKE, AKS with minimal changes
- **Zero-Downtime Updates** — Hot-reload function definitions without service interruption

## Quick Start

### Prerequisites

- Node.js 22+
- Kubernetes cluster (EKS, GKE, AKS, or local k3d/minikube)
- Docker

### Installation

```bash
# Install from npm
npm install faas-hot-runtime

# Or clone and build from source
git clone https://github.com/reaatech/faas-hot-runtime.git
cd faas-hot-runtime
npm install
npm run build
```

### Local Development

```bash
# Set up environment
cp .env.example .env
# Edit .env with your configuration

# Start the development server
npm run dev

# Or use the CLI
npx faas-hot-runtime start --port 8080 --config-dir ./config/functions
```

### Define a Function

Create a function definition in `config/functions/hello-world.yaml`:

```yaml
name: hello-world
description: Simple greeting function
version: 1.0.0

container:
  image: myregistry/hello-world:latest
  port: 8080
  resources:
    cpu: 100m
    memory: 128Mi

pool:
  min_size: 2
  max_size: 10
  target_utilization: 0.7
  warm_up_time_seconds: 30

triggers:
  - type: http
    path: /hello
    methods: [GET, POST]

mcp:
  enabled: true
  tool_name: hello_world
  description: Generate a greeting message
  input_schema:
    type: object
    properties:
      name:
        type: string
        description: Name to greet
    required: [name]

cost:
  budget_daily: 10.00
  cost_per_invocation_estimate: 0.0001

observability:
  tracing_enabled: true
  metrics_enabled: true
  log_level: info
```

### Invoke via MCP

Point your AI agent at the MCP endpoint:

```bash
# The MCP server exposes functions as tools
curl -H "X-API-Key: your-api-key" \
  -X POST http://localhost:8080/mcp \
  -d '{"jsonrpc":"2.0","method":"tools/list"}'
```

### Invoke via HTTP

```bash
curl -X POST http://localhost:8080/hello \
  -H "Content-Type: application/json" \
  -d '{"name": "World"}'
```

## CLI Commands

```bash
# Start the runtime server
faas-hot-runtime start --port 8080 --config-dir ./config/functions

# Invoke a function directly
faas-hot-runtime invoke hello-world --args '{"name":"World"}'

# List all registered functions
faas-hot-runtime list

# Stream function logs
faas-hot-runtime logs hello-world --follow

# Show function metrics
faas-hot-runtime metrics hello-world --period 1h

# Show cost breakdown
faas-hot-runtime cost --period 1d

# Validate function configurations
faas-hot-runtime validate --config-dir ./config/functions
```

## Architecture

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
```

### Components

| Component | Description |
|-----------|-------------|
| **MCP Server** | Exposes functions as MCP tools |
| **Function Registry** | YAML-based function definitions with hot-reload |
| **Warm Pool Manager** | Pre-warmed pods for sub-100ms invoke |
| **Invocation Engine** | Routes requests to available pods |
| **Trigger Handlers** | HTTP, SQS, Pub/Sub event handling |
| **Cost Tracker** | Per-invocation cost accounting |

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_PORT` | Port for MCP server | `8080` |
| `MCP_HOST` | Host for MCP server | `0.0.0.0` |
| `API_KEY` | API key for authentication | - |
| `LOG_LEVEL` | Log level (debug, info, warn, error) | `info` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint for tracing | - |

### Function YAML Schema

See [AGENTS.md](./AGENTS.md) for the complete function YAML schema reference.

## Observability

The runtime emits OpenTelemetry traces and metrics:

### Traces

- `faas.invoke` — Full invocation trace
- `pool.select` — Pod selection trace
- `function.execute` — Function execution trace
- `cost.calculate` — Cost calculation trace

### Metrics

- `faas.invocations.total` — Total invocations
- `faas.invocations.duration_ms` — Invocation latency
- `faas.cold_starts.total` — Cold start count
- `faas.pool.utilization` — Pool utilization
- `faas.cost.total` — Total cost

## Cost Management

Every invocation includes cost metadata:

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

Budget limits can be configured per-function or globally.

## Security

- **API Key Authentication** — All MCP endpoints require authentication
- **Input Validation** — JSON Schema validation for all inputs
- **Rate Limiting** — Per-client rate limits to prevent abuse
- **Pod Isolation** — Functions run in isolated pods with network policies

## Documentation

- [AGENTS.md](./AGENTS.md) — Agent development guide
- [ARCHITECTURE.md](./ARCHITECTURE.md) — System design deep dive
- [DEV_PLAN.md](./DEV_PLAN.md) — Development checklist
- [skills/](./skills/) — Skill definitions for AI agents

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.

## License

MIT
