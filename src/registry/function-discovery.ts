import { logger } from '../observability/logger.js';
import type { FunctionDefinition, HTTPTriggerConfig } from '../types/index.js';

/** MCP tool schema for function discovery */
export interface MCPToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Function Discovery - exposes functions to MCP server and generates specs
 */
export class FunctionDiscovery {
  private functions: Map<string, FunctionDefinition> = new Map();

  /**
   * Register a function for discovery
   */
  register(functionDef: FunctionDefinition): void {
    this.functions.set(functionDef.name, functionDef);
    logger.debug({ function: functionDef.name }, 'Function registered for discovery');
  }

  /**
   * Unregister a function
   */
  unregister(functionName: string): void {
    this.functions.delete(functionName);
    logger.debug({ function: functionName }, 'Function unregistered from discovery');
  }

  /**
   * Get all functions
   */
  getAllFunctions(): FunctionDefinition[] {
    return Array.from(this.functions.values());
  }

  /**
   * Get a function by name
   */
  getFunction(name: string): FunctionDefinition | undefined {
    return this.functions.get(name);
  }

  /**
   * Generate MCP tool schemas for all MCP-enabled functions
   */
  getMCPToolSchemas(): MCPToolSchema[] {
    const schemas: MCPToolSchema[] = [];
    for (const func of this.functions.values()) {
      if (func.mcp.enabled) {
        schemas.push({
          name: func.mcp.tool_name,
          description: func.mcp.description,
          inputSchema: func.mcp.input_schema as unknown as Record<string, unknown>,
        });
      }
    }
    return schemas;
  }

  /**
   * Generate OpenAPI spec for HTTP-triggered functions
   */
  generateOpenAPISpec(serverUrl?: string): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {};

    for (const func of this.functions.values()) {
      const httpTriggers = func.triggers.filter((t): t is HTTPTriggerConfig => t.type === 'http');
      for (const trigger of httpTriggers) {
        const methods = trigger.methods ?? ['POST'];
        for (const method of methods) {
          const pathKey = trigger.path;
          if (!paths[pathKey]) {
            paths[pathKey] = {};
          }
          const methodLower = method.toLowerCase();
          paths[pathKey][methodLower] = {
            operationId: `${methodLower}_${func.name}`,
            summary: func.description,
            description: func.mcp.description,
            requestBody: {
              content: {
                'application/json': {
                  schema: func.mcp.input_schema,
                },
              },
            },
            responses: {
              '200': {
                description: 'Successful response',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        success: { type: 'boolean' },
                        content: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              type: { type: 'string' },
                              text: { type: 'string' },
                            },
                          },
                        },
                        metadata: {
                          type: 'object',
                          properties: {
                            function: { type: 'string' },
                            pod: { type: 'string' },
                            duration_ms: { type: 'number' },
                            cost_usd: { type: 'number' },
                            cold_start: { type: 'boolean' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          };
        }
      }
    }

    return {
      openapi: '3.0.0',
      info: {
        title: 'faas-hot-runtime API',
        version: '1.0.0',
        description: 'FaaS runtime with warm pod pools for sub-100ms invocations',
      },
      servers: [{ url: serverUrl ?? process.env.MCP_SERVER_URL ?? 'http://localhost:8080' }],
      paths,
    };
  }

  /**
   * Get function metadata for indexing
   */
  getFunctionIndex(): Array<{
    name: string;
    description: string;
    version: string;
    mcp_enabled: boolean;
    mcp_tool_name?: string;
    triggers: Array<{ type: string; path?: string }>;
  }> {
    return this.getAllFunctions().map((func) => ({
      name: func.name,
      description: func.description,
      version: func.version,
      mcp_enabled: func.mcp.enabled,
      mcp_tool_name: func.mcp.enabled ? func.mcp.tool_name : undefined,
      triggers: func.triggers.map((t) => ({
        type: t.type,
        path: t.type === 'http' ? t.path : undefined,
      })),
    }));
  }

  /**
   * Search functions by keyword
   */
  searchFunctions(keyword: string): FunctionDefinition[] {
    const lowerKeyword = keyword.toLowerCase();
    return this.getAllFunctions().filter(
      (func) =>
        func.name.toLowerCase().includes(lowerKeyword) ||
        func.description.toLowerCase().includes(lowerKeyword) ||
        (func.mcp.enabled && func.mcp.description.toLowerCase().includes(lowerKeyword)),
    );
  }

  /**
   * Get functions by trigger type
   */
  getFunctionsByTriggerType(triggerType: string): FunctionDefinition[] {
    return this.getAllFunctions().filter((func) =>
      func.triggers.some((t) => t.type === triggerType),
    );
  }

  /**
   * Clear all registered functions
   */
  clear(): void {
    this.functions.clear();
  }
}
