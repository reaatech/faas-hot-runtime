import { describe, it, expect, beforeEach } from 'vitest';
import { SchemaValidator } from '../../../src/registry/schema-validator.js';

describe('SchemaValidator', () => {
  let validator: SchemaValidator;

  const validFunctionData = {
    name: 'test-function',
    description: 'Test function',
    version: '1.0.0',
    container: {
      image: 'test:latest',
      port: 8080,
      resources: { cpu: '100m', memory: '128Mi', gpu: 0 },
    },
    pool: { min_size: 1, max_size: 5, target_utilization: 0.7, warm_up_time_seconds: 30 },
    triggers: [{ type: 'http' as const, path: '/test', methods: ['POST'] }],
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
    validator = new SchemaValidator();
  });

  describe('validateFunctionDefinition', () => {
    it('should validate a valid function definition', () => {
      const result = validator.validateFunctionDefinition(validFunctionData);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject invalid function definition', () => {
      const invalidData = { name: 123 }; // Invalid type
      const result = validator.validateFunctionDefinition(invalidData);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject duplicate function names', () => {
      validator.registerFunction('test-function');
      const result = validator.validateFunctionDefinition(validFunctionData);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Duplicate function name: test-function');
    });

    it('should reject duplicate MCP tool names', () => {
      const mcpFunction = {
        ...validFunctionData,
        mcp: { ...validFunctionData.mcp, enabled: true as const, tool_name: 'existing_tool' },
      };
      validator.registerFunction('other-function', 'existing_tool');
      const result = validator.validateFunctionDefinition(mcpFunction);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Duplicate MCP tool name: existing_tool');
    });

    it('should reject invalid pool configuration', () => {
      const invalidPool = {
        ...validFunctionData,
        pool: { ...validFunctionData.pool, min_size: 10, max_size: 5 },
      };
      const result = validator.validateFunctionDefinition(invalidPool);
      expect(result.valid).toBe(false);
      // The error could come from Zod schema or custom validation
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should warn when min_size is 0', () => {
      const zeroMinPool = {
        ...validFunctionData,
        pool: { ...validFunctionData.pool, min_size: 0 },
      };
      const result = validator.validateFunctionDefinition(zeroMinPool);
      expect(result.warnings).toContain('pool.min_size is 0 - cold starts may occur');
    });

    it('should warn when tracing is disabled', () => {
      const noTracing = {
        ...validFunctionData,
        observability: { ...validFunctionData.observability, tracing_enabled: false },
      };
      const result = validator.validateFunctionDefinition(noTracing);
      expect(result.warnings).toContain('Tracing is disabled - observability will be limited');
    });
  });

  describe('registerFunction', () => {
    it('should register a function name', () => {
      validator.registerFunction('my-function');
      // No error means success
    });

    it('should register a function with tool name', () => {
      validator.registerFunction('my-function', 'my_tool');
      // No error means success
    });
  });

  describe('unregisterFunction', () => {
    it('should unregister a function name', () => {
      validator.registerFunction('my-function');
      validator.unregisterFunction('my-function');
      // After unregistering, should be able to register again
      validator.registerFunction('my-function');
    });

    it('should unregister a tool name', () => {
      validator.registerFunction('my-function', 'my_tool');
      validator.unregisterFunction('my-function', 'my_tool');
    });
  });

  describe('clear', () => {
    it('should clear all registered functions', () => {
      validator.registerFunction('func-1');
      validator.registerFunction('func-2', 'tool-2');
      validator.clear();
      // After clear, should be able to register same names
      validator.registerFunction('func-1');
      validator.registerFunction('func-2', 'tool-2');
    });
  });
});
