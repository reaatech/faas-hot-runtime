import http from 'node:http';
import { logger } from '../observability/logger.js';
import type { InvocationRequest, InvocationResult } from '../types/index.js';
import type { PoolManager } from '../pool-manager/pool-manager.js';
import type { FunctionRegistry } from '../registry/function-registry.js';
import { RequestRouter } from './request-router.js';
import { ResponseHandler } from './response-handler.js';
import { TimeoutManager } from './timeout-manager.js';

export interface InvokerEngineConfig {
  maxRetries: number;
  retryDelayMs: number;
  enableRequestRouting: boolean;
  defaultPodHost: string;
}

export class InvokerEngine {
  private poolManager: PoolManager;
  private functionRegistry: FunctionRegistry;
  private httpAgent: http.Agent;
  private requestRouter: RequestRouter;
  private responseHandler: ResponseHandler;
  private timeoutManager: TimeoutManager;
  private config: InvokerEngineConfig;

  constructor(
    poolManager: PoolManager,
    functionRegistry: FunctionRegistry,
    config: Partial<InvokerEngineConfig> = {},
  ) {
    this.poolManager = poolManager;
    this.functionRegistry = functionRegistry;
    this.config = {
      maxRetries: config.maxRetries ?? 3,
      retryDelayMs: config.retryDelayMs ?? 100,
      enableRequestRouting: config.enableRequestRouting ?? true,
      defaultPodHost: config.defaultPodHost ?? 'localhost',
    };

    this.httpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 100,
      maxFreeSockets: 10,
      timeout: 5000,
    });

    this.requestRouter = new RequestRouter();
    this.responseHandler = new ResponseHandler();
    this.timeoutManager = new TimeoutManager();

    this.timeoutManager.start();
    if (this.config.enableRequestRouting) {
      this.requestRouter.start();
    }
  }

  async invoke(request: InvocationRequest): Promise<InvocationResult> {
    const startTime = Date.now();
    const { function: functionName, arguments: args, request_id } = request;

    const redactedArgs = InvokerEngine.redactSensitiveArgs(args);
    logger.info(
      { function: functionName, request_id, args: JSON.stringify(redactedArgs).substring(0, 200) },
      'Starting function invocation',
    );

    try {
      const functionDef = this.functionRegistry.getFunction(functionName);
      if (!functionDef) {
        return this.createErrorResult(
          'FunctionNotFound',
          `Function "${functionName}" not found`,
          startTime,
          functionName,
          'unknown',
        );
      }

      let podId = await this.poolManager.selectPod(functionName);
      let lastError: Error | undefined;

      for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
        const podStartTime = Date.now();

        try {
          const effectiveTimeout = request.timeout_ms ?? 30000;

          if (attempt > 1) {
            this.timeoutManager.clearInvocationTimeout(request_id);
          }

          this.timeoutManager.startInvocation(request_id, functionName, podId, effectiveTimeout);

          const result = await this.executeOnPod(
            functionDef,
            podId,
            args,
            request_id,
            effectiveTimeout,
          );

          this.timeoutManager.endInvocation(request_id);

          await this.poolManager.releasePod(functionName, podId, Date.now() - podStartTime);

          logger.info(
            {
              function: functionName,
              pod_id: podId,
              duration_ms: Date.now() - startTime,
              request_id,
            },
            'Function invocation completed',
          );

          return result;
        } catch (error) {
          this.timeoutManager.endInvocation(request_id);
          lastError = error instanceof Error ? error : new Error('Unknown error');

          if (attempt < this.config.maxRetries) {
            logger.warn(
              { function: functionName, attempt, error: lastError.message },
              'Retrying invocation with fallback pod',
            );

            const fallbackPodId = await this.poolManager.selectPod(functionName);
            if (fallbackPodId !== podId) {
              await this.poolManager.releasePod(functionName, podId, 0).catch(() => {});
              podId = fallbackPodId;
            }

            await this.sleep(this.config.retryDelayMs * Math.pow(2, attempt - 1));
          }
        }
      }

      await this.poolManager
        .releasePod(functionName, podId, Date.now() - startTime)
        .catch(() => {});

      return this.createErrorResult(
        lastError?.name ?? 'InvocationError',
        lastError?.message ?? 'Invocation failed after retries',
        startTime,
        functionName,
        podId,
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(
        {
          function: functionName,
          duration_ms: duration,
          error: error instanceof Error ? error.message : error,
          request_id,
        },
        'Function invocation failed',
      );

      return this.createErrorResult(
        error instanceof Error ? error.name : 'UnknownError',
        error instanceof Error ? error.message : 'Unknown error occurred',
        startTime,
        functionName,
        'unknown',
      );
    }
  }

  private async executeOnPod(
    functionDef: { name: string; container: { port: number } },
    podId: string,
    args: Record<string, unknown>,
    requestId: string,
    timeoutMs: number,
  ): Promise<InvocationResult> {
    const startTime = Date.now();
    const port = functionDef.container.port;
    const host = this.config.defaultPodHost;

    return new Promise<InvocationResult>((resolve, reject) => {
      let settled = false;
      const payload = JSON.stringify(args);
      const path = `/invoke/${functionDef.name}`;

      const options: http.RequestOptions = {
        hostname: host,
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Request-ID': requestId,
          'X-Pod-ID': podId,
        },
        agent: this.httpAgent,
        timeout: timeoutMs,
      };

      const req = http.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (settled) return;
          settled = true;

          const duration = Date.now() - startTime;

          if (!this.responseHandler.validateResponseSize(data.length)) {
            resolve({
              success: false,
              content: [{ type: 'text', text: 'Response size exceeded limit' }],
              metadata: {
                function: functionDef.name,
                pod: podId,
                duration_ms: duration,
                cost_usd: 0,
                cold_start: false,
              },
              error: {
                error_type: 'ResponseSizeExceeded',
                error_message: 'Response size exceeded maximum allowed size',
              },
            });
            return;
          }

          const result = this.responseHandler.parseResponse(
            functionDef,
            podId,
            res.statusCode ?? 0,
            data,
            duration,
          );

          const computeCost = this.calculateComputeCost(functionDef, duration);
          const networkCost = this.calculateNetworkCost(data.length);
          const totalCost = computeCost + networkCost;

          result.metadata = {
            ...result.metadata,
            cost_usd: totalCost,
            cost_breakdown: {
              compute: computeCost,
              network: networkCost,
              queue: 0,
            },
          };

          resolve(result);
        });
      });

      req.on('error', (error) => {
        if (settled) return;
        settled = true;
        const duration = Date.now() - startTime;
        logger.error(
          { pod: podId, function: functionDef.name, error: error.message, duration_ms: duration },
          'Pod HTTP request failed',
        );

        reject(error);
      });

      req.on('timeout', () => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
      });

      req.write(payload);
      req.end();
    });
  }

  private createErrorResult(
    errorType: string,
    errorMessage: string,
    startTime: number,
    functionName: string,
    podId: string,
  ): InvocationResult {
    return {
      success: false,
      content: [{ type: 'text', text: `Error: ${errorMessage}` }],
      metadata: {
        function: functionName,
        pod: podId,
        duration_ms: Date.now() - startTime,
        cost_usd: 0,
        cold_start: false,
      },
      error: {
        error_type: errorType,
        error_message: errorMessage,
      },
    };
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

  private static redactSensitiveArgs(args: Record<string, unknown>): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (this.SENSITIVE_FIELDS.some((field) => key.toLowerCase().includes(field))) {
        redacted[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        redacted[key] = this.redactSensitiveArgs(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        redacted[key] = value.map((item) =>
          typeof item === 'object' && item !== null
            ? this.redactSensitiveArgs(item as Record<string, unknown>)
            : item,
        );
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  calculateCost(
    functionDef: { name: string; container: { port: number } },
    durationMs: number,
  ): number {
    const computeCost = this.calculateComputeCost(functionDef, durationMs);
    const networkCost = 0.00001;
    return computeCost + networkCost;
  }

  calculateComputeCost(
    _functionDef: { name: string; container: { port: number } },
    durationMs: number,
  ): number {
    return (durationMs / 100) * 0.0001;
  }

  calculateNetworkCost(responseBytes: number): number {
    return (responseBytes / 1024 / 1024 / 1024) * 0.01;
  }

  getRequestRouter(): RequestRouter {
    return this.requestRouter;
  }

  getResponseHandler(): ResponseHandler {
    return this.responseHandler;
  }

  getTimeoutManager(): TimeoutManager {
    return this.timeoutManager;
  }

  async stop(): Promise<void> {
    this.timeoutManager.stop();
    this.requestRouter.stop();
    this.httpAgent.destroy();
    logger.info('Invoker engine stopped');
  }
}
