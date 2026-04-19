# Queue Trigger

**Implementation Status:** Fully Implemented

## Capability
Process asynchronous events from message queues (SQS, Pub/Sub) with automatic batching, visibility timeout management, and dead-letter handling.

## MCP Tools
| Tool | Input Schema | Output | Rate Limit |
|------|-------------|--------|------------|
| `get_queue_status` | `{ function?: string, queue?: string }` | `{ queues: QueueStatus[] }` | 60/min |
| `get_dlq_messages` | `{ queue: string, max_messages?: number }` | `{ messages: DLQMessage[] }` | 30/min |
| `replay_dlq` | `{ queue: string, message_ids?: string[] }` | `{ replayed: number, failed: number }` | 10/min |

### QueueStatus Schema
```typescript
interface QueueStatus {
  queue_name: string;
  function: string;
  approximate_messages: number;
  in_flight: number;
  delay_seconds: number;
  visibility_timeout_seconds: number;
  dlq_messages: number;
  last_processed: string;
}
```

### DLQMessage Schema
```typescript
interface DLQMessage {
  message_id: string;
  body: any;
  attributes: Record<string, string>;
  received_count: number;
  first_received: string;
  last_modified: string;
  failure_reason?: string;
}
```

## Usage Examples

### Example 1: Check queue status
- User intent: "How many messages are pending in the payment queue?"
- Tool call: `get_queue_status` with `queue: "payment-processing-queue"`
- Expected response: Queue depth, in-flight count, DLQ count

### Example 2: Inspect dead-letter queue
- User intent: "Show me the failed messages in the payment DLQ"
- Tool call: `get_dlq_messages` with `queue: "payment-dlq"`, `max_messages: 10`
- Expected response: Array of failed messages with failure reasons

### Example 3: Replay failed messages
- User intent: "Replay all messages from the payment DLQ"
- Tool call: `replay_dlq` with `queue: "payment-dlq"`
- Expected response: Count of replayed and failed messages

## Queue Configuration

### SQS Configuration
- **Polling interval**: How often to check for new messages
- **Batch size**: Number of messages to process per invocation
- **Visibility timeout**: Time before message becomes visible again
- **Message retention**: How long to keep unprocessed messages
- **DLQ attachment**: Queue for failed messages

### Pub/Sub Configuration
- **Subscription**: Pub/Sub subscription name
- **Ack deadline**: Time to acknowledge message before redelivery
- **Retain acked messages**: Whether to keep processed messages
- **Expiration policy**: When to expire unprocessed messages

### Batch Processing
- Messages are batched for efficiency
- Batch size configurable per function
- Partial batch failures handled gracefully
- Failed messages returned to queue or sent to DLQ

## Error Handling
- **Processing timeout**: Message returned to queue after visibility timeout
- **Processing failure**: Message sent to DLQ after max retries
- **Poison pill**: Malformed messages detected and quarantined
- **Queue full**: Backpressure applied to producers
- **DLQ full**: Alerts triggered for manual intervention

### Known failure modes
- Message processing timeout → Message redelivered
- Repeated failures → Message sent to DLQ
- Malformed message → Quarantined, alert triggered
- Queue throttling → Exponential backoff on polling

### Recovery strategies
- Automatic retry with exponential backoff
- DLQ inspection and manual replay
- Circuit breaker for failing functions
- Dead-letter analytics for root cause analysis

### Escalation paths
- DLQ depth threshold triggers alerts
- Processing lag triggers scaling
- Repeated poison pills trigger security review

## Security Considerations
- **Queue encryption**: All queues encrypted at rest
- **IAM policies**: Least-privilege access to queues
- **Message validation**: Schema validation on all messages
- **PII redaction**: Sensitive data masked in logs
- **DLQ access**: Restricted to authorized personnel
- **Replay authorization**: Only authorized users can replay messages
