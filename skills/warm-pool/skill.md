# Warm Pool Management

**Implementation Status:** Fully Implemented

## Capability
Maintain a pool of pre-warmed function pods for sub-100ms invocation latency, eliminating cold starts through predictive and reactive scaling.

## MCP Tools
| Tool | Input Schema | Output | Rate Limit |
|------|-------------|--------|------------|
| `get_pool_status` | `{ function: string }` | `{ warm: number, active: number, cooling: number, total: number }` | 60/min |
| `scale_pool` | `{ function: string, min_size: number, max_size: number }` | `{ status: string, new_min: number, new_max: number }` | 10/min |
| `get_pod_health` | `{ function: string, pod_id?: string }` | `{ pods: PodHealth[] }` | 30/min |

### PodHealth Schema
```typescript
interface PodHealth {
  pod_id: string;
  state: 'warm' | 'active' | 'cooling' | 'terminated';
  latency_ms: number;
  last_invocation: string;
  health_check_status: 'healthy' | 'unhealthy' | 'unknown';
  resource_usage: { cpu: number; memory: number };
}
```

## Usage Examples

### Example 1: Check pool status
- User intent: "How many warm pods do I have for process_payment?"
- Tool call: `get_pool_status` with `function: "process_payment"`
- Expected response: Current pool state with warm, active, and cooling counts

### Example 2: Scale pool
- User intent: "Increase the pool size for process_payment to handle more traffic"
- Tool call: `scale_pool` with `function: "process_payment"`, `min_size: 5`, `max_size: 20`
- Expected response: Confirmation of new pool limits

### Example 3: Check pod health
- User intent: "Are all pods healthy?"
- Tool call: `get_pod_health` with `function: "process_payment"`
- Expected response: Array of pod health statuses

## Pod Lifecycle

### States
- **WARM**: Pod is initialized and ready to accept invocations
- **ACTIVE**: Pod is currently executing a function
- **COOLING**: Pod just finished an invocation, being kept warm for reuse
- **TERMINATED**: Pod is being shut down and removed from pool

### State Transitions
```
WARM → ACTIVE → COOLING → WARM (cycle continues)
  ↑                              │
  └──────────────────────────────┘ (or TERMINATED if pool is too large)
```

## Error Handling
- **Pool exhausted**: Queue request and trigger scale-up
- **Unhealthy pod**: Remove from pool and create replacement
- **Scale limit reached**: Return error with current limits and suggestion
- **Health check timeout**: Mark pod as unhealthy, trigger replacement

### Known failure modes
- Pod crash during warm-up → Auto-recreate
- Network partition → Isolate affected pods
- Resource exhaustion → Evict lowest-priority pods
- Stuck in COOLING state → Force terminate after timeout

### Recovery strategies
- Predictive scaling based on traffic patterns
- Reactive scaling based on queue depth
- Cost-aware scaling to balance latency vs cost
- Automatic pod replacement on health check failures

### Escalation paths
- Critical pool health issues trigger alerts
- Persistent scaling failures trigger manual intervention
- Cost anomalies trigger budget alerts

## Security Considerations
- **Pod isolation**: Each pod runs in isolated namespace with network policies
- **Resource quotas**: Prevent any single function from consuming all resources
- **Security contexts**: Pods run with minimal privileges (non-root, read-only FS)
- **Image verification**: Only signed images from trusted registries allowed
- **Secret management**: Secrets injected via Kubernetes secrets, never logged
