/**
 * Core domain types for faas-hot-runtime
 */

/** Function definition loaded from YAML configuration */
export interface FunctionDefinition {
  /** Unique function identifier (lowercase, hyphens) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Semantic version */
  version: string;
  /** Container specification */
  container: ContainerConfig;
  /** Warm pool configuration */
  pool: PoolConfig;
  /** Trigger configurations */
  triggers: TriggerConfig[];
  /** MCP tool configuration */
  mcp: MCPConfig;
  /** Cost configuration */
  cost: CostConfig;
  /** Observability configuration */
  observability: ObservabilityConfig;
}

/** Container specification */
export interface ContainerConfig {
  /** Container image URL */
  image: string;
  /** Port the container listens on */
  port: number;
  /** Resource requirements */
  resources: ResourceConfig;
}

/** Resource requirements */
export interface ResourceConfig {
  /** CPU requirement (e.g., "250m") */
  cpu: string;
  /** Memory requirement (e.g., "256Mi") */
  memory: string;
  /** GPU count (0 for no GPU) */
  gpu: number;
}

/** Warm pool configuration */
export interface PoolConfig {
  /** Minimum warm pods */
  min_size: number;
  /** Maximum warm pods */
  max_size: number;
  /** Scale when utilization exceeds this (default: 0.7) */
  target_utilization: number;
  /** Time to keep pods warm after use (seconds) */
  warm_up_time_seconds: number;
}

/** HTTP trigger configuration */
export interface HTTPTriggerConfig {
  /** Trigger type */
  type: 'http';
  /** HTTP path */
  path: string;
  /** HTTP methods */
  methods?: string[];
  /** Whether authentication is required */
  auth_required?: boolean;
}

/** SQS trigger configuration */
export interface SQSTriggerConfig {
  /** Trigger type */
  type: 'sqs';
  /** SQS queue name */
  queue: string;
  /** Batch size */
  batch_size?: number;
  /** Visibility timeout (seconds) */
  visibility_timeout_seconds?: number;
}

/** Pub/Sub trigger configuration */
export interface PubSubTriggerConfig {
  /** Trigger type */
  type: 'pubsub';
  /** Pub/Sub topic */
  topic: string;
  /** Subscription name */
  subscription: string;
}

/** Trigger configuration (discriminated union) */
export type TriggerConfig = HTTPTriggerConfig | SQSTriggerConfig | PubSubTriggerConfig;

/** MCP tool configuration */
export interface MCPConfig {
  /** Whether to expose as MCP tool */
  enabled: boolean;
  /** MCP tool name (snake_case) */
  tool_name: string;
  /** Short description for MCP tool discovery */
  description: string;
  /** JSON Schema for inputs */
  input_schema: MCPInputSchema;
}

/** JSON Schema for MCP tool inputs */
export interface MCPInputSchema {
  /** Schema type (always "object") */
  type: 'object';
  /** Property definitions */
  properties: Record<string, MCPPropertySchema>;
  /** Required properties */
  required?: string[];
}

/** Property schema definition */
export interface MCPPropertySchema {
  /** Property type */
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  /** Property description */
  description?: string;
  /** Default value */
  default?: unknown;
  /** Enum values (for string types) */
  enum?: string[];
  /** Format (e.g., "date", "email", "uuid") */
  format?: string;
  /** Nested properties (for object types) */
  properties?: Record<string, MCPPropertySchema>;
  /** Required nested properties (for object types) */
  required?: string[];
  /** Item schema (for array types) */
  items?: MCPPropertySchema;
}

/** Cost configuration */
export interface CostConfig {
  /** Daily budget limit (USD) */
  budget_daily: number;
  /** Monthly budget limit (USD) */
  budget_monthly?: number;
  /** Estimated cost per invocation (USD) */
  cost_per_invocation_estimate: number;
  /** Alert thresholds (e.g., [0.5, 0.75, 0.9]) */
  alert_thresholds: number[];
  /** Whether to enforce hard limit */
  hard_limit?: boolean;
}

/** Observability configuration */
export interface ObservabilityConfig {
  /** Whether tracing is enabled */
  tracing_enabled: boolean;
  /** Whether metrics are enabled */
  metrics_enabled: boolean;
  /** Log level */
  log_level: 'debug' | 'info' | 'warn' | 'error';
}

/** Invocation request */
export interface InvocationRequest {
  /** Function name to invoke */
  function: string;
  /** Invocation arguments */
  arguments: Record<string, unknown>;
  /** Request ID for tracing */
  request_id: string;
  /** Client identifier */
  client_id?: string;
  /** Invocation timeout (ms) */
  timeout_ms?: number;
}

/** Invocation result */
export interface InvocationResult {
  /** Whether the invocation was successful */
  success: boolean;
  /** Function output content */
  content: InvocationContent[];
  /** Execution metadata */
  metadata: InvocationMetadata;
  /** Error information (if failed) */
  error?: InvocationError;
}

/** Text content item */
export interface TextContent {
  type: 'text';
  text: string;
}

/** Image content item */
export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

/** Resource content item */
export interface ResourceContent {
  type: 'resource';
  uri: string;
  mimeType?: string;
}

/** Content item in invocation result (discriminated union) */
export type InvocationContent = TextContent | ImageContent | ResourceContent;

/** Invocation metadata */
export interface InvocationMetadata {
  /** Function name */
  function: string;
  /** Pod identifier */
  pod: string;
  /** Execution duration (ms) */
  duration_ms: number;
  /** Cost in USD */
  cost_usd: number;
  /** Whether this was a cold start */
  cold_start: boolean;
  /** Cost breakdown */
  cost_breakdown?: CostBreakdown;
}

/** Cost breakdown */
export interface CostBreakdown {
  /** Compute cost */
  compute: number;
  /** Network cost */
  network: number;
  /** Queue cost */
  queue: number;
}

/** Invocation error */
export interface InvocationError {
  /** Error type */
  error_type: string;
  /** Error message */
  error_message: string;
  /** Stack trace (for debugging) */
  stack_trace?: string;
}

/** Warm pool state */
export interface WarmPoolState {
  /** Function name */
  function: string;
  /** Total pods in pool */
  total_pods: number;
  /** Available (warm) pods */
  available_pods: number;
  /** Active (invoking) pods */
  active_pods: number;
  /** Cooling pods */
  cooling_pods: number;
  /** Pool utilization (0-1) */
  utilization: number;
  /** Pod health states */
  pod_states: PodHealth[];
}

/** Individual pod health metrics */
export interface PodHealth {
  /** Pod identifier */
  pod_id: string;
  /** Pod state */
  state: 'warm' | 'active' | 'cooling' | 'terminated' | 'unhealthy';
  /** Current invocations count */
  active_invocations: number;
  /** Recent latency (ms) */
  recent_latency_ms: number;
  /** Health check status */
  healthy: boolean;
  /** Last health check timestamp */
  last_health_check: Date;
  /** Pod creation timestamp */
  created_at: Date;
}

/** Scaling policy */
export interface ScalingPolicy {
  /** Function name */
  function: string;
  /** Minimum pool size */
  min_size: number;
  /** Maximum pool size */
  max_size: number;
  /** Target utilization */
  target_utilization: number;
  /** Scale up threshold */
  scale_up_threshold: number;
  /** Scale down threshold */
  scale_down_threshold: number;
  /** Cooldown period (seconds) */
  cooldown_seconds: number;
}

/** Cost record for tracking */
export interface CostRecord {
  /** Record ID */
  id: string;
  /** Function name */
  function: string;
  /** Request ID */
  request_id: string;
  /** Timestamp */
  timestamp: Date;
  /** Cost in USD */
  cost_usd: number;
  /** Cost breakdown */
  breakdown: CostBreakdown;
  /** Duration (ms) */
  duration_ms: number;
  /** Pod identifier */
  pod_id: string;
}

/** OTel configuration */
export interface OTelConfig {
  /** OTLP endpoint */
  otlp_endpoint: string;
  /** Service name */
  service_name: string;
  /** Service version */
  service_version: string;
  /** Resource attributes */
  resource_attributes: Record<string, string>;
  /** Whether to enable tracing */
  tracing_enabled: boolean;
  /** Whether to enable metrics */
  metrics_enabled: boolean;
}
