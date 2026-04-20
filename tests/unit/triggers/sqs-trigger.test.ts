import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SQSTrigger } from '../../../src/triggers/sqs-trigger.js';
import type { SQSTriggerHandler } from '../../../src/triggers/sqs-trigger.js';
import type { FunctionDefinition, InvocationResult } from '../../../src/types/index.js';

const createMockHandler = () => ({
  handleRequest: vi.fn<() => Promise<InvocationResult>>().mockResolvedValue({
    success: true,
    content: [{ type: 'text', text: 'OK' }],
    metadata: {
      function: 'test',
      pod: 'pod-1',
      duration_ms: 10,
      cost_usd: 0.0001,
      cold_start: false,
    },
  }),
});

describe('SQSTrigger', () => {
  let trigger: SQSTrigger;
  let mockHandler: ReturnType<typeof createMockHandler>;

  const mockFunction: FunctionDefinition = {
    name: 'test-function',
    description: 'Test function',
    version: '1.0.0',
    container: {
      image: 'test:latest',
      port: 8080,
      resources: { cpu: '100m', memory: '128Mi', gpu: 0 },
    },
    pool: { min_size: 1, max_size: 5, target_utilization: 0.7, warm_up_time_seconds: 30 },
    triggers: [
      { type: 'sqs', queue: 'test-queue', batch_size: 10, visibility_timeout_seconds: 300 },
    ],
    mcp: {
      enabled: false,
      tool_name: 'test',
      description: 'test',
      input_schema: { type: 'object', properties: {} },
    },
    cost: {
      budget_daily: 10,
      cost_per_invocation_estimate: 0.0001,
      alert_thresholds: [0.5, 0.75, 0.9],
    },
    observability: { tracing_enabled: true, metrics_enabled: true, log_level: 'info' },
  };

  beforeEach(() => {
    trigger = new SQSTrigger({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789/test-queue',
      region: 'us-east-1',
      accountId: '123456789',
      queueName: 'test-queue',
      batchSize: 10,
      visibilityTimeoutSeconds: 300,
      maxReceiveCount: 3,
      pollIntervalMs: 1000,
    });
    mockHandler = createMockHandler();
  });

  afterEach(async () => {
    await trigger.stop();
  });

  it('should create trigger instance', () => {
    expect(trigger).toBeInstanceOf(SQSTrigger);
  });

  it('should register a function', () => {
    trigger.registerFunction(mockFunction, mockHandler as unknown as SQSTriggerHandler);
    // If no error thrown, test passes
  });

  it('should unregister a function', () => {
    trigger.registerFunction(mockFunction, mockHandler as unknown as SQSTriggerHandler);
    trigger.unregisterFunction('test-function');
  });

  it('should start and stop gracefully', async () => {
    trigger.registerFunction(mockFunction, mockHandler as unknown as SQSTriggerHandler);
    await trigger.start();
    await trigger.stop();
  });
});
