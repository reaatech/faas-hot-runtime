import { describe, it, expect } from 'vitest';
import {
  FunctionDefinitionSchema,
  InvocationRequestSchema,
  WarmPoolConfigSchema,
  TriggerConfigSchema,
} from '../../../src/types/schemas.js';

describe('Schemas', () => {
  describe('FunctionDefinitionSchema', () => {
    it('should validate a valid function definition', () => {
      const validDef = {
        name: 'hello-world',
        description: 'A simple greeting function',
        version: '1.0.0',
        container: {
          image: 'myregistry/hello-world:latest',
          port: 8080,
          resources: {
            cpu: '100m',
            memory: '128Mi',
            gpu: 0,
          },
        },
        pool: {
          min_size: 2,
          max_size: 10,
          target_utilization: 0.7,
          warm_up_time_seconds: 30,
        },
        triggers: [
          {
            type: 'http',
            path: '/hello',
            methods: ['GET', 'POST'],
          },
        ],
        mcp: {
          enabled: true,
          tool_name: 'hello_world',
          description: 'Generate a greeting',
          input_schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
            },
            required: ['name'],
          },
        },
        cost: {
          budget_daily: 10.0,
          cost_per_invocation_estimate: 0.0001,
        },
        observability: {
          tracing_enabled: true,
          metrics_enabled: true,
          log_level: 'info',
        },
      };

      const result = FunctionDefinitionSchema.safeParse(validDef);
      expect(result.success).toBe(true);
    });

    it('should reject invalid function name', () => {
      const invalidDef = {
        name: 'INVALID_NAME',
        description: 'Test',
        version: '1.0.0',
        container: {
          image: 'test:latest',
          port: 8080,
          resources: { cpu: '100m', memory: '128Mi', gpu: 0 },
        },
        pool: { min_size: 1, max_size: 5, target_utilization: 0.7, warm_up_time_seconds: 30 },
        triggers: [{ type: 'http', path: '/test' }],
        mcp: { enabled: false, tool_name: 'test', description: 'test', input_schema: {} },
        cost: { budget_daily: 10, cost_per_invocation_estimate: 0.0001 },
        observability: { tracing_enabled: true, metrics_enabled: true, log_level: 'info' },
      };

      const result = FunctionDefinitionSchema.safeParse(invalidDef);
      expect(result.success).toBe(false);
    });

    it('should reject when min_size > max_size', () => {
      const invalidDef = {
        name: 'test-func',
        description: 'Test',
        version: '1.0.0',
        container: {
          image: 'test:latest',
          port: 8080,
          resources: { cpu: '100m', memory: '128Mi', gpu: 0 },
        },
        pool: { min_size: 10, max_size: 5, target_utilization: 0.7, warm_up_time_seconds: 30 },
        triggers: [{ type: 'http', path: '/test' }],
        mcp: { enabled: false, tool_name: 'test', description: 'test', input_schema: {} },
        cost: { budget_daily: 10, cost_per_invocation_estimate: 0.0001 },
        observability: { tracing_enabled: true, metrics_enabled: true, log_level: 'info' },
      };

      const result = FunctionDefinitionSchema.safeParse(invalidDef);
      expect(result.success).toBe(false);
    });
  });

  describe('InvocationRequestSchema', () => {
    it('should validate a valid invocation request', () => {
      const validRequest = {
        function: 'hello-world',
        arguments: { name: 'World' },
        request_id: 'req-123',
        timeout_ms: 30000,
      };

      const result = InvocationRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    it('should reject missing function name', () => {
      const invalidRequest = {
        arguments: { name: 'World' },
        request_id: 'req-123',
      };

      const result = InvocationRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });
  });

  describe('WarmPoolConfigSchema', () => {
    it('should validate a valid pool config', () => {
      const validConfig = {
        min_size: 2,
        max_size: 10,
        target_utilization: 0.7,
        warm_up_time_seconds: 30,
      };

      const result = WarmPoolConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('should use default target_utilization', () => {
      const config = {
        min_size: 1,
        max_size: 5,
        warm_up_time_seconds: 30,
      };

      const result = WarmPoolConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.target_utilization).toBe(0.7);
      }
    });
  });

  describe('TriggerConfigSchema', () => {
    it('should validate HTTP trigger', () => {
      const httpTrigger = {
        type: 'http' as const,
        path: '/hello',
        methods: ['GET', 'POST'],
      };

      const result = TriggerConfigSchema.safeParse(httpTrigger);
      expect(result.success).toBe(true);
    });

    it('should validate SQS trigger', () => {
      const sqsTrigger = {
        type: 'sqs' as const,
        queue: 'my-queue',
        batch_size: 10,
        visibility_timeout_seconds: 300,
      };

      const result = TriggerConfigSchema.safeParse(sqsTrigger);
      expect(result.success).toBe(true);
    });

    it('should validate Pub/Sub trigger', () => {
      const pubsubTrigger = {
        type: 'pubsub' as const,
        topic: 'my-topic',
        subscription: 'my-sub',
      };

      const result = TriggerConfigSchema.safeParse(pubsubTrigger);
      expect(result.success).toBe(true);
    });
  });
});
