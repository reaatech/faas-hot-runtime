import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PubSubTriggerHandler } from '../../../src/triggers/pubsub-trigger.js';
import { PubSubTrigger } from '../../../src/triggers/pubsub-trigger.js';
import type { FunctionDefinition, InvocationResult } from '../../../src/types/index.js';

vi.mock('@google-cloud/pubsub', () => ({
  PubSub: vi.fn().mockImplementation(() => ({
    subscription: vi.fn().mockReturnValue({
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

const createMockHandler = () => ({
  handleRequest: vi.fn<() => Promise<InvocationResult>>().mockResolvedValue({
    success: true,
    content: [{ type: 'text', text: 'OK' }],
    metadata: { function: 'test', pod: 'pod-1', duration_ms: 10, cost_usd: 0.0001, cold_start: false },
  }),
});

describe('PubSubTrigger', () => {
  let trigger: PubSubTrigger;
  let mockHandler: ReturnType<typeof createMockHandler>;

  const mockFunction: FunctionDefinition = {
    name: 'test-function',
    description: 'Test function',
    version: '1.0.0',
    container: { image: 'test:latest', port: 8080, resources: { cpu: '100m', memory: '128Mi', gpu: 0 } },
    pool: { min_size: 1, max_size: 5, target_utilization: 0.7, warm_up_time_seconds: 30 },
    triggers: [{ type: 'pubsub' as const, topic: 'test-topic', subscription: 'test-sub' }],
    mcp: { enabled: false, tool_name: 'test', description: 'test', input_schema: { type: 'object', properties: {} } },
    cost: { budget_daily: 10, cost_per_invocation_estimate: 0.0001, alert_thresholds: [0.5, 0.75, 0.9] },
    observability: { tracing_enabled: true, metrics_enabled: true, log_level: 'info' },
  };

  beforeEach(() => {
    trigger = new PubSubTrigger({
      projectId: 'test-project',
      topicName: 'test-topic',
      subscriptionName: 'test-sub',
      maxMessages: 10,
      ackDeadlineSeconds: 30,
    });
    mockHandler = createMockHandler();
  });

  afterEach(async () => {
    await trigger.stop();
  });

  it('should create trigger instance', () => {
    expect(trigger).toBeInstanceOf(PubSubTrigger);
  });

  it('should register a function', () => {
    trigger.registerFunction(mockFunction, mockHandler as unknown as PubSubTriggerHandler);
  });

  it('should unregister a function', () => {
    trigger.registerFunction(mockFunction, mockHandler as unknown as PubSubTriggerHandler);
    trigger.unregisterFunction('test-function');
  });

  it('should start and stop gracefully', async () => {
    trigger.registerFunction(mockFunction, mockHandler as unknown as PubSubTriggerHandler);
    await trigger.start();
    await trigger.stop();
  });
});
