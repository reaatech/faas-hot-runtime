import { z } from 'zod';

/**
 * Zod schemas for faas-hot-runtime configuration validation
 */

// Resource configuration schema
export const ResourceConfigSchema = z.object({
  cpu: z.string().min(1, 'CPU requirement is required'),
  memory: z.string().min(1, 'Memory requirement is required'),
  gpu: z.number().int().min(0).default(0),
});

// Container configuration schema
export const ContainerConfigSchema = z.object({
  image: z.string().min(1, 'Container image is required'),
  port: z.number().int().min(1).max(65535),
  resources: ResourceConfigSchema,
});

// Pool configuration schema
export const PoolConfigSchema = z
  .object({
    min_size: z.number().int().min(0),
    max_size: z.number().int().min(1),
    target_utilization: z.number().min(0).max(1).default(0.7),
    warm_up_time_seconds: z.number().int().min(0).default(30),
  })
  .refine((data) => data.min_size <= data.max_size, {
    message: 'min_size must be less than or equal to max_size',
    path: ['min_size'],
  });

// MCP property schema (recursive - using any for self-reference)
// Not exported - used internally for MCPInputSchemaSchema
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MCPPropertySchema: any = z.lazy(() =>
  z.object({
    type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
    description: z.string().optional(),
    default: z.unknown().optional(),
    enum: z.array(z.string()).optional(),
    format: z.string().optional(),
    properties: z.record(MCPPropertySchema).optional(),
    required: z.array(z.string()).optional(),
    items: MCPPropertySchema.optional(),
  }),
);

// MCP input schema
export const MCPInputSchemaSchema = z.object({
  type: z.literal('object'),
  properties: z.record(MCPPropertySchema),
  required: z.array(z.string()).optional(),
});

// MCP configuration schema
export const MCPConfigSchema = z.object({
  enabled: z.boolean(),
  tool_name: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, 'Tool name must be snake_case starting with lowercase letter'),
  description: z.string().min(1, 'Description is required'),
  input_schema: MCPInputSchemaSchema,
});

// Trigger configuration schema
export const HTTPTriggerSchema = z.object({
  type: z.literal('http'),
  path: z.string().startsWith('/', 'HTTP path must start with /'),
  methods: z.array(z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])).optional(),
  auth_required: z.boolean().optional().default(true),
});

export const SQSTriggerSchema = z.object({
  type: z.literal('sqs'),
  queue: z.string().min(1, 'SQS queue name is required'),
  batch_size: z.number().int().min(1).max(10000).optional(),
  visibility_timeout_seconds: z.number().int().min(0).optional(),
});

export const PubSubTriggerSchema = z.object({
  type: z.literal('pubsub'),
  topic: z.string().min(1, 'Pub/Sub topic is required'),
  subscription: z.string().min(1, 'Subscription name is required'),
});

export const TriggerConfigSchema = z.union([
  HTTPTriggerSchema,
  SQSTriggerSchema,
  PubSubTriggerSchema,
]);

// Cost configuration schema
export const CostConfigSchema = z.object({
  budget_daily: z.number().positive('Daily budget must be positive'),
  budget_monthly: z.number().positive('Monthly budget must be positive').optional(),
  cost_per_invocation_estimate: z.number().nonnegative('Cost estimate must be non-negative'),
  alert_thresholds: z.array(z.number().min(0).max(1)).default([0.5, 0.75, 0.9]),
  hard_limit: z.boolean().optional().default(false),
});

// Observability configuration schema
export const ObservabilityConfigSchema = z.object({
  tracing_enabled: z.boolean().default(true),
  metrics_enabled: z.boolean().default(true),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

// Function definition schema
export const FunctionDefinitionSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, 'Function name must be lowercase with hyphens, starting with a letter'),
  description: z.string().min(1, 'Description is required'),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/, 'Version must be semantic version (e.g., 1.0.0, 1.0.0-beta.1)'),
  container: ContainerConfigSchema,
  pool: PoolConfigSchema,
  triggers: z.array(TriggerConfigSchema).min(1, 'At least one trigger is required'),
  mcp: MCPConfigSchema,
  cost: CostConfigSchema,
  observability: ObservabilityConfigSchema,
});

// Invocation request schema
export const InvocationRequestSchema = z.object({
  function: z.string().min(1, 'Function name is required'),
  arguments: z.record(z.unknown()),
  request_id: z.string().min(1, 'Request ID is required'),
  client_id: z.string().optional(),
  timeout_ms: z.number().int().min(100).max(300000).optional(),
});

// Warm pool configuration schema (for runtime)
export const WarmPoolConfigSchema = z.object({
  function: z.string().optional(),
  min_size: z.number().int().min(0),
  max_size: z.number().int().min(1),
  target_utilization: z.number().min(0).max(1).default(0.7),
  scale_up_threshold: z.number().min(0).max(1).default(0.8),
  scale_down_threshold: z.number().min(0).max(1).default(0.3),
  cooldown_seconds: z.number().int().min(0).default(60),
});

// Inferred type for WarmPoolConfig (used by schemas only)
export type WarmPoolConfig = z.infer<typeof WarmPoolConfigSchema>;
