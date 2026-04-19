import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/mcp-server/tool-registry.js';
import type { FunctionDefinition } from '../../../src/types/index.js';

describe('ToolRegistry', () => {
  let toolRegistry: ToolRegistry;

  const mockFunction: FunctionDefinition = {
    name: 'hello-world',
    description: 'A simple greeting function',
    version: '1.0.0',
    container: {
      image: 'test:latest',
      port: 8080,
      resources: { cpu: '100m', memory: '128Mi', gpu: 0 },
    },
    pool: {
      min_size: 2,
      max_size: 5,
      target_utilization: 0.7,
      warm_up_time_seconds: 30,
    },
    triggers: [{ type: 'http', path: '/hello' }],
    mcp: {
      enabled: true,
      tool_name: 'hello_world',
      description: 'Generate a greeting message',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name to greet' },
        },
        required: ['name'],
      },
    },
    cost: { budget_daily: 10, cost_per_invocation_estimate: 0.0001, alert_thresholds: [0.5, 0.75, 0.9] },
    observability: { tracing_enabled: true, metrics_enabled: true, log_level: 'info' },
  };

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
  });

  describe('registerTool', () => {
    it('should register an MCP-enabled function', () => {
      toolRegistry.registerTool(mockFunction);

      const tools = toolRegistry.listTools();
      expect(tools).toHaveLength(1);
      const tool = tools[0];
      expect(tool).toBeDefined();
      expect(tool!.name).toBe('hello_world');
      expect(tool!.description).toBe('Generate a greeting message');
    });

    it('should not register MCP-disabled functions', () => {
      const disabledFunc = { ...mockFunction, mcp: { ...mockFunction.mcp, enabled: false } };
      toolRegistry.registerTool(disabledFunc);

      const tools = toolRegistry.listTools();
      expect(tools).toHaveLength(0);
    });

    it('should throw on duplicate tool names', () => {
      toolRegistry.registerTool(mockFunction);

      expect(() => toolRegistry.registerTool(mockFunction)).toThrow('Duplicate MCP tool name');
    });
  });

  describe('unregisterTool', () => {
    it('should remove a registered tool', () => {
      toolRegistry.registerTool(mockFunction);
      expect(toolRegistry.listTools()).toHaveLength(1);

      toolRegistry.unregisterTool('hello-world');
      expect(toolRegistry.listTools()).toHaveLength(0);
    });
  });

  describe('getTool', () => {
    it('should return a tool by name', () => {
      toolRegistry.registerTool(mockFunction);

      const tool = toolRegistry.getTool('hello_world');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('hello_world');
    });

    it('should return undefined for unknown tool', () => {
      const tool = toolRegistry.getTool('unknown_tool');
      expect(tool).toBeUndefined();
    });
  });

  describe('listTools', () => {
    it('should return all registered tools', () => {
      const func2 = { ...mockFunction, name: 'func-2', mcp: { ...mockFunction.mcp, tool_name: 'func_2' } };
      const func3 = { ...mockFunction, name: 'func-3', mcp: { ...mockFunction.mcp, tool_name: 'func_3' } };

      toolRegistry.registerTool(mockFunction);
      toolRegistry.registerTool(func2);
      toolRegistry.registerTool(func3);

      const tools = toolRegistry.listTools();
      expect(tools).toHaveLength(3);
    });
  });

  describe('getFunctionName', () => {
    it('should return function name by tool name', () => {
      toolRegistry.registerTool(mockFunction);

      const funcName = toolRegistry.getFunctionName('hello_world');
      expect(funcName).toBe('hello-world');
    });

    it('should return undefined for unknown tool name', () => {
      const funcName = toolRegistry.getFunctionName('unknown');
      expect(funcName).toBeUndefined();
    });
  });

  describe('validateToolExists', () => {
    it('should not throw for existing tool', () => {
      toolRegistry.registerTool(mockFunction);

      expect(() => toolRegistry.validateToolExists('hello_world')).not.toThrow();
    });

    it('should throw for non-existing tool', () => {
      expect(() => toolRegistry.validateToolExists('unknown')).toThrow('not found');
    });
  });

  describe('clear', () => {
    it('should clear all registered tools', () => {
      toolRegistry.registerTool(mockFunction);
      expect(toolRegistry.toolCount).toBe(1);

      toolRegistry.clear();

      expect(toolRegistry.toolCount).toBe(0);
    });
  });
});
