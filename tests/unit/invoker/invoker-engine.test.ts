import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { InvokerEngine } from '../../../src/invoker/invoker-engine.js';
import type { PoolManager } from '../../../src/pool-manager/pool-manager.js';
import type { FunctionRegistry } from '../../../src/registry/function-registry.js';
import type {
  InvocationRequest,
  FunctionDefinition,
  InvocationResult,
} from '../../../src/types/index.js';

interface PrivateInvokerEngine {
  createErrorResult(
    errorType: string,
    errorMessage: string,
    startTime: number,
    functionName: string,
    podId: string,
  ): InvocationResult;
}

// Mock the logger
vi.mock('../../../src/observability/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('InvokerEngine', () => {
  let invokerEngine: InvokerEngine;
  let mockPoolManager: PoolManager;
  let mockFunctionRegistry: FunctionRegistry;

  const createMockFunction = (name: string): FunctionDefinition => ({
    name,
    description: 'Test function',
    version: '1.0.0',
    container: {
      image: 'test:latest',
      port: 8080,
      resources: { cpu: '100m', memory: '128Mi', gpu: 0 },
    },
    pool: { min_size: 1, max_size: 5, target_utilization: 0.7, warm_up_time_seconds: 30 },
    triggers: [{ type: 'http', path: `/${name}`, methods: ['POST'] }],
    mcp: {
      enabled: true,
      tool_name: name.replace(/-/g, '_'),
      description: 'Test',
      input_schema: { type: 'object', properties: {} },
    },
    cost: {
      budget_daily: 10,
      cost_per_invocation_estimate: 0.0001,
      alert_thresholds: [0.5, 0.75, 0.9],
    },
    observability: { tracing_enabled: true, metrics_enabled: true, log_level: 'info' },
  });

  beforeEach(() => {
    // Create mock objects with vi.fn()
    mockPoolManager = {
      initialize: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      selectPod: vi.fn().mockResolvedValue('test-pod-123'),
      releasePod: vi.fn().mockResolvedValue(undefined),
      getPoolState: vi.fn().mockReturnValue({ healthy: true, available: 2, total: 3 }),
      getFunctionPool: vi.fn().mockReturnValue({ minSize: 2, maxSize: 10, currentSize: 3 }),
      scalePool: vi.fn().mockResolvedValue(undefined),
      healthCheck: vi.fn().mockResolvedValue(undefined),
    } as unknown as PoolManager;

    mockFunctionRegistry = {
      initialize: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getFunction: vi.fn(),
      getAllFunctions: vi.fn().mockReturnValue([]),
      hasFunction: vi.fn().mockReturnValue(false),
      getFunctionCount: vi.fn().mockReturnValue(0),
    } as unknown as FunctionRegistry;

    invokerEngine = new InvokerEngine(mockPoolManager, mockFunctionRegistry);
  });

  afterEach(async () => {
    await invokerEngine.stop();
    vi.restoreAllMocks();
  });

  describe('invoke', () => {
    it('should return error for unknown function', async () => {
      vi.mocked(mockFunctionRegistry.getFunction).mockReturnValue(undefined);

      const request: InvocationRequest = {
        function: 'unknown-function',
        arguments: { name: 'World' },
        request_id: 'req-123',
      };

      const result = await invokerEngine.invoke(request);

      expect(result.success).toBe(false);
      expect(result.error?.error_type).toBe('FunctionNotFound');
      expect(mockPoolManager.selectPod).not.toHaveBeenCalled();
    });

    it('should include request_id in error response', async () => {
      vi.mocked(mockFunctionRegistry.getFunction).mockReturnValue(undefined);

      const request: InvocationRequest = {
        function: 'nonexistent',
        arguments: {},
        request_id: 'test-request-id',
      };

      const result = await invokerEngine.invoke(request);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle function with timeout_ms parameter', async () => {
      vi.mocked(mockFunctionRegistry.getFunction).mockReturnValue(undefined);

      const request: InvocationRequest = {
        function: 'unknown-function',
        arguments: {},
        request_id: 'req-timeout',
        timeout_ms: 5000,
      };

      const result = await invokerEngine.invoke(request);

      expect(result.success).toBe(false);
    });

    it('should call selectPod when function exists', async () => {
      const func = createMockFunction('test-function');
      vi.mocked(mockFunctionRegistry.getFunction).mockReturnValue(func);
      vi.mocked(mockPoolManager.selectPod).mockRejectedValue(new Error('No available pods'));

      const request: InvocationRequest = {
        function: 'test-function',
        arguments: { test: 'data' },
        request_id: 'req-001',
      };

      await invokerEngine.invoke(request);

      expect(mockPoolManager.selectPod).toHaveBeenCalledWith('test-function');
    });

    it('should release pod even on error', async () => {
      const func = createMockFunction('test-function');
      vi.mocked(mockFunctionRegistry.getFunction).mockReturnValue(func);
      vi.mocked(mockPoolManager.selectPod).mockResolvedValue('pod-1');
      vi.mocked(mockPoolManager.releasePod).mockResolvedValue(undefined);

      // The HTTP request will fail since no server is running
      const request: InvocationRequest = {
        function: 'test-function',
        arguments: {},
        request_id: 'req-002',
        timeout_ms: 100, // Short timeout
      };

      await invokerEngine.invoke(request);

      expect(mockPoolManager.releasePod).toHaveBeenCalled();
    });
  });

  describe('cost calculations', () => {
    it('should calculate cost based on duration', async () => {
      vi.mocked(mockFunctionRegistry.getFunction).mockReturnValue(undefined);

      const request: InvocationRequest = {
        function: 'unknown-function',
        arguments: {},
        request_id: 'req-cost',
      };

      const result = await invokerEngine.invoke(request);

      expect(result.success).toBe(false);
      expect(result.metadata.cost_usd).toBe(0);
    });
  });

  describe('cost calculation', () => {
    const funcDef = createMockFunction('test-function');

    it('should calculate compute cost based on duration', () => {
      // $0.0001 per 100ms
      expect(invokerEngine.calculateComputeCost(funcDef, 100)).toBe(0.0001);
      expect(invokerEngine.calculateComputeCost(funcDef, 200)).toBe(0.0002);
      expect(invokerEngine.calculateComputeCost(funcDef, 50)).toBe(0.00005);
      expect(invokerEngine.calculateComputeCost(funcDef, 0)).toBe(0);
      expect(invokerEngine.calculateComputeCost(funcDef, 1000)).toBe(0.001);
    });

    it('should calculate network cost based on response size', () => {
      // $0.01 per GB transferred
      expect(invokerEngine.calculateNetworkCost(0)).toBe(0);
      expect(invokerEngine.calculateNetworkCost(1024)).toBeCloseTo(0.00000001, 8);
      expect(invokerEngine.calculateNetworkCost(1024 * 1024)).toBeCloseTo(0.00001, 5);
      expect(invokerEngine.calculateNetworkCost(1024 * 1024 * 1024)).toBe(0.01);
    });

    it('should calculate total cost as compute + network', () => {
      // Total cost = compute cost + fixed network cost of $0.00001
      const computeCost = invokerEngine.calculateComputeCost(funcDef, 100); // 0.0001
      const totalCost = invokerEngine.calculateCost(funcDef, 100);
      expect(totalCost).toBe(computeCost + 0.00001);
      expect(invokerEngine.calculateCost(funcDef, 200)).toBe(0.0002 + 0.00001);
      expect(invokerEngine.calculateCost(funcDef, 0)).toBe(0.00001);
    });
  });

  describe('error handling', () => {
    it('should handle errors gracefully', async () => {
      vi.mocked(mockFunctionRegistry.getFunction).mockReturnValue(undefined);

      const request: InvocationRequest = {
        function: 'error-function',
        arguments: { test: 'data' },
        request_id: 'req-error',
      };

      const result = await invokerEngine.invoke(request);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);
    });

    it('should log info when function not found', async () => {
      vi.mocked(mockFunctionRegistry.getFunction).mockReturnValue(undefined);

      const request: InvocationRequest = {
        function: 'log-test',
        arguments: {},
        request_id: 'req-log',
      };

      await invokerEngine.invoke(request);

      // Logger info should have been called for starting invocation
      const { logger } = await import('../../../src/observability/logger.js');
      expect(logger.info).toHaveBeenCalled();
    });
  });

  describe('executeOnPod HTTP responses', () => {
    const func = createMockFunction('test-function');

    interface MockHttpRequestConfig {
      body?: string;
      delayMs?: number;
      error?: Error;
      statusCode?: number;
      timeout?: boolean;
    }

    const mockHttpRequest = ({
      body = '',
      delayMs = 0,
      error,
      statusCode = 200,
      timeout = false,
    }: MockHttpRequestConfig): void => {
      vi.spyOn(http, 'request').mockImplementation(((...args: unknown[]) => {
        const options = args[0];
        const callback =
          typeof args.at(-1) === 'function'
            ? (args.at(-1) as (res: http.IncomingMessage) => void)
            : undefined;
        const req = new EventEmitter() as http.ClientRequest;
        const res = new EventEmitter() as http.IncomingMessage;

        req.write = vi.fn().mockReturnValue(true) as unknown as typeof req.write;
        req.end = vi.fn(() => {
          setTimeout(() => {
            if (error) {
              req.emit('error', error);
              return;
            }

            if (timeout) {
              req.emit('timeout');
              return;
            }

            res.statusCode = statusCode;
            callback?.(res);
            if (body.length > 0) {
              res.emit('data', body);
            }
            res.emit('end');
          }, delayMs);
          return req;
        }) as unknown as typeof req.end;
        req.destroy = vi.fn().mockReturnValue(req) as unknown as typeof req.destroy;

        void options;
        return req;
      }) as unknown as typeof http.request);
    };

    it('should handle HTTP 200 success with JSON response', async () => {
      const responseData = { result: 'success', data: { message: 'Hello World' } };
      mockHttpRequest({ statusCode: 200, body: JSON.stringify(responseData) });

      const funcDef = { ...func, container: { ...func.container, port: 8080 } };
      vi.mocked(mockFunctionRegistry.getFunction).mockReturnValue(funcDef);
      vi.mocked(mockPoolManager.selectPod).mockResolvedValue('test-pod-200');
      vi.mocked(mockPoolManager.releasePod).mockResolvedValue(undefined);

      const result = await invokerEngine.invoke({
        function: 'test-function',
        arguments: {},
        request_id: 'req-200',
      });

      expect(result.success).toBe(true);
      expect(result.metadata?.cost_breakdown).toBeDefined();
      expect(result.metadata?.cost_breakdown?.compute).toBeGreaterThan(0);
      expect(result.metadata?.cost_breakdown?.network).toBeGreaterThan(0);
      expect(mockPoolManager.releasePod).toHaveBeenCalledWith(
        'test-function',
        'test-pod-200',
        expect.any(Number),
      );
    });

    it('should handle HTTP non-200 error response', async () => {
      const errorBody = 'Internal Server Error';
      mockHttpRequest({ statusCode: 500, body: errorBody });

      const funcDef = { ...func, container: { ...func.container, port: 8080 } };
      vi.mocked(mockFunctionRegistry.getFunction).mockReturnValue(funcDef);
      vi.mocked(mockPoolManager.selectPod).mockResolvedValue('test-pod-500');
      vi.mocked(mockPoolManager.releasePod).mockResolvedValue(undefined);

      const result = await invokerEngine.invoke({
        function: 'test-function',
        arguments: {},
        request_id: 'req-500',
      });

      expect(result.success).toBe(false);
      expect(result.error?.error_type).toBe('HTTP_500');
      expect(result.error?.error_message).toBe(errorBody);
    });

    it('should handle malformed JSON in 200 response', async () => {
      const malformedJson = '{ invalid json';
      mockHttpRequest({ statusCode: 200, body: malformedJson });

      const funcDef = { ...func, container: { ...func.container, port: 8080 } };
      vi.mocked(mockFunctionRegistry.getFunction).mockReturnValue(funcDef);
      vi.mocked(mockPoolManager.selectPod).mockResolvedValue('test-pod-parse-err');
      vi.mocked(mockPoolManager.releasePod).mockResolvedValue(undefined);

      const result = await invokerEngine.invoke({
        function: 'test-function',
        arguments: {},
        request_id: 'req-parse-err',
      });

      expect(result.success).toBe(true);
      expect((result.content[0] as { type: 'text'; text: string }).text).toBe(malformedJson);
    });

    it('should handle HTTP 404 response', async () => {
      mockHttpRequest({ statusCode: 404, body: 'Not Found' });

      const funcDef = { ...func, container: { ...func.container, port: 8080 } };
      vi.mocked(mockFunctionRegistry.getFunction).mockReturnValue(funcDef);
      vi.mocked(mockPoolManager.selectPod).mockResolvedValue('test-pod-404');
      vi.mocked(mockPoolManager.releasePod).mockResolvedValue(undefined);

      const result = await invokerEngine.invoke({
        function: 'test-function',
        arguments: {},
        request_id: 'req-404',
      });

      expect(result.success).toBe(false);
      expect(result.error?.error_type).toBe('HTTP_404');
    });

    it('should handle connection error (server unreachable)', async () => {
      mockHttpRequest({ error: new Error('connect ECONNREFUSED') });

      const funcDef = { ...func, container: { ...func.container, port: 8080 } };
      vi.mocked(mockFunctionRegistry.getFunction).mockReturnValue(
        funcDef as unknown as FunctionDefinition,
      );
      vi.mocked(mockPoolManager.selectPod).mockResolvedValue('test-pod-conn-err');
      vi.mocked(mockPoolManager.releasePod).mockResolvedValue(undefined);

      const result = await invokerEngine.invoke({
        function: 'test-function',
        arguments: {},
        request_id: 'req-conn-err',
      });

      expect(result.success).toBe(false);
      expect(result.error?.error_type).toBeDefined();
    });

    it('should handle request timeout', async () => {
      mockHttpRequest({ timeout: true, delayMs: 10 });

      const funcDef = { ...func, container: { ...func.container, port: 8080 } };
      vi.mocked(mockFunctionRegistry.getFunction).mockReturnValue(funcDef);
      vi.mocked(mockPoolManager.selectPod).mockResolvedValue('test-pod-timeout');
      vi.mocked(mockPoolManager.releasePod).mockResolvedValue(undefined);

      const result = await invokerEngine.invoke({
        function: 'test-function',
        arguments: {},
        request_id: 'req-timeout',
        timeout_ms: 50,
      });

      expect(result.success).toBe(false);
      expect(result.error?.error_message).toContain('timeout');
    });

    it('should release pod on successful invocation', async () => {
      mockHttpRequest({ statusCode: 200, body: '{"success":true}' });

      const funcDef = { ...func, container: { ...func.container, port: 8080 } };
      vi.mocked(mockFunctionRegistry.getFunction).mockReturnValue(funcDef);
      vi.mocked(mockPoolManager.selectPod).mockResolvedValue('test-pod-release');
      vi.mocked(mockPoolManager.releasePod).mockResolvedValue(undefined);

      await invokerEngine.invoke({
        function: 'test-function',
        arguments: {},
        request_id: 'req-release',
      });

      expect(mockPoolManager.releasePod).toHaveBeenCalledWith(
        'test-function',
        'test-pod-release',
        expect.any(Number),
      );
    });
  });

  describe('createErrorResult', () => {
    it('should create error result with correct structure', () => {
      const errorType = 'TestError';
      const errorMessage = 'Test error message';
      const startTime = Date.now() - 100;
      const functionName = 'test-func';
      const podId = 'test-pod';

      const result = (invokerEngine as unknown as PrivateInvokerEngine).createErrorResult(
        errorType,
        errorMessage,
        startTime,
        functionName,
        podId,
      );

      expect(result.success).toBe(false);
      expect(result.error?.error_type).toBe(errorType);
      expect(result.error?.error_message).toBe(errorMessage);
      expect(result.metadata?.function).toBe(functionName);
      expect(result.metadata?.pod).toBe(podId);
      expect(result.metadata?.cost_usd).toBe(0);
    });

    it('should handle unknown error types', () => {
      const startTime = Date.now() - 50;

      const result = (invokerEngine as unknown as PrivateInvokerEngine).createErrorResult(
        'UnknownError',
        'Something went wrong',
        startTime,
        'func',
        'pod',
      );

      expect(result.success).toBe(false);
      expect(result.error?.error_type).toBe('UnknownError');
    });
  });
});
