import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  PingRequestSchema,
  ErrorCode,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  createServer,
  type Server as HTTPServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { logger } from '../observability/logger.js';
import type { FunctionDefinition, InvocationResult } from '../types/index.js';
import type { ToolRegistry } from './tool-registry.js';
import type { RequestHandler } from './request-handler.js';
import { AuthMiddleware } from './auth-middleware.js';
import {
  CostSkillHandler,
  ScalingSkillHandler,
  WarmPoolSkillHandler,
  QueueSkillHandler,
  ObservabilitySkillHandler,
  HttpSkillHandler,
  type CostSkillConfig,
  type ScalingSkillConfig,
  type WarmPoolSkillConfig,
  type QueueSkillConfig,
  type ObservabilitySkillConfig,
  type HttpSkillConfig,
} from './skills/index.js';

interface SkillToolHandler {
  getTools(): Tool[];
  handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
    isError?: boolean;
  }>;
}

export interface MCPServerConfig {
  host: string;
  port: number;
  apiKey: string;
  corsOrigin?: string;
  rateLimitPerMinute?: number;
}

export interface SkillConfig {
  cost?: CostSkillConfig;
  scaling?: ScalingSkillConfig;
  warmPool?: WarmPoolSkillConfig;
  queue?: QueueSkillConfig;
  observability?: ObservabilitySkillConfig;
  http?: HttpSkillConfig;
}

export interface MCPHealthStatus {
  status: 'healthy' | 'unhealthy';
  uptime_seconds: number;
  pool_utilization: number;
  active_functions: number;
}

export class MCPServer {
  private server: Server;
  private httpServer?: HTTPServer;
  private transport?: StreamableHTTPServerTransport;
  private config: MCPServerConfig;
  private toolRegistry: ToolRegistry;
  private requestHandler: RequestHandler;
  private authMiddleware: AuthMiddleware;
  private startTime: number;
  private skillHandlers: Map<string, SkillToolHandler> = new Map();
  private toolNameToHandler: Map<string, SkillToolHandler> = new Map();
  private functionToolNames: Set<string> = new Set();
  private invocationCount: number = 0;
  private errorCount: number = 0;

  constructor(
    config: MCPServerConfig,
    toolRegistry: ToolRegistry,
    requestHandler: RequestHandler,
    skillConfig?: SkillConfig,
  ) {
    this.config = config;
    this.toolRegistry = toolRegistry;
    this.requestHandler = requestHandler;
    this.authMiddleware = new AuthMiddleware({
      apiKey: config.apiKey,
      rateLimit: config.rateLimitPerMinute
        ? { requestsPerMinute: config.rateLimitPerMinute }
        : undefined,
    });
    this.startTime = Date.now();

    this.server = new Server(
      {
        name: 'faas-hot-runtime',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.initializeSkillHandlers(skillConfig);
    this.setupToolHandlers();
  }

  private initializeSkillHandlers(skillConfig?: SkillConfig): void {
    if (skillConfig?.cost) {
      const handler = new CostSkillHandler(skillConfig.cost);
      this.skillHandlers.set('cost', handler);
    }

    if (skillConfig?.scaling) {
      const handler = new ScalingSkillHandler(skillConfig.scaling);
      this.skillHandlers.set('scaling', handler);
    }

    if (skillConfig?.warmPool) {
      const handler = new WarmPoolSkillHandler(skillConfig.warmPool);
      this.skillHandlers.set('warmPool', handler);
    }

    if (skillConfig?.queue) {
      const handler = new QueueSkillHandler(skillConfig.queue);
      this.skillHandlers.set('queue', handler);
    }

    if (skillConfig?.observability) {
      const handler = new ObservabilitySkillHandler();
      this.skillHandlers.set('observability', handler);
    }

    if (skillConfig?.http) {
      const handler = new HttpSkillHandler(skillConfig.http);
      this.skillHandlers.set('http', handler);
    }

    for (const handler of this.skillHandlers.values()) {
      for (const tool of handler.getTools()) {
        this.toolNameToHandler.set(tool.name, handler);
      }
    }

    const functionTools = this.toolRegistry.listTools();
    this.functionToolNames = new Set(functionTools.map((t) => t.name));
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(PingRequestSchema, async () => {
      const health = this.getHealthStatus();
      return {
        status: health.status,
        uptime_seconds: health.uptime_seconds,
        pool_utilization: health.pool_utilization,
        active_functions: health.active_functions,
      };
    });

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const functionTools = this.toolRegistry.listTools();
      const skillTools: Tool[] = [];

      for (const handler of this.skillHandlers.values()) {
        skillTools.push(...handler.getTools());
      }

      const allTools = [...functionTools, ...skillTools];
      logger.debug(
        { functionToolCount: functionTools.length, skillToolCount: skillTools.length },
        'Listing MCP tools',
      );
      return { tools: allTools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      const redactedArgs = this.redactArgs(args);
      logger.debug({ name, args: JSON.stringify(redactedArgs) }, 'MCP tool call requested');

      if (this.functionToolNames.has(name)) {
        try {
          const result = await this.requestHandler.handleToolCall(name, args ?? {});
          this.trackInvocation(false);
          return this.formatMCPResponse(result);
        } catch (error) {
          this.trackInvocation(true);
          logger.error({ error, name }, 'Tool call failed');
          throw this.formatMCPError(error);
        }
      }

      const skillHandler = this.toolNameToHandler.get(name);
      if (skillHandler) {
        try {
          const result = await skillHandler.handleToolCall(name, args ?? {});
          this.trackInvocation(false);
          return result;
        } catch (error) {
          this.trackInvocation(true);
          logger.error({ error, name }, 'Skill tool call failed');
          throw this.formatMCPError(error);
        }
      }

      throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
    });
  }

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

  private redactArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!args) return {};
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (MCPServer.SENSITIVE_FIELDS.some((field) => key.toLowerCase().includes(field))) {
        redacted[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        redacted[key] = this.redactArgs(value as Record<string, unknown>);
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  private formatMCPResponse(result: InvocationResult): {
    content: Array<{ type: string; text: string }>;
    structuredContent: Record<string, unknown>;
    _meta: Record<string, unknown>;
    isError?: boolean;
  } {
    const content = result.content.map((c) => {
      if (c.type === 'text') {
        return { type: c.type, text: c.text };
      } else if (c.type === 'image') {
        return { type: c.type, text: `[image: ${c.mimeType}]` };
      } else {
        return { type: c.type, text: `[resource: ${c.uri}]` };
      }
    });

    return {
      content,
      structuredContent: {
        success: result.success,
        metadata: result.metadata,
        error: result.error,
      },
      _meta: {
        metadata: result.metadata,
      },
      isError: !result.success || undefined,
    };
  }

  private formatMCPError(error: unknown): McpError {
    if (error instanceof McpError) {
      return error;
    }

    const err = error as Error & { code?: number };
    const message = err.message ?? 'Unknown error occurred';
    const code = err.code ?? ErrorCode.InternalError;

    return new McpError(code, message, {
      error_type: err.name,
      error_message: message,
    });
  }

  async start(): Promise<void> {
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    await this.server.connect(this.transport);

    const corsOrigin = this.config.corsOrigin ?? '';

    this.httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (corsOrigin) {
          res.setHeader('Access-Control-Allow-Origin', corsOrigin);
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.url === '/health' && req.method === 'GET') {
          const health = this.getHealthStatus();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(health));
          return;
        }

        if (req.url === '/mcp' && req.method === 'POST') {
          const apiKeyHeader = req.headers['x-api-key'];
          const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
          if (!this.authMiddleware.validateApiKey(apiKey)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32001, message: 'Unauthorized' },
              }),
            );
            return;
          }

          const clientId = req.socket.remoteAddress ?? 'unknown';
          const rateLimitResult = this.authMiddleware.checkRateLimit(clientId);
          if (!rateLimitResult.allowed) {
            res.writeHead(429, {
              'Content-Type': 'application/json',
              'Retry-After': String(rateLimitResult.retryAfter ?? 60),
            });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: {
                  code: -32002,
                  message: 'Rate limit exceeded',
                  data: { retry_after: rateLimitResult.retryAfter },
                },
              }),
            );
            return;
          }

          const transport = this.transport;
          if (!transport) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Service unavailable' }));
            return;
          }

          await transport.handleRequest(req, res);
          return;
        }

        if (req.url === '/metrics' && req.method === 'GET') {
          const apiKeyHeader = req.headers['x-api-key'];
          const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
          if (!this.authMiddleware.validateApiKey(apiKey)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
          }
          const metrics = this.getMetrics();
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(metrics);
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      } catch (error) {
        logger.error({ error }, 'HTTP request handling failed');
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.config.port, this.config.host, (err?: Error) => {
        if (err) {
          reject(err);
          return;
        }
        logger.info({ host: this.config.host, port: this.config.port }, 'MCP server started');
        resolve();
      });
    });
  }

  /**
   * Stop the MCP server
   */
  async stop(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = undefined;
    }

    if (this.transport) {
      await this.transport.close();
      this.transport = undefined;
    }

    this.authMiddleware.stop();

    logger.info('MCP server stopped');
  }

  /**
   * Get server health status
   */
  getHealthStatus(): MCPHealthStatus {
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    const tools = this.toolRegistry.listTools();
    const poolUtilization = this.toolRegistry.getPoolUtilization();

    return {
      status: 'healthy',
      uptime_seconds: uptimeSeconds,
      pool_utilization: poolUtilization,
      active_functions: tools.length,
    };
  }

  /**
   * Track an invocation for metrics
   */
  trackInvocation(error?: boolean): void {
    this.invocationCount++;
    if (error) {
      this.errorCount++;
    }
  }

  /**
   * Get Prometheus-format metrics
   */
  getMetrics(): string {
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    const tools = this.toolRegistry.listTools();
    const poolUtilization = this.toolRegistry.getPoolUtilization();
    const errorRate = this.invocationCount > 0 ? this.errorCount / this.invocationCount : 0;

    const lines = [
      '# HELP faas_hot_runtime_uptime_seconds Server uptime in seconds',
      '# TYPE faas_hot_runtime_uptime_seconds gauge',
      `faas_hot_runtime_uptime_seconds ${uptimeSeconds}`,
      '',
      '# HELP faas_hot_runtime_invocations_total Total function invocations',
      '# TYPE faas_hot_runtime_invocations_total counter',
      `faas_hot_runtime_invocations_total ${this.invocationCount}`,
      '',
      '# HELP faas_hot_runtime_errors_total Total invocation errors',
      '# TYPE faas_hot_runtime_errors_total counter',
      `faas_hot_runtime_errors_total ${this.errorCount}`,
      '',
      '# HELP faas_hot_runtime_error_rate Error rate ratio',
      '# TYPE faas_hot_runtime_error_rate gauge',
      `faas_hot_runtime_error_rate ${errorRate}`,
      '',
      '# HELP faas_hot_runtime_active_functions Number of registered functions',
      '# TYPE faas_hot_runtime_active_functions gauge',
      `faas_hot_runtime_active_functions ${tools.length}`,
      '',
      '# HELP faas_hot_runtime_pool_utilization Pool utilization ratio',
      '# TYPE faas_hot_runtime_pool_utilization gauge',
      `faas_hot_runtime_pool_utilization ${poolUtilization}`,
    ];

    return lines.join('\n');
  }

  /**
   * Register a function definition
   */
  registerFunction(definition: FunctionDefinition): void {
    const existingToolName = this.toolRegistry.getToolNameByFunction(definition.name);
    if (existingToolName) {
      this.toolRegistry.unregisterTool(definition.name);
      this.functionToolNames.delete(existingToolName);
    }

    this.toolRegistry.registerTool(definition);
    if (definition.mcp.enabled) {
      this.functionToolNames.add(definition.mcp.tool_name);
    }
    logger.info(
      { function: definition.name, tool_name: definition.mcp?.tool_name },
      'Function registered',
    );
  }

  unregisterFunction(functionName: string): void {
    const toolName = this.toolRegistry.getToolNameByFunction(functionName);
    this.toolRegistry.unregisterTool(functionName);
    if (toolName) {
      this.functionToolNames.delete(toolName);
    }
    logger.info({ function: functionName }, 'Function unregistered');
  }
}
