import { createServer, type Server as HTTPServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { logger } from '../observability/logger.js';
import type { FunctionDefinition, InvocationRequest, InvocationResult, HTTPTriggerConfig as DomainHTTPTriggerConfig } from '../types/index.js';

export interface HTTPTriggerServerConfig {
  host: string;
  port: number;
  maxBodySizeBytes?: number;
  requestTimeoutMs?: number;
  corsOrigin?: string;
  apiKey?: string;
}

export interface HTTPTriggerHandler {
  handleRequest(request: InvocationRequest): Promise<InvocationResult>;
}

/**
 * HTTP Trigger Handler
 * Exposes RESTful endpoints for function invocation
 */
export class HTTPTrigger {
  private config: HTTPTriggerServerConfig;
  private server?: HTTPServer;
  private handlers: Map<string, HTTPTriggerHandler> = new Map();
  private functions: Map<string, FunctionDefinition> = new Map();
  private maxBodySizeBytes: number;
  private requestTimeoutMs: number;
  private corsOrigin: string;
  private apiKeyHash?: Buffer;

  constructor(config: HTTPTriggerServerConfig) {
    this.config = config;
    this.maxBodySizeBytes = config.maxBodySizeBytes ?? 1024 * 1024;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30000;
    this.corsOrigin = config.corsOrigin ?? '';
    this.apiKeyHash = config.apiKey ? createHash('sha256').update(config.apiKey).digest() : undefined;
  }

  /**
   * Start the HTTP trigger server
   */
  async start(): Promise<void> {
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', this.corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        await this.handleRequest(req, res);
      } catch (error) {
        logger.error({ error }, 'HTTP trigger request failed');
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        } else {
          res.end();
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.on('error', reject);
      this.server!.listen(this.config.port, this.config.host, () => {
        logger.info(
          { host: this.config.host, port: this.config.port },
          'HTTP trigger server started',
        );
        resolve();
      });
    });
  }

  /**
   * Handle incoming HTTP request
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // Health check
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy' }));
      return;
    }

    // Find matching function by path
    const functionDef = this.findFunctionByPath(url.pathname, req.method ?? 'GET');
    if (!functionDef) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Function not found' }));
      return;
    }

    const httpTrigger = functionDef.triggers.find((t): t is DomainHTTPTriggerConfig => t.type === 'http');
    if (httpTrigger?.auth_required) {
      const apiKey = req.headers['x-api-key'];
      if (!this.validateApiKey(apiKey)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    // Get handler
    const handler = this.handlers.get(functionDef.name);
    if (!handler) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Handler not found' }));
      return;
    }

    // Parse body with size limit and timeout
    let body: Record<string, unknown> = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      const parsed = await this.parseBody(req, res);
      if (parsed === null) return; // Error or timeout
      body = parsed;
    }

    // Create invocation request
    const request: InvocationRequest = {
      function: functionDef.name,
      arguments: { ...body, ...Object.fromEntries(url.searchParams) },
      request_id: crypto.randomUUID(),
    };

    // Handle invocation with timeout
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Request timeout')), this.requestTimeoutMs);
    });

    const result = await Promise.race([
      handler.handleRequest(request),
      timeoutPromise,
    ]).catch((error) => {
      logger.error({ error: error.message }, 'Request timeout');
      return {
        success: false,
        content: [{ type: 'text', text: 'Request timeout' }],
        metadata: { function: functionDef.name, pod: 'unknown', duration_ms: 0, cost_usd: 0, cold_start: false },
        error: { error_type: 'Timeout', error_message: error.message },
      } as InvocationResult;
    }).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });

    res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  /**
   * Find function by HTTP path and method
   */
  private findFunctionByPath(path: string, method: string): FunctionDefinition | undefined {
    for (const func of this.functions.values()) {
      const httpTriggers = func.triggers.filter((t) => t.type === 'http');
      for (const trigger of httpTriggers) {
        if (trigger.path === path) {
          if (!trigger.methods || trigger.methods.includes(method)) {
            return func;
          }
        }
      }
    }
    return undefined;
  }

  /**
   * Parse request body
   */
private async parseBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      let body = '';
      let size = 0;

      const cleanup = () => {
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        req.removeAllListeners('error');
      };

      const rejectRequest = (statusCode: number, errorMessage: string) => {
        cleanup();
        if (!res.headersSent) {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: errorMessage }));
        } else {
          res.end();
        }
        resolve(null);
      };

      req.on('data', (chunk) => {
        size += chunk.length;
      if (size > this.maxBodySizeBytes) {
            logger.warn({ size }, 'HTTP request body exceeded size limit');
            req.destroy();
            rejectRequest(413, 'Request body too large');
          return;
        }
        body += chunk;
      });

      req.on('end', () => {
        cleanup();
        try {
          const parsed = body ? JSON.parse(body) : {};
          resolve(parsed);
        } catch (_error) {
          rejectRequest(400, 'Invalid JSON body');
        }
      });

      req.on('error', () => {
        cleanup();
        resolve(null);
      });
    });
  }

  /**
   * Register a function with its HTTP trigger
   */
  registerFunction(func: FunctionDefinition, handler: HTTPTriggerHandler): void {
    this.functions.set(func.name, func);
    this.handlers.set(func.name, handler);
    logger.info({ function: func.name }, 'Function registered with HTTP trigger');
  }

  /**
   * Unregister a function
   */
  unregisterFunction(functionName: string): void {
    this.functions.delete(functionName);
    this.handlers.delete(functionName);
    logger.info({ function: functionName }, 'Function unregistered from HTTP trigger');
  }

  /**
   * Stop the HTTP trigger server
   */
  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = undefined;
    }
    logger.info('HTTP trigger server stopped');
  }

  private validateApiKey(apiKey: string | string[] | undefined): boolean {
    if (!this.apiKeyHash) {
      return false;
    }

    const candidate = Array.isArray(apiKey) ? apiKey[0] : apiKey;
    if (!candidate) {
      return false;
    }

    const candidateHash = createHash('sha256').update(candidate).digest();
    return candidateHash.length === this.apiKeyHash.length && timingSafeEqual(candidateHash, this.apiKeyHash);
  }
}
