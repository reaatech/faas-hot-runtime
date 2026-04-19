# OpenTelemetry Instrumentation

**Implementation Status:** Fully Implemented

## Capability
Provide comprehensive observability for serverless function invocations through OpenTelemetry tracing, metrics, and structured logging with GenAI semantic conventions.

## MCP Tools
| Tool | Input Schema | Output | Rate Limit |
|------|-------------|--------|------------|
| `get_traces` | `{ function?: string, trace_id?: string, limit?: number }` | `{ traces: TraceSummary[] }` | 60/min |
| `get_metrics` | `{ function?: string, metric_names?: string[], range?: string }` | `{ metrics: MetricData[] }` | 60/min |
| `get_logs` | `{ function?: string, level?: string, request_id?: string, limit?: number }` | `{ logs: LogEntry[] }` | 60/min |

### TraceSummary Schema
```typescript
interface TraceSummary {
  trace_id: string;
  span_count: number;
  duration_ms: number;
  start_time: string;
  root_span: {
    name: string;
    status: 'OK' | 'ERROR' | 'UNSET';
    function: string;
  };
  spans: SpanSummary[];
}

interface SpanSummary {
  span_id: string;
  parent_span_id?: string;
  name: string;
  kind: 'SERVER' | 'CLIENT' | 'INTERNAL';
  duration_ms: number;
  status: 'OK' | 'ERROR' | 'UNSET';
  attributes: Record<string, any>;
}
```

### MetricData Schema
```typescript
interface MetricData {
  name: string;
  type: 'counter' | 'gauge' | 'histogram';
  points: MetricPoint[];
}

interface MetricPoint {
  timestamp: string;
  value: number;
  labels: Record<string, string>;
}
```

### LogEntry Schema
```typescript
interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  service: string;
  request_id: string;
  trace_id: string;
  span_id: string;
  message: string;
  attributes: Record<string, any>;
}
```

## Usage Examples

### Example 1: Get traces for a function
- User intent: "Show me recent traces for process_payment"
- Tool call: `get_traces` with `function: "process_payment"`, `limit: 10`
- Expected response: Array of trace summaries with span details

### Example 2: Get latency metrics
- User intent: "What's the p99 latency for generate_report over the last hour?"
- Tool call: `get_metrics` with `function: "generate_report"`, `metric_names: ["faas.invocations.duration_ms"]`, `range: "1h"`
- Expected response: Histogram data with latency percentiles

### Example 3: Find error logs
- User intent: "Show me error logs for the last failed invocation"
- Tool call: `get_logs` with `level: "error"`, `limit: 20`
- Expected response: Array of error log entries with context

## Tracing

### Span Hierarchy
Every invocation generates a trace with the following span structure:

```
faas.invoke (root)
├── pool.select
├── function.execute
│   ├── http.request (to pod)
│   └── function.handler (inside pod)
├── cost.calculate
└── response.send
```

### Standard Span Attributes
| Attribute | Description |
|-----------|-------------|
| `faas.trigger` | Trigger type (http, sqs, pubsub, mcp) |
| `faas.name` | Function name |
| `faas.instance` | Pod identifier |
| `faas.cold_start` | Whether this was a cold start |
| `faas.duration_ms` | Invocation duration |
| `faas.cost_usd` | Cost of this invocation |
| `http.method` | HTTP method (for HTTP triggers) |
| `http.url` | HTTP URL (for HTTP triggers) |
| `http.status_code` | HTTP response status |

### GenAI Semantic Conventions
For AI/LLM functions, additional attributes are captured:

| Attribute | Description |
|-----------|-------------|
| `gen_ai.operation.name` | Operation type (chat, completion, embedding) |
| `gen_ai.request.model` | Requested model |
| `gen_ai.response.model` | Actual model used |
| `gen_ai.usage.input_tokens` | Input token count |
| `gen_ai.usage.output_tokens` | Output token count |
| `gen_ai.usage.total_tokens` | Total token count |

## Metrics

### Key Metrics
| Metric | Type | Description |
|--------|------|-------------|
| `faas.invocations.total` | Counter | Total invocations by function and status |
| `faas.invocations.duration_ms` | Histogram | Invocation latency distribution |
| `faas.cold_starts.total` | Counter | Cold start count by function |
| `faas.pool.utilization` | Gauge | Pool utilization percentage |
| `faas.pool.size` | Gauge | Current pool size by state |
| `faas.cost.total` | Counter | Total cost in USD |
| `faas.errors.total` | Counter | Error count by type |

### Metric Labels
All metrics include standard labels:
- `function`: Function name
- `status`: Success/failure status
- `trigger`: Trigger type
- `pod`: Pod identifier (where applicable)

## Logging

### Log Structure
All logs are structured JSON with these standard fields:

```json
{
  "timestamp": "2026-04-15T23:00:00Z",
  "service": "faas-hot-runtime",
  "level": "info",
  "message": "Function invoked successfully",
  "request_id": "req-abc123",
  "trace_id": "trace-xyz789",
  "span_id": "span-def456",
  "function": "process_payment",
  "pod": "process-payment-pod-1",
  "duration_ms": 45,
  "cost_usd": 0.000123,
  "cold_start": false
}
```

### Log Levels
| Level | When to Use |
|-------|-------------|
| `debug` | Detailed execution info for development |
| `info` | Normal operation events |
| `warn` | Recoverable issues or degraded performance |
| `error` | Failures that require attention |

### PII Redaction
The logging system automatically redacts:
- Email addresses
- Credit card numbers
- Social security numbers
- API keys and secrets
- Personal identifiers

## Error Handling

### Trace Status
- **OK**: Invocation completed successfully
- **ERROR**: Invocation failed with an error
- **UNSET**: Status not explicitly set

### Error Attributes
Error spans include additional attributes:
- `error.type`: Error class or type
- `error.message`: Error message (sanitized)
- `error.stack`: Stack trace (debug only)

### Known failure modes
- Trace export failure → Local buffering, retry later
- Metric export failure → In-memory aggregation, retry later
- Log export failure → Console fallback, alert triggered

### Recovery strategies
- Automatic retry for transient export failures
- Local buffering during observability backend outages
- Graceful degradation (continue execution, log to console)

### Escalation paths
- High error rate triggers alerts
- Trace loss triggers investigation
- Metric gaps trigger capacity review

## Security Considerations
- **Trace sampling**: Configurable sampling to protect sensitive data
- **Log redaction**: Automatic PII detection and masking
- **Access control**: Observability data requires authentication
- **Data retention**: Configurable retention policies
- **Encryption**: All observability data encrypted in transit and at rest
