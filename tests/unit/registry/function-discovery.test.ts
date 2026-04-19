import { describe, it, expect, beforeEach } from 'vitest';
import { FunctionDiscovery } from '../../../src/registry/function-discovery.js';
import type { FunctionDefinition } from '../../../src/types/index.js';

describe('FunctionDiscovery', () => {
  let discovery: FunctionDiscovery;

  const httpFunction: FunctionDefinition = {
    name: 'http-function',
    description: 'HTTP triggered function',
    version: '1.0.0',
    container: { image: 'test:latest', port: 8080, resources: { cpu: '100m', memory: '128Mi', gpu: 0 } },
    pool: { min_size: 1, max_size: 5, target_utilization: 0.7, warm_up_time_seconds: 30 },
    triggers: [{ type: 'http', path: '/http-func', methods: ['POST'] }],
    mcp: { enabled: true, tool_name: 'http_func', description: 'HTTP function for testing', input_schema: { type: 'object', properties: {} } },
    cost: { budget_daily: 10, cost_per_invocation_estimate: 0.0001, alert_thresholds: [0.5, 0.75, 0.9] },
    observability: { tracing_enabled: true, metrics_enabled: true, log_level: 'info' },
  };

  const sqsFunction: FunctionDefinition = {
    name: 'sqs-function',
    description: 'SQS triggered function',
    version: '1.0.0',
    container: { image: 'test:latest', port: 8080, resources: { cpu: '100m', memory: '128Mi', gpu: 0 } },
    pool: { min_size: 1, max_size: 5, target_utilization: 0.7, warm_up_time_seconds: 30 },
    triggers: [{ type: 'sqs', queue: 'test-queue', batch_size: 10, visibility_timeout_seconds: 300 }],
    mcp: { enabled: false, tool_name: 'sqs_func', description: 'SQS function', input_schema: { type: 'object', properties: {} } },
    cost: { budget_daily: 10, cost_per_invocation_estimate: 0.0001, alert_thresholds: [0.5, 0.75, 0.9] },
    observability: { tracing_enabled: true, metrics_enabled: true, log_level: 'info' },
  };

  beforeEach(() => {
    discovery = new FunctionDiscovery();
  });

  describe('register', () => {
    it('should register a function', () => {
      discovery.register(httpFunction);
      expect(discovery.getFunction('http-function')).toBe(httpFunction);
    });
  });

  describe('unregister', () => {
    it('should unregister a function', () => {
      discovery.register(httpFunction);
      discovery.unregister('http-function');
      expect(discovery.getFunction('http-function')).toBeUndefined();
    });
  });

  describe('getAllFunctions', () => {
    it('should return all registered functions', () => {
      discovery.register(httpFunction);
      discovery.register(sqsFunction);
      const functions = discovery.getAllFunctions();
      expect(functions).toHaveLength(2);
      expect(functions).toContain(httpFunction);
      expect(functions).toContain(sqsFunction);
    });
  });

  describe('getMCPToolSchemas', () => {
    it('should return schemas for MCP-enabled functions only', () => {
      discovery.register(httpFunction); // MCP enabled
      discovery.register(sqsFunction); // MCP disabled
      const schemas = discovery.getMCPToolSchemas();
      expect(schemas).toHaveLength(1);
      expect(schemas[0]).toEqual({
        name: 'http_func',
        description: 'HTTP function for testing',
        inputSchema: { type: 'object', properties: {} },
      });
    });
  });

  describe('generateOpenAPISpec', () => {
    it('should generate OpenAPI spec for HTTP functions', () => {
      discovery.register(httpFunction);
      const spec = discovery.generateOpenAPISpec() as { paths: Record<string, unknown>; openapi: string };
      expect(spec.openapi).toBe('3.0.0');
      expect(spec.paths).toHaveProperty('/http-func');
      expect(spec.paths['/http-func']).toHaveProperty('post');
    });

    it('should return empty paths when no HTTP functions', () => {
      discovery.register(sqsFunction);
      const spec = discovery.generateOpenAPISpec() as { paths: Record<string, unknown> };
      expect(spec.paths).toEqual({});
    });
  });

  describe('getFunctionIndex', () => {
    it('should return function index', () => {
      discovery.register(httpFunction);
      const index = discovery.getFunctionIndex();
      expect(index).toHaveLength(1);
      expect(index[0]).toEqual({
        name: 'http-function',
        description: 'HTTP triggered function',
        version: '1.0.0',
        mcp_enabled: true,
        mcp_tool_name: 'http_func',
        triggers: [{ type: 'http', path: '/http-func' }],
      });
    });
  });

  describe('searchFunctions', () => {
    it('should search functions by keyword in name', () => {
      discovery.register(httpFunction);
      discovery.register(sqsFunction);
      const results = discovery.searchFunctions('http');
      expect(results).toHaveLength(1);
      expect(results[0]).toBe(httpFunction);
    });

    it('should search functions by keyword in description', () => {
      discovery.register(httpFunction);
      discovery.register(sqsFunction);
      const results = discovery.searchFunctions('SQS');
      expect(results).toHaveLength(1);
      expect(results[0]).toBe(sqsFunction);
    });

    it('should search functions by keyword in MCP description', () => {
      discovery.register(httpFunction);
      const results = discovery.searchFunctions('testing');
      expect(results).toHaveLength(1);
      expect(results[0]).toBe(httpFunction);
    });
  });

  describe('getFunctionsByTriggerType', () => {
    it('should return functions by trigger type', () => {
      discovery.register(httpFunction);
      discovery.register(sqsFunction);
      const httpFuncs = discovery.getFunctionsByTriggerType('http');
      expect(httpFuncs).toHaveLength(1);
      expect(httpFuncs[0]).toBe(httpFunction);

      const sqsFuncs = discovery.getFunctionsByTriggerType('sqs');
      expect(sqsFuncs).toHaveLength(1);
      expect(sqsFuncs[0]).toBe(sqsFunction);
    });
  });

  describe('clear', () => {
    it('should clear all functions', () => {
      discovery.register(httpFunction);
      discovery.register(sqsFunction);
      discovery.clear();
      expect(discovery.getAllFunctions()).toHaveLength(0);
    });
  });
});
