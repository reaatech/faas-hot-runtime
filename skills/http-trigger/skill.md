# HTTP Trigger

**Implementation Status:** Fully Implemented

## Capability
Expose serverless functions via RESTful HTTP endpoints with automatic routing, authentication, and response formatting.

## MCP Tools
| Tool | Input Schema | Output | Rate Limit |
|------|-------------|--------|------------|
| `get_http_endpoints` | `{ function?: string }` | `{ endpoints: HTTPEndpoint[] }` | 60/min |
| `test_http_endpoint` | `{ path: string, method: string, body?: object }` | `{ status: number, body: any, duration_ms: number }` | 30/min |

### HTTPEndpoint Schema
```typescript
interface HTTPEndpoint {
  function: string;
  path: string;
  methods: string[];
  auth_required: boolean;
  rate_limit: number;
}
```

## Usage Examples

### Example 1: List HTTP endpoints
- User intent: "What HTTP endpoints are available?"
- Tool call: `get_http_endpoints`
- Expected response: Array of endpoints with paths and methods

### Example 2: Test an endpoint
- User intent: "Test the /process-payment endpoint with a sample payload"
- Tool call: `test_http_endpoint` with `path: "/process-payment"`, `method: "POST"`, `body: { amount: 1000 }`
- Expected response: HTTP status, response body, and execution duration

## HTTP Configuration

### Path Routing
- Functions are accessible at `/functions/{function-name}`
- Custom paths can be configured in function YAML
- Path parameters supported: `/users/{user_id}/orders`

### Methods
- GET, POST, PUT, PATCH, DELETE supported
- Method defaults to POST if not specified
- HEAD and OPTIONS handled automatically for CORS

### Request Format
- Content-Type: application/json (default)
- Request body passed as function input
- Query parameters merged with body
- Path parameters extracted and passed as context

### Response Format
- Content-Type: application/json (default)
- Status code from function response (default 200)
- Response body serialized as JSON
- Error responses include error type and message

## Error Handling
- **404 Not Found**: Unknown path or function
- **405 Method Not Allowed**: Unsupported HTTP method
- **400 Bad Request**: Invalid JSON or missing required fields
- **401 Unauthorized**: Missing or invalid API key
- **429 Too Many Requests**: Rate limit exceeded
- **500 Internal Server Error**: Function execution failed
- **504 Gateway Timeout**: Function execution timed out

### Known failure modes
- Malformed JSON → 400 with parse error details
- Missing auth header → 401 with auth instructions
- Rate limit exceeded → 429 with Retry-After header
- Function timeout → 504 with timeout details

### Recovery strategies
- Automatic retry for idempotent GET requests
- Request queuing during high load
- Graceful degradation when backends are overloaded

### Escalation paths
- Repeated 4xx errors trigger security alerts
- High 5xx rate triggers incident response
- Rate limit breaches trigger capacity planning

## Security Considerations
- **HTTPS required**: All production endpoints use TLS
- **CORS headers**: Configurable per function
- **Request size limits**: Default 10MB, configurable
- **Input sanitization**: XSS and injection prevention
- **Rate limiting**: Per-client and per-endpoint limits
- **API key validation**: Required for authenticated endpoints
- **Security headers**: CSP, HSTS, X-Frame-Options
