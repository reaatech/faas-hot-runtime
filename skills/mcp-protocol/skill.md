# MCP Protocol

**Implementation Status:** Fully Implemented

## Capability
Expose serverless functions as MCP tools for AI agent integration, enabling sub-100ms function invocation via the Model Context Protocol.

## MCP Tools
| Tool | Input Schema | Output | Rate Limit |
|------|-------------|--------|------------|
| `tools/list` | `{}` | `{ tools: MCPTool[] }` | 100/min |
| `tools/call` | `{ name: string, arguments: object }` | `{ content: Content[], metadata: object }` | 1000/min |
| `ping` | `{}` | `{ status: string, uptime_seconds: number, pool_utilization: number }` | 10/min |

### MCPTool Schema
```typescript
interface MCPTool {
  name: string;           // snake_case tool name
  description: string;    // Shown to AI agents for discovery
  inputSchema: object;    // JSON Schema for input validation
}
```

### Content Schema
```typescript
interface Content {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
}
```

## Usage Examples

### Example 1: Discover available functions
- User intent: "What functions can I call?"
- Tool call: `tools/list`
- Expected response: Array of MCP tools with schemas

### Example 2: Invoke a function
- User intent: "Process a payment of $29.99 for customer cust_123"
- Tool call: `tools/call` with `name: "process_payment"`, `arguments: { amount: 2999, customer_id: "cust_123" }`
- Expected response: Success message with transaction ID and cost metadata

### Example 3: Check runtime health
- User intent: "Is the runtime healthy?"
- Tool call: `ping`
- Expected response: Status, uptime, pool utilization

## Error Handling
- **Unknown tool**: Returns error code -32601 (Method not found)
- **Invalid arguments**: Returns error code -32602 (Invalid params) with validation details
- **Function timeout**: Returns error code -32000 with timeout details
- **Budget exceeded**: Returns error code -32000 with budget remaining info
- **Rate limit exceeded**: Returns error code -32000 with Retry-After header

### Known failure modes
- MCP server overloaded → 503 with backoff hint
- Function pod unavailable → Retry with different pod
- Schema validation failure → Detailed error with field paths

### Recovery strategies
- Transient failures: Automatic retry with exponential backoff
- Persistent failures: Circuit breaker opens, requests rejected immediately
- Pool exhaustion: Queue request and scale up pool

### Escalation paths
- Critical errors logged to observability backend
- Budget alerts trigger notifications
- Health check failures trigger auto-scaling

## Security Considerations
- **Authentication**: API key required in `X-API-Key` header
- **Input validation**: All arguments validated against JSON Schema
- **Rate limiting**: Per-client limits to prevent abuse
- **PII handling**: No raw user data logged
- **Pod isolation**: Functions run in isolated pods with network policies
- **Resource quotas**: Prevent resource exhaustion attacks
