import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../observability/logger.js';
import type {
  FunctionDefinition,
  InvocationRequest,
  InvocationResult,
  InvocationContent,
  MCPInputSchema,
  MCPPropertySchema,
} from '../types/index.js';
import type { ToolRegistry } from './tool-registry.js';

export interface InvocationEngine {
  invoke(request: InvocationRequest): Promise<InvocationResult>;
}

export interface FunctionRegistry {
  getFunction(name: string): FunctionDefinition | undefined;
}

/**
 * Handles MCP tool call requests
 * Validates inputs and routes to the invocation engine
 */
export class RequestHandler {
  private toolRegistry: ToolRegistry;
  private invocationEngine: InvocationEngine;
  private functionRegistry: FunctionRegistry;

  constructor(
    toolRegistry: ToolRegistry,
    invocationEngine: InvocationEngine,
    functionRegistry: FunctionRegistry,
  ) {
    this.toolRegistry = toolRegistry;
    this.invocationEngine = invocationEngine;
    this.functionRegistry = functionRegistry;
  }

  /**
   * Handle a tool call request
   */
  private static readonly SENSITIVE_FIELDS = [
    'password',
    'passwd',
    'secret',
    'token',
    'apiKey',
    'api_key',
    'authorization',
    'credential',
    'private',
    'access_token',
  ];

  private static redactSensitiveArgs(args: Record<string, unknown>): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (this.SENSITIVE_FIELDS.some((field) => key.toLowerCase().includes(field))) {
        redacted[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        redacted[key] = this.redactSensitiveArgs(value as Record<string, unknown>);
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  async handleToolCall(name: string, args: Record<string, unknown>): Promise<InvocationResult> {
    const requestId = crypto.randomUUID();
    const startTime = Date.now();
    const redactedArgs = RequestHandler.redactSensitiveArgs(args);

    logger.info(
      { tool_name: name, request_id: requestId, args: JSON.stringify(redactedArgs) },
      'Processing tool call',
    );

    try {
      // Validate tool exists
      this.toolRegistry.validateToolExists(name);

      // Get function name from tool name
      const functionName = this.toolRegistry.getFunctionName(name);
      if (!functionName) {
        throw new McpError(ErrorCode.MethodNotFound, `Tool "${name}" is not mapped to a function`);
      }

      // Get function definition
      const functionDef = this.functionRegistry.getFunction(functionName);
      if (!functionDef) {
        throw new McpError(ErrorCode.InvalidParams, `Function "${functionName}" not found`);
      }

      // Validate arguments against schema
      this.validateArguments(args, functionDef.mcp.input_schema, name);

      // Create invocation request
      const invocationRequest: InvocationRequest = {
        function: functionName,
        arguments: args,
        request_id: requestId,
      };

      // Invoke the function
      const result = await this.invocationEngine.invoke(invocationRequest);

      const duration = Date.now() - startTime;
      logger.info(
        {
          tool_name: name,
          request_id: requestId,
          duration_ms: duration,
          success: result.success,
        },
        'Tool call completed',
      );

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      if (error instanceof McpError) {
        throw error;
      }

      logger.error(
        {
          tool_name: name,
          request_id: requestId,
          duration_ms: duration,
          error: error instanceof Error ? error.message : error,
        },
        'Tool call failed',
      );

      throw new McpError(
        ErrorCode.InternalError,
        `Function execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        {
          error_type: error instanceof Error ? error.name : 'UnknownError',
          error_message: error instanceof Error ? error.message : 'Unknown error',
          duration_ms: duration,
        },
      );
    }
  }

  /**
   * Validate arguments against the function's input schema
   */
  private validateArguments(
    args: Record<string, unknown>,
    schema: MCPInputSchema,
    toolName: string,
  ): void {
    this.validateObject(args, schema.properties, schema.required ?? [], toolName);
  }

  private validateObject(
    value: Record<string, unknown>,
    properties: Record<string, MCPPropertySchema>,
    required: string[],
    toolName: string,
    path: string = '',
  ): void {
    for (const field of required) {
      if (value[field] === undefined) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Missing required parameter "${this.buildPath(path, field)}" for tool "${toolName}"`,
        );
      }
    }

    for (const [key, fieldValue] of Object.entries(value)) {
      const schema = properties[key];
      if (!schema) {
        continue;
      }

      this.validateProperty(fieldValue, schema, this.buildPath(path, key), toolName);
    }
  }

  private validateProperty(
    value: unknown,
    schema: MCPPropertySchema,
    paramName: string,
    toolName: string,
  ): void {
    const expectedType = schema.type;
    if (value === null) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Parameter "${paramName}" must be a ${expectedType}, got null`,
      );
    }

    const actualType = typeof value;

    switch (expectedType) {
      case 'string':
        if (actualType !== 'string') {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Parameter "${paramName}" must be a string, got ${actualType}`,
          );
        }
        if (schema.format) {
          const formatError = this.validateFormat(value as string, schema.format, paramName);
          if (formatError) {
            throw formatError;
          }
        }
        if (schema.enum && !schema.enum.includes(value as string)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Parameter "${paramName}" must be one of: ${schema.enum.join(', ')}`,
          );
        }
        break;
      case 'number':
        if (actualType !== 'number') {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Parameter "${paramName}" must be a number, got ${actualType}`,
          );
        }
        break;
      case 'boolean':
        if (actualType !== 'boolean') {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Parameter "${paramName}" must be a boolean, got ${actualType}`,
          );
        }
        break;
      case 'object':
        if (actualType !== 'object' || value === null || Array.isArray(value)) {
          throw new McpError(ErrorCode.InvalidParams, `Parameter "${paramName}" must be an object`);
        }
        this.validateObject(
          value as Record<string, unknown>,
          schema.properties ?? {},
          schema.required ?? [],
          toolName,
          paramName,
        );
        break;
      case 'array':
        if (!Array.isArray(value)) {
          throw new McpError(ErrorCode.InvalidParams, `Parameter "${paramName}" must be an array`);
        }
        if (schema.items) {
          value.forEach((item, index) => {
            this.validateProperty(item, schema.items!, `${paramName}[${index}]`, toolName);
          });
        }
        break;
    }
  }

  private buildPath(parentPath: string, key: string): string {
    return parentPath ? `${parentPath}.${key}` : key;
  }

  private validateFormat(value: string, format: string, paramName: string): McpError | undefined {
    switch (format) {
      case 'date': {
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(value) || isNaN(Date.parse(value))) {
          return new McpError(
            ErrorCode.InvalidParams,
            `Parameter "${paramName}" must be a valid date (YYYY-MM-DD)`,
          );
        }
        break;
      }
      case 'email': {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(value)) {
          return new McpError(
            ErrorCode.InvalidParams,
            `Parameter "${paramName}" must be a valid email address`,
          );
        }
        break;
      }
      case 'uuid': {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(value)) {
          return new McpError(
            ErrorCode.InvalidParams,
            `Parameter "${paramName}" must be a valid UUID`,
          );
        }
        break;
      }
    }
    return undefined;
  }

  /**
   * Create a success result
   */
  createSuccessResult(
    text: string,
    metadata: {
      function: string;
      pod: string;
      duration_ms: number;
      cost_usd: number;
      cold_start: boolean;
      cost_breakdown?: { compute: number; network: number; queue: number };
    },
  ): InvocationResult {
    const content: InvocationContent[] = [{ type: 'text', text }];

    const result: InvocationResult = {
      success: true,
      content,
      metadata: {
        ...metadata,
      },
    };

    if (metadata.cost_breakdown) {
      result.metadata.cost_breakdown = metadata.cost_breakdown;
    }

    return result;
  }

  /**
   * Create an error result
   */
  createErrorResult(
    errorType: string,
    errorMessage: string,
    metadata: {
      function: string;
      pod: string;
      duration_ms: number;
    },
  ): InvocationResult {
    return {
      success: false,
      content: [{ type: 'text', text: `Error: ${errorMessage}` }],
      metadata: {
        ...metadata,
        cost_usd: 0,
        cold_start: false,
      },
      error: {
        error_type: errorType,
        error_message: errorMessage,
      },
    };
  }
}
