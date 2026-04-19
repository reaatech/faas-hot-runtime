# Function Scaling

**Implementation Status:** Fully Implemented

## Capability
Automatically scale function pod pools based on traffic patterns, queue depth, and cost constraints to maintain sub-100ms latency while optimizing resource utilization.

## MCP Tools
| Tool | Input Schema | Output | Rate Limit |
|------|-------------|--------|------------|
| `get_scaling_policy` | `{ function: string }` | `{ policy: ScalingPolicy }` | 60/min |
| `update_scaling_policy` | `{ function: string, policy: ScalingPolicyUpdate }` | `{ status: string, policy: ScalingPolicy }` | 10/min |
| `get_scaling_history` | `{ function?: string, range?: string }` | `{ events: ScalingEvent[] }` | 30/min |

### ScalingPolicy Schema
```typescript
interface ScalingPolicy {
  function: string;
  min_pods: number;
  max_pods: number;
  target_utilization: number;
  scale_up_threshold: number;
  scale_down_threshold: number;
  scale_up_cooldown_seconds: number;
  scale_down_cooldown_seconds: number;
  predictive_scaling: boolean;
  cost_limit_daily: number;
}

interface ScalingEvent {
  timestamp: string;
  function: string;
  event_type: 'scale_up' | 'scale_down' | 'cost_limit' | 'manual';
  old_pods: number;
  new_pods: number;
  reason: string;
  triggered_by: string;
}
```

## Usage Examples

### Example 1: Get scaling policy
- User intent: "What's the scaling policy for process_payment?"
- Tool call: `get_scaling_policy` with `function: "process_payment"`
- Expected response: Current scaling configuration with thresholds

### Example 2: Update scaling policy
- User intent: "Increase the max pods for process_payment to 50"
- Tool call: `update_scaling_policy` with `function: "process_payment"`, `policy: { max_pods: 50 }`
- Expected response: Updated policy confirmation

### Example 3: View scaling history
- User intent: "Show me recent scaling events"
- Tool call: `get_scaling_history` with `range: "24h"`
- Expected response: Array of scaling events with reasons

## Scaling Strategies

### Reactive Scaling
Scales based on current metrics:
- **Utilization-based**: Scale when pool utilization exceeds threshold
- **Queue-based**: Scale when queue depth exceeds threshold
- **Latency-based**: Scale when p99 latency exceeds target

### Predictive Scaling
Uses historical patterns to anticipate demand:
- **Time-based**: Scale up before known peak hours
- **Pattern-based**: ML-based prediction from historical data
- **Event-based**: Scale for known events (marketing campaigns, etc.)

### Cost-Aware Scaling
Balances performance with cost:
- **Budget limits**: Stop scaling when daily budget is reached
- **Cost per invocation**: Consider cost when selecting pod sizes
- **Spot instances**: Use spot instances for non-critical functions

## Scaling Parameters

### Pool Size
| Parameter | Description | Default |
|-----------|-------------|---------|
| `min_pods` | Minimum warm pods | 2 |
| `max_pods` | Maximum pods | 100 |
| `target_utilization` | Target utilization % | 0.7 |

### Thresholds
| Parameter | Description | Default |
|-----------|-------------|---------|
| `scale_up_threshold` | Utilization to trigger scale up | 0.8 |
| `scale_down_threshold` | Utilization to trigger scale down | 0.3 |
| `scale_up_cooldown_seconds` | Time between scale up events | 60 |
| `scale_down_cooldown_seconds` | Time between scale down events | 300 |

### Cost Controls
| Parameter | Description | Default |
|-----------|-------------|---------|
| `cost_limit_daily` | Daily budget limit | 100.00 |
| `cost_per_invocation_max` | Max cost per invocation | 0.01 |

## Error Handling
- **Max pods reached**: Queue requests, alert operators
- **Min pods failed**: Auto-replace failed pods
- **Cost limit reached**: Stop scaling, reject non-critical requests
- **Scaling loop detected**: Pause scaling, alert operators

### Known failure modes
- Rapid scale up/down (thrashing) → Cooldown periods enforced
- Stuck scaling operation → Timeout and retry with backoff
- Insufficient cluster resources → Evict lower-priority pods
- Cost anomaly → Freeze scaling, trigger investigation

### Recovery strategies
- Automatic pod replacement on failures
- Gradual scale down to prevent oscillation
- Emergency scale up for critical functions
- Manual override for exceptional situations

### Escalation paths
- Persistent scaling failures trigger incident response
- Cost anomalies trigger finance review
- Resource exhaustion triggers capacity planning
- Performance degradation triggers engineering review

## Security Considerations
- **Resource quotas**: Prevent any function from consuming all cluster resources
- **Priority classes**: Critical functions get higher scheduling priority
- **Pod disruption budgets**: Ensure minimum availability during maintenance
- **Access control**: Scaling policy changes require elevated permissions
- **Audit logging**: All scaling events logged for compliance
