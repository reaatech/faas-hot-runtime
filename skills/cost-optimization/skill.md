# Cost Optimization

**Implementation Status:** Fully Implemented

## Capability
Track and optimize costs for serverless function invocations with per-request cost calculation, budget enforcement, and cost-aware routing decisions.

## MCP Tools
| Tool | Input Schema | Output | Rate Limit |
|------|-------------|--------|------------|
| `get_cost_report` | `{ function?: string, range?: string, granularity?: 'hourly' | 'daily' | 'monthly' }` | `{ report: CostReport }` | 60/min |
| `get_budget_status` | `{ function?: string }` | `{ budgets: BudgetStatus[] }` | 60/min |
| `update_budget` | `{ function: string, daily_limit: number, alert_thresholds?: number[] }` | `{ status: string, budget: BudgetConfig }` | 10/min |
| `estimate_cost` | `{ function: string, input_size?: number, expected_duration_ms?: number }` | `{ estimate: CostEstimate }` | 120/min |

### CostReport Schema
```typescript
interface CostReport {
  period: { start: string; end: string };
  total_cost_usd: number;
  total_invocations: number;
  avg_cost_per_invocation: number;
  functions: FunctionCost[];
  breakdown: CostBreakdown;
  trends: CostTrend[];
}

interface FunctionCost {
  function: string;
  invocations: number;
  total_cost_usd: number;
  avg_cost_per_invocation: number;
  compute_cost: number;
  network_cost: number;
  queue_cost: number;
}

interface CostBreakdown {
  compute: number;
  network: number;
  queue: number;
  gpu: number;
  storage: number;
}

interface CostTrend {
  timestamp: string;
  cost_usd: number;
  invocations: number;
}
```

### BudgetStatus Schema
```typescript
interface BudgetStatus {
  function: string;
  daily_limit: number;
  daily_spent: number;
  remaining: number;
  percentage_used: number;
  alert_thresholds: number[];
  alerts_triggered: boolean;
  projected_overrun: boolean;
}

interface BudgetConfig {
  function: string;
  daily_limit: number;
  alert_thresholds: number[];
  hard_limit: boolean;
}
```

### CostEstimate Schema
```typescript
interface CostEstimate {
  function: string;
  estimated_cost_usd: number;
  confidence: 'low' | 'medium' | 'high';
  factors: {
    compute: number;
    network: number;
    queue: number;
  };
  based_on: {
    avg_duration_ms: number;
    avg_input_size: number;
    avg_output_size: number;
  };
}
```

## Usage Examples

### Example 1: Get cost report
- User intent: "Show me the cost breakdown for last week"
- Tool call: `get_cost_report` with `range: "7d"`, `granularity: "daily"`
- Expected response: Cost report with daily breakdown by function

### Example 2: Check budget status
- User intent: "How much budget is left for process_payment?"
- Tool call: `get_budget_status` with `function: "process_payment"`
- Expected response: Current budget status with remaining amount

### Example 3: Estimate function cost
- User intent: "How much would it cost to run generate_report 1000 times?"
- Tool call: `estimate_cost` with `function: "generate_report"`
- Expected response: Cost estimate with confidence level

## Cost Calculation

### Cost Components
| Component | Calculation | Rate Source |
|-----------|-------------|-------------|
| **Compute** | (CPU millicores + Memory MB) × Duration (seconds) × Rate | Cloud provider pricing |
| **Network** | Data transferred (GB) × Network rate | Cloud provider pricing |
| **Queue** | Number of operations × Operation rate | SQS/Pub/Sub pricing |
| **GPU** | GPU count × Duration (seconds) × GPU rate | Cloud provider pricing |
| **Storage** | Storage used (GB-month) × Storage rate | Cloud provider pricing |

### Cost per Invocation
```
total_cost = compute_cost + network_cost + queue_cost + gpu_cost + storage_cost
```

### Real-time Tracking
- Cost calculated for every invocation
- Cost included in MCP response metadata
- Cost accumulated for budget tracking
- Cost anomalies detected and alerted

## Budget Management

### Budget Configuration
| Setting | Description | Default |
|---------|-------------|---------|
| `daily_limit` | Maximum daily spend | 100.00 |
| `alert_thresholds` | Percentage thresholds for alerts | [0.5, 0.75, 0.9] |
| `hard_limit` | Stop invocations when limit reached | false |

### Alert Behavior
- **50% threshold**: Info notification
- **75% threshold**: Warning notification
- **90% threshold**: Critical notification
- **100% (hard limit)**: Reject new invocations with 429

### Budget Enforcement
- **Soft limit**: Warnings only, invocations continue
- **Hard limit**: Invocations rejected when budget exceeded
- **Graceful degradation**: Non-critical functions stopped first

## Cost Optimization Strategies

### Right-sizing
- Match pod resources to actual usage
- Use smaller pods for lightweight functions
- Use larger pods for CPU/memory intensive functions

### Scheduling
- Run non-urgent functions during off-peak hours
- Batch similar functions together
- Use spot instances for non-critical workloads

### Caching
- Cache frequently accessed data
- Reuse warm pods for related functions
- Implement result caching where appropriate

### Monitoring
- Track cost per function continuously
- Identify expensive outliers
- Set up cost anomaly alerts

## Error Handling
- **Budget exceeded**: Return 429 with budget remaining info
- **Cost calculation failure**: Use fallback estimate, log error
- **Budget sync failure**: Use cached budget, retry later

### Known failure modes
- Cost calculation drift → Periodic reconciliation with cloud provider
- Budget sync delay → Local caching with TTL
- Cost anomaly → Freeze spending, trigger investigation

### Recovery strategies
- Automatic budget reset at midnight (configurable)
- Emergency budget increase for critical functions
- Cost anomaly detection and alerting
- Graceful degradation when budget is low

### Escalation paths
- Budget overrun triggers finance review
- Cost anomaly triggers engineering investigation
- Persistent budget issues trigger architecture review

## Security Considerations
- **Budget isolation**: Each function/team has separate budget
- **Access control**: Budget changes require elevated permissions
- **Audit logging**: All budget events logged for compliance
- **Cost data encryption**: Cost data encrypted in transit and at rest
- **PII protection**: No sensitive data in cost reports
