import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HTTPTrigger } from '../../../src/triggers/http-trigger.js';
import type { HTTPTriggerHandler } from '../../../src/triggers/http-trigger.js';
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

const createMockResponse = () => {
  const response = {
    headersSent: false,
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '',
    setHeader: vi.fn((name: string, value: string) => {
      response.headers[name] = value;
    }),
    writeHead: vi.fn((statusCode: number, headers?: Record<string, string>) => {
      response.statusCode = statusCode;
      response.headersSent = true;
      if (headers) {
        Object.assign(response.headers, headers);
      }
      return response;
    }),
    end: vi.fn((body?: string) => {
      if (body) {
        response.body = body;
      }
    }),
  };

  return response;
};

const createMockRequest = (
  url: string,
  method: string,
  headers: Record<string, string> = {},
  body?: string,
) => {
  const listeners: Record<string, Array<(chunk?: Buffer) => void>> = {};

  return {
    url,
    method,
    headers: {
      host: 'example.test',
      ...headers,
    },
    on: vi.fn((event: string, callback: (chunk?: Buffer) => void) => {
      listeners[event] ??= [];
      listeners[event].push(callback);
      return undefined;
    }),
    removeAllListeners: vi.fn((event: string) => {
      listeners[event] = [];
    }),
    destroy: vi.fn(),
    emitBody: () => {
      if (body) {
        listeners.data?.forEach((callback) => callback(Buffer.from(body)));
      }
      listeners.end?.forEach((callback) => callback());
    },
    emitError: () => {
      listeners.error?.forEach((callback) => callback());
    },
  };
};

describe('HTTPTrigger', () => {
  let trigger: HTTPTrigger;
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
    triggers: [{ type: 'http', path: '/test', methods: ['POST'] }],
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
    trigger = new HTTPTrigger({ host: '127.0.0.1', port: 0 });
    mockHandler = createMockHandler();
  });

  it('should create trigger instance', () => {
    expect(trigger).toBeInstanceOf(HTTPTrigger);
  });

  it('should register a function', () => {
    trigger.registerFunction(mockFunction, mockHandler as unknown as HTTPTriggerHandler);
  });

  it('should unregister a function', () => {
    trigger.registerFunction(mockFunction, mockHandler as unknown as HTTPTriggerHandler);
    trigger.unregisterFunction('test-function');
  });

  it('should handle health check endpoint', async () => {
    const req = createMockRequest('/health', 'GET');
    const res = createMockResponse();

    await (
      trigger as unknown as { handleRequest: (req: object, res: object) => Promise<void> }
    ).handleRequest(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'healthy' });
  });

  it('should return 404 for unknown path', async () => {
    const req = createMockRequest('/unknown', 'GET');
    const res = createMockResponse();

    await (
      trigger as unknown as { handleRequest: (req: object, res: object) => Promise<void> }
    ).handleRequest(req, res);

    expect(res.statusCode).toBe(404);
  });

  it('should invoke handler on POST to registered path', async () => {
    trigger.registerFunction(mockFunction, mockHandler as unknown as HTTPTriggerHandler);
    const req = createMockRequest(
      '/test',
      'POST',
      { 'content-type': 'application/json' },
      JSON.stringify({ key: 'value' }),
    );
    const res = createMockResponse();

    const promise = (
      trigger as unknown as {
        handleRequest: (req: ReturnType<typeof createMockRequest>, res: object) => Promise<void>;
      }
    ).handleRequest(req, res);
    req.emitBody();
    await promise;

    expect(res.statusCode).toBe(200);
    expect(mockHandler.handleRequest).toHaveBeenCalled();
  });

  it('should stop gracefully', async () => {
    await expect(trigger.stop()).resolves.not.toThrow();
  });

  it('should return 500 when handler rejects', async () => {
    trigger.registerFunction(mockFunction, mockHandler as unknown as HTTPTriggerHandler);
    mockHandler.handleRequest.mockRejectedValue(new Error('Handler error'));

    const req = createMockRequest(
      '/test',
      'POST',
      { 'content-type': 'application/json' },
      JSON.stringify({ key: 'value' }),
    );
    const res = createMockResponse();

    const promise = (
      trigger as unknown as {
        handleRequest: (req: ReturnType<typeof createMockRequest>, res: object) => Promise<void>;
      }
    ).handleRequest(req, res);
    req.emitBody();
    await promise;

    expect(res.statusCode).toBe(500);
  });

  it('should handle invalid JSON body', async () => {
    trigger.registerFunction(mockFunction, mockHandler as unknown as HTTPTriggerHandler);

    const req = createMockRequest(
      '/test',
      'POST',
      { 'content-type': 'application/json' },
      'invalid json{',
    );
    const res = createMockResponse();

    const promise = (
      trigger as unknown as {
        handleRequest: (req: ReturnType<typeof createMockRequest>, res: object) => Promise<void>;
      }
    ).handleRequest(req, res);
    req.emitBody();
    await promise;

    expect(res.statusCode).toBe(400);
  });

  it('should require a valid API key when auth is enabled', async () => {
    const protectedTrigger = new HTTPTrigger({ host: '127.0.0.1', port: 0, apiKey: 'secret-key' });
    protectedTrigger.registerFunction(
      {
        ...mockFunction,
        triggers: [{ type: 'http', path: '/test', methods: ['POST'], auth_required: true }],
      },
      mockHandler as unknown as HTTPTriggerHandler,
    );

    const req = createMockRequest('/test', 'POST', {}, JSON.stringify({ key: 'value' }));
    const res = createMockResponse();

    const promise = (
      protectedTrigger as unknown as {
        handleRequest: (req: ReturnType<typeof createMockRequest>, res: object) => Promise<void>;
      }
    ).handleRequest(req, res);
    req.emitBody();
    await promise;

    expect(res.statusCode).toBe(401);
  });
});
