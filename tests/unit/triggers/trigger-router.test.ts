import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TriggerRouter } from '../../../src/triggers/trigger-router.js';
import { HTTPTrigger } from '../../../src/triggers/http-trigger.js';
import { SQSTrigger } from '../../../src/triggers/sqs-trigger.js';
import { PubSubTrigger } from '../../../src/triggers/pubsub-trigger.js';
import type { FunctionDefinition, InvocationResult } from '../../../src/types/index.js';
import type { HTTPTriggerHandler } from '../../../src/triggers/http-trigger.js';
import type { SQSTriggerHandler } from '../../../src/triggers/sqs-trigger.js';
import type { PubSubTriggerHandler } from '../../../src/triggers/pubsub-trigger.js';

vi.mock('@google-cloud/pubsub', () => ({
  PubSub: vi.fn().mockImplementation(() => ({
    subscription: vi.fn().mockReturnValue({
      on: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
    }),
    topic: vi.fn().mockReturnValue({
      createSubscription: vi.fn().mockResolvedValue([{}]),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

const createMockHTTPHandler = () => ({
  handleRequest: vi.fn<() => Promise<InvocationResult>>().mockResolvedValue({
    success: true,
    content: [{ type: 'text', text: 'OK' }],
    metadata: { function: 'test', pod: 'pod-1', duration_ms: 10, cost_usd: 0.0001, cold_start: false },
  }),
});

const createMockSQSHandler = () => ({
  handleRequest: vi.fn<() => Promise<InvocationResult>>().mockResolvedValue({
    success: true,
    content: [{ type: 'text', text: 'OK' }],
    metadata: { function: 'test', pod: 'pod-1', duration_ms: 10, cost_usd: 0.0001, cold_start: false },
  }),
});

const createMockPubSubHandler = () => ({
  handleRequest: vi.fn<() => Promise<InvocationResult>>().mockResolvedValue({
    success: true,
    content: [{ type: 'text', text: 'OK' }],
    metadata: { function: 'test', pod: 'pod-1', duration_ms: 10, cost_usd: 0.0001, cold_start: false },
  }),
});

describe('TriggerRouter', () => {
  let router: TriggerRouter;
  let startSpy: ReturnType<typeof vi.spyOn>;
  let stopSpy: ReturnType<typeof vi.spyOn>;
  let registerSpy: ReturnType<typeof vi.spyOn>;
  let unregisterSpy: ReturnType<typeof vi.spyOn>;
  let sqsStartSpy: ReturnType<typeof vi.spyOn>;
  let pubSubStartSpy: ReturnType<typeof vi.spyOn>;
  let pubSubStopSpy: ReturnType<typeof vi.spyOn>;

  const httpFunction: FunctionDefinition = {
    name: 'http-function',
    description: 'HTTP function',
    version: '1.0.0',
    container: { image: 'test:latest', port: 8080, resources: { cpu: '100m', memory: '128Mi', gpu: 0 } },
    pool: { min_size: 1, max_size: 5, target_utilization: 0.7, warm_up_time_seconds: 30 },
    triggers: [{ type: 'http', path: '/http-func', methods: ['POST'] }],
    mcp: { enabled: false, tool_name: 'http_func', description: 'test', input_schema: { type: 'object', properties: {} } },
    cost: { budget_daily: 10, cost_per_invocation_estimate: 0.0001, alert_thresholds: [0.5, 0.75, 0.9] },
    observability: { tracing_enabled: true, metrics_enabled: true, log_level: 'info' },
  };

  const sqsFunction: FunctionDefinition = {
    name: 'sqs-function',
    description: 'SQS function',
    version: '1.0.0',
    container: { image: 'test:latest', port: 8080, resources: { cpu: '100m', memory: '128Mi', gpu: 0 } },
    pool: { min_size: 1, max_size: 5, target_utilization: 0.7, warm_up_time_seconds: 30 },
    triggers: [{ type: 'sqs', queue: 'test-queue', batch_size: 10, visibility_timeout_seconds: 300 }],
    mcp: { enabled: false, tool_name: 'sqs_func', description: 'test', input_schema: { type: 'object', properties: {} } },
    cost: { budget_daily: 10, cost_per_invocation_estimate: 0.0001, alert_thresholds: [0.5, 0.75, 0.9] },
    observability: { tracing_enabled: true, metrics_enabled: true, log_level: 'info' },
  };

  const pubsubFunction: FunctionDefinition = {
    name: 'pubsub-function',
    description: 'Pub/Sub function',
    version: '1.0.0',
    container: { image: 'test:latest', port: 8080, resources: { cpu: '100m', memory: '128Mi', gpu: 0 } },
    pool: { min_size: 1, max_size: 5, target_utilization: 0.7, warm_up_time_seconds: 30 },
    triggers: [{ type: 'pubsub', topic: 'test-topic', subscription: 'test-sub' }],
    mcp: { enabled: false, tool_name: 'pubsub_func', description: 'test', input_schema: { type: 'object', properties: {} } },
    cost: { budget_daily: 10, cost_per_invocation_estimate: 0.0001, alert_thresholds: [0.5, 0.75, 0.9] },
    observability: { tracing_enabled: true, metrics_enabled: true, log_level: 'info' },
  };

  beforeEach(() => {
    startSpy = vi.spyOn(HTTPTrigger.prototype, 'start').mockResolvedValue();
    stopSpy = vi.spyOn(HTTPTrigger.prototype, 'stop').mockResolvedValue();
    registerSpy = vi.spyOn(HTTPTrigger.prototype, 'registerFunction');
    unregisterSpy = vi.spyOn(HTTPTrigger.prototype, 'unregisterFunction');
    sqsStartSpy = vi.spyOn(SQSTrigger.prototype, 'start').mockResolvedValue();
    vi.spyOn(SQSTrigger.prototype, 'stop').mockResolvedValue();
    pubSubStartSpy = vi.spyOn(PubSubTrigger.prototype, 'start').mockResolvedValue();
    pubSubStopSpy = vi.spyOn(PubSubTrigger.prototype, 'stop').mockResolvedValue();

    router = new TriggerRouter({
      httpPort: 0,
      httpHost: '127.0.0.1',
      sqsRegion: 'us-east-1',
      sqsAccountId: '123456789',
      pubsubProjectId: 'test-project',
    });
  });

  afterEach(async () => {
    await router.stop();
    vi.restoreAllMocks();
  });

  it('should create router instance', () => {
    expect(router).toBeInstanceOf(TriggerRouter);
  });

  it('should start and stop', async () => {
    await router.start();
    await router.stop();
    expect(startSpy).toHaveBeenCalled();
    expect(stopSpy).toHaveBeenCalled();
  });

  it('should register HTTP function', async () => {
    await router.start();
    await router.registerFunction(httpFunction, { http: createMockHTTPHandler() as unknown as HTTPTriggerHandler });
    expect(registerSpy).toHaveBeenCalledWith(httpFunction, expect.any(Object));
  });

  it('should register SQS function', async () => {
    await router.start();
    await router.registerFunction(sqsFunction, { sqs: createMockSQSHandler() as unknown as SQSTriggerHandler });
    expect(sqsStartSpy).toHaveBeenCalled();
  });

  it('should register Pub/Sub function', async () => {
    await router.start();
    await router.registerFunction(pubsubFunction, { pubsub: createMockPubSubHandler() as unknown as PubSubTriggerHandler });
    expect(pubSubStartSpy).toHaveBeenCalled();
  });

  it('should unregister function', async () => {
    await router.start();
    await router.registerFunction(httpFunction, { http: createMockHTTPHandler() as unknown as HTTPTriggerHandler });
    await router.unregisterFunction(httpFunction);
    expect(unregisterSpy).toHaveBeenCalledWith(httpFunction.name);
  });

  it('should return stats with registered triggers', async () => {
    await router.start();
    await router.registerFunction(sqsFunction, { sqs: createMockSQSHandler() as unknown as SQSTriggerHandler });
    await router.registerFunction(pubsubFunction, { pubsub: createMockPubSubHandler() as unknown as PubSubTriggerHandler });

    const stats = router.getStats();
    expect(stats.sqs.queues).toBe(1);
    expect(stats.pubsub.topics).toBe(1);
    expect(stats.sqs.total_functions).toBe(1);
    expect(stats.pubsub.total_functions).toBe(1);
  });

  it('should handle unregister when trigger not in map', async () => {
    await router.start();
    await router.unregisterFunction(sqsFunction);
  });

  it('should register SQS trigger when router not running', async () => {
    const stoppedRouter = new TriggerRouter({
      httpPort: 0,
      httpHost: '127.0.0.1',
      sqsRegion: 'us-east-1',
      sqsAccountId: '123456789',
      pubsubProjectId: 'test-project',
    });
    await stoppedRouter.registerFunction(sqsFunction, { sqs: createMockSQSHandler() as unknown as SQSTriggerHandler });
    await stoppedRouter.stop();
  });

  it('should register PubSub trigger when router not running', async () => {
    const stoppedRouter = new TriggerRouter({
      httpPort: 0,
      httpHost: '127.0.0.1',
      sqsRegion: 'us-east-1',
      sqsAccountId: '123456789',
      pubsubProjectId: 'test-project',
    });
    await stoppedRouter.registerFunction(pubsubFunction, { pubsub: createMockPubSubHandler() as unknown as PubSubTriggerHandler });
    await stoppedRouter.stop();
    expect(pubSubStopSpy).toHaveBeenCalled();
  });
});
