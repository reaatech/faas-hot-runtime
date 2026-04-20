import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FunctionRegistry } from '../../registry/function-registry.js';

export interface HttpSkillConfig {
  functionRegistry: FunctionRegistry;
  httpHost: string;
  httpPort: number;
}

export interface GetHttpEndpointsParams {
  function?: string;
}

export interface TestHttpEndpointParams {
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export class HttpSkillHandler {
  private functionRegistry: FunctionRegistry;
  private httpHost: string;
  private httpPort: number;

  constructor(config: HttpSkillConfig) {
    this.functionRegistry = config.functionRegistry;
    this.httpHost = config.httpHost;
    this.httpPort = config.httpPort;
  }

  getTools(): Tool[] {
    return [
      {
        name: 'get_http_endpoints',
        description: 'Get HTTP endpoints for serverless functions',
        inputSchema: {
          type: 'object',
          properties: {
            function: {
              type: 'string',
              description: 'Function name to get endpoints for (optional for all)',
            },
          },
        },
      },
      {
        name: 'test_http_endpoint',
        description: 'Test an HTTP endpoint with a sample request',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'HTTP path to test (e.g., /my-function)',
            },
            method: {
              type: 'string',
              enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
              description: 'HTTP method',
              default: 'GET',
            },
            body: {
              type: 'object',
              description: 'Request body for POST/PUT/PATCH',
            },
            headers: {
              type: 'object',
              description: 'Additional headers',
            },
          },
          required: ['path'],
        },
      },
    ];
  }

  private static readonly SENSITIVE_RESPONSE_HEADERS = [
    'x-internal-',
    'server',
    'x-powered-by',
    'x-request-id',
  ];

  async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    switch (toolName) {
      case 'get_http_endpoints':
        return this.getHttpEndpoints(this.validateGetEndpointsArgs(args));
      case 'test_http_endpoint':
        return this.testHttpEndpoint(this.validateTestEndpointArgs(args));
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown HTTP tool: ${toolName}`);
    }
  }

  private validateGetEndpointsArgs(args: Record<string, unknown>): GetHttpEndpointsParams {
    const result: GetHttpEndpointsParams = {};
    if (args['function'] !== undefined) {
      if (typeof args['function'] !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, 'function must be a string');
      }
      result.function = args['function'];
    }
    return result;
  }

  private validateTestEndpointArgs(args: Record<string, unknown>): TestHttpEndpointParams {
    if (typeof args['path'] !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'path is required and must be a string');
    }
    const path = args['path'];
    if (!path.startsWith('/')) {
      throw new McpError(ErrorCode.InvalidParams, 'path must start with "/"');
    }
    if (path.includes('..')) {
      throw new McpError(ErrorCode.InvalidParams, 'path must not contain ".." sequences');
    }
    if (/^https?:\/\//i.test(path)) {
      throw new McpError(ErrorCode.InvalidParams, 'path must not be an absolute URL');
    }
    const result: TestHttpEndpointParams = { path };
    if (args['method'] !== undefined) {
      if (
        typeof args['method'] !== 'string' ||
        !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(args['method'])
      ) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'method must be one of: GET, POST, PUT, PATCH, DELETE',
        );
      }
      result.method = args['method'] as TestHttpEndpointParams['method'];
    }
    if (args['body'] !== undefined) {
      if (typeof args['body'] !== 'object' || args['body'] === null) {
        throw new McpError(ErrorCode.InvalidParams, 'body must be an object');
      }
      result.body = args['body'] as Record<string, unknown>;
    }
    if (args['headers'] !== undefined) {
      if (typeof args['headers'] !== 'object' || args['headers'] === null) {
        throw new McpError(ErrorCode.InvalidParams, 'headers must be an object');
      }
      result.headers = args['headers'] as Record<string, string>;
    }
    return result;
  }

  private getHttpEndpoints(params: GetHttpEndpointsParams): {
    content: Array<{ type: string; text: string }>;
  } {
    const functions = this.functionRegistry.getAllFunctions();
    const endpoints = [];

    for (const func of functions) {
      if (params.function && func.name !== params.function) {
        continue;
      }

      const httpTriggers = func.triggers.filter((t) => t.type === 'http');
      for (const trigger of httpTriggers) {
        if (trigger.path) {
          endpoints.push({
            function: func.name,
            path: trigger.path,
            methods: trigger.methods || ['GET', 'POST'],
            auth_required: trigger.auth_required ?? false,
          });
        }
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify({ endpoints }, null, 2) }] };
  }

  private async testHttpEndpoint(
    params: TestHttpEndpointParams,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const startTime = Date.now();

    try {
      const method = params.method ?? 'GET';
      const url = `http://${this.httpHost}:${this.httpPort}${params.path}`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...params.headers,
      };

      const options: RequestInit = {
        method,
        headers,
      };

      if (params.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
        options.body = JSON.stringify(params.body);
      }

      const response = await fetch(url, options);
      const durationMs = Date.now() - startTime;

      let responseBody: unknown;
      const contentType = response.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        responseBody = await response.json();
      } else {
        responseBody = await response.text();
      }

      const filteredHeaders: Record<string, string> = {};
      for (const [key, value] of response.headers.entries()) {
        const keyLower = key.toLowerCase();
        if (!HttpSkillHandler.SENSITIVE_RESPONSE_HEADERS.some((h) => keyLower.startsWith(h))) {
          filteredHeaders[key] = value;
        }
      }

      const result = {
        status: response.status,
        status_text: response.statusText,
        headers: filteredHeaders,
        body: responseBody,
        duration_ms: durationMs,
      };

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const result = {
        status: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
        duration_ms: durationMs,
      };

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  }
}
