import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../observability/logger.js';
import type { FunctionDefinition, MCPInputSchema, MCPPropertySchema } from '../types/index.js';

/**
 * Registry for managing MCP tool definitions
 * Converts FunctionDefinition to MCP tool schemas
 */
export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private functionNames: Map<string, string> = new Map(); // tool_name -> function_name

  /**
   * Register a function as an MCP tool
   */
  registerTool(definition: FunctionDefinition): void {
    if (!definition.mcp.enabled) {
      logger.debug({ function: definition.name }, 'Skipping disabled MCP tool');
      return;
    }

    const toolName = definition.mcp.tool_name;

    // Check for duplicate tool names
    if (this.functionNames.has(toolName)) {
      const existingFunction = this.functionNames.get(toolName);
      throw new Error(
        `Duplicate MCP tool name "${toolName}" for functions "${existingFunction}" and "${definition.name}"`,
      );
    }

    const tool: Tool = {
      name: toolName,
      description: definition.mcp.description,
      inputSchema: this.convertToMCPSchema(definition.mcp.input_schema) as Tool['inputSchema'],
    };

    this.tools.set(toolName, tool);
    this.functionNames.set(toolName, definition.name);

    logger.info({ function: definition.name, tool_name: toolName }, 'Tool registered in registry');
  }

  /**
   * Unregister a function by name
   */
  unregisterTool(functionName: string): void {
    // Find the tool name for this function
    for (const [toolName, fnName] of this.functionNames.entries()) {
      if (fnName === functionName) {
        this.tools.delete(toolName);
        this.functionNames.delete(toolName);
        logger.info({ function: functionName, tool_name: toolName }, 'Tool unregistered');
        return;
      }
    }
    logger.warn({ function: functionName }, 'Function not found in registry');
  }

  /**
   * List all registered tools
   */
  listTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get a tool by name
   */
  getTool(toolName: string): Tool | undefined {
    return this.tools.get(toolName);
  }

  /**
   * Get function name by tool name
   */
  getFunctionName(toolName: string): string | undefined {
    return this.functionNames.get(toolName);
  }

  getToolNameByFunction(functionName: string): string | undefined {
    for (const [toolName, fnName] of this.functionNames.entries()) {
      if (fnName === functionName) {
        return toolName;
      }
    }
    return undefined;
  }

  /**
   * Get pool utilization across all registered functions
   */
  private poolUtilizationFn: (() => number) | null = null;

  setPoolUtilizationFn(fn: () => number): void {
    this.poolUtilizationFn = fn;
  }

  getPoolUtilization(): number {
    if (this.poolUtilizationFn) {
      return this.poolUtilizationFn();
    }
    return 0;
  }

  /**
   * Convert our MCP input schema to MCP SDK schema format
   */
  private convertToMCPSchema(schema: MCPInputSchema): {
    type: string;
    properties: Record<string, object>;
    required: string[];
  } {
    return {
      type: schema.type ?? 'object',
      properties: this.convertProperties(schema.properties),
      required: schema.required ?? [],
    };
  }

  /**
   * Convert property schemas recursively
   */
  private convertProperties(properties: Record<string, MCPPropertySchema>): Record<string, object> {
    const result: Record<string, object> = {};

    for (const [key, prop] of Object.entries(properties)) {
      result[key] = this.convertProperty(prop);
    }

    return result;
  }

  /**
   * Convert a single property schema
   */
  private convertProperty(prop: MCPPropertySchema): object {
    const base: Record<string, unknown> = {
      type: prop.type,
    };

    if (prop.description) {
      base.description = prop.description;
    }

    if (prop.default !== undefined) {
      base.default = prop.default;
    }

    if (prop.enum) {
      base.enum = prop.enum;
    }

    if (prop.format) {
      base.format = prop.format;
    }

    if (prop.properties) {
      base.properties = this.convertProperties(prop.properties);
    }

    if (prop.required) {
      base.required = prop.required;
    }

    if (prop.items) {
      base.items = this.convertProperty(prop.items);
    }

    return base;
  }

  /**
   * Validate that a tool exists
   */
  validateToolExists(toolName: string): void {
    if (!this.tools.has(toolName)) {
      const availableTools = Array.from(this.tools.keys()).join(', ');
      throw new Error(`Tool "${toolName}" not found. Available tools: ${availableTools || 'none'}`);
    }
  }

  /**
   * Get the count of registered tools
   */
  get toolCount(): number {
    return this.tools.size;
  }

  /**
   * Clear all registered tools
   */
  clear(): void {
    this.tools.clear();
    this.functionNames.clear();
    logger.info('Tool registry cleared');
  }
}
