import http from 'node:http';
import { logger } from '../observability/logger.js';
import type { InvocationContent, InvocationResult, InvocationMetadata } from '../types/index.js';

export interface ResponseHandlerConfig {
  maxResponseSizeBytes: number;
  enableCaching: boolean;
  cacheTTLMs: number;
  streamingTimeoutMs: number;
}

export interface CachedResponse {
  content: InvocationContent[];
  cachedAt: number;
  expiresAt: number;
}

export class ResponseHandler {
  private config: ResponseHandlerConfig;
  private responseCache: Map<string, CachedResponse> = new Map();
  private cacheHits: number = 0;
  private cacheMisses: number = 0;
  private static readonly MAX_CACHE_SIZE = 1000;

  constructor(config: Partial<ResponseHandlerConfig> = {}) {
    this.config = {
      maxResponseSizeBytes: config.maxResponseSizeBytes ?? 10 * 1024 * 1024,
      enableCaching: config.enableCaching ?? false,
      cacheTTLMs: config.cacheTTLMs ?? 60000,
      streamingTimeoutMs: config.streamingTimeoutMs ?? 30000,
    };
  }

  parseResponse(
    functionDef: { name: string },
    podId: string,
    statusCode: number,
    data: string,
    durationMs: number,
  ): InvocationResult {
    if (statusCode === 200) {
      return this.buildSuccessResult(functionDef, podId, data, durationMs);
    } else {
      return this.buildErrorResult(functionDef, podId, statusCode, data, durationMs);
    }
  }

  private buildSuccessResult(
    functionDef: { name: string },
    podId: string,
    data: string,
    durationMs: number,
  ): InvocationResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = data;
    }

    const content: InvocationContent[] = [
      {
        type: 'text',
        text: typeof parsed === 'string' ? parsed : JSON.stringify(parsed),
      },
    ];

    const result: InvocationResult = {
      success: true,
      content,
      metadata: this.buildMetadata(functionDef, podId, durationMs),
    };

    return result;
  }

  private buildErrorResult(
    functionDef: { name: string },
    podId: string,
    statusCode: number,
    data: string,
    durationMs: number,
  ): InvocationResult {
    return {
      success: false,
      content: [{ type: 'text', text: `HTTP ${statusCode}: ${data || 'Request failed'}` }],
      metadata: this.buildMetadata(functionDef, podId, durationMs),
      error: {
        error_type: `HTTP_${statusCode}`,
        error_message: data || `HTTP request failed with status ${statusCode}`,
      },
    };
  }

  private buildMetadata(
    functionDef: { name: string },
    podId: string,
    durationMs: number,
  ): InvocationMetadata {
    return {
      function: functionDef.name,
      pod: podId,
      duration_ms: durationMs,
      cost_usd: 0,
      cold_start: false,
    };
  }

  validateResponseSize(dataLength: number): boolean {
    if (dataLength > this.config.maxResponseSizeBytes) {
      logger.warn(
        { dataLength, maxSize: this.config.maxResponseSizeBytes },
        'Response size exceeds limit',
      );
      return false;
    }
    return true;
  }

  getCachedResponse(cacheKey: string): InvocationContent[] | undefined {
    if (!this.config.enableCaching) {
      return undefined;
    }

    const cached = this.responseCache.get(cacheKey);
    if (!cached) {
      this.cacheMisses++;
      return undefined;
    }

    if (Date.now() > cached.expiresAt) {
      this.responseCache.delete(cacheKey);
      this.cacheMisses++;
      return undefined;
    }

    this.cacheHits++;
    logger.debug({ cacheKey }, 'Returning cached response');
    return cached.content;
  }

  cacheResponse(cacheKey: string, content: InvocationContent[]): void {
    if (!this.config.enableCaching) {
      return;
    }

    const now = Date.now();
    this.responseCache.set(cacheKey, {
      content,
      cachedAt: now,
      expiresAt: now + this.config.cacheTTLMs,
    });

    // Enforce max cache size
    if (this.responseCache.size > ResponseHandler.MAX_CACHE_SIZE) {
      const oldestKey = this.responseCache.keys().next().value;
      if (oldestKey) {
        this.responseCache.delete(oldestKey);
      }
    }

    logger.debug({ cacheKey, ttlMs: this.config.cacheTTLMs }, 'Response cached');
  }

  invalidateCache(cacheKey: string): void {
    this.responseCache.delete(cacheKey);
  }

  clearCache(): void {
    this.responseCache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    logger.info('Response cache cleared');
  }

  cleanupExpiredCache(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, cached] of this.responseCache.entries()) {
      if (now > cached.expiresAt) {
        this.responseCache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug({ cleaned }, 'Cleaned up expired cached responses');
    }

    return cleaned;
  }

  getCacheStats(): { size: number; hits: number; misses: number } {
    return {
      size: this.responseCache.size,
      hits: this.cacheHits,
      misses: this.cacheMisses,
    };
  }

  async streamResponse(
    podHost: string,
    podPort: number,
    functionName: string,
    requestId: string,
    onChunk: (chunk: string) => void,
    onComplete: (totalBytes: number) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const options: http.RequestOptions = {
        hostname: podHost,
        port: podPort,
        path: `/invoke/${functionName}/stream`,
        method: 'GET',
        headers: {
          'X-Request-ID': requestId,
          'X-Function-Name': functionName,
        },
        timeout: this.config.streamingTimeoutMs,
      };

      const req = http.request(options, (res) => {
        let totalBytes = 0;
        let settled = false;

        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (error) {
            onError(error);
          } else {
            onComplete(totalBytes);
          }
          resolve();
        };

        res.on('data', (chunk) => {
          const chunkStr = chunk.toString();
          totalBytes += Buffer.byteLength(chunkStr);
          onChunk(chunkStr);
        });

        res.on('end', () => {
          finish();
        });

        res.on('error', (err) => {
          finish(new Error(`Response stream error: ${err.message}`));
        });
      });

      req.on('error', (err) => {
        onError(new Error(`Request failed: ${err.message}`));
        resolve();
      });

      req.on('timeout', () => {
        req.destroy();
        onError(new Error(`Streaming timeout after ${this.config.streamingTimeoutMs}ms`));
        resolve();
      });

      req.end();
    });
  }

  async streamResponseFromPod(
    podId: string,
    podPort: number,
    functionName: string,
    args: Record<string, unknown>,
    onChunk: (chunk: string) => void,
    onComplete: (totalBytes: number) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const payload = JSON.stringify(args);
      const requestId = crypto.randomUUID();

      const options: http.RequestOptions = {
        hostname: 'localhost',
        port: podPort,
        path: `/invoke/${functionName}/stream`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Request-ID': requestId,
          'X-Pod-ID': podId,
          'X-Function-Name': functionName,
        },
        timeout: this.config.streamingTimeoutMs,
      };

      const req = http.request(options, (res) => {
        let totalBytes = 0;
        let settled = false;

        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (error) {
            onError(error);
          } else {
            onComplete(totalBytes);
          }
          resolve();
        };

        if (res.statusCode !== 200) {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            finish(new Error(`HTTP ${res.statusCode}: ${data}`));
          });
          return;
        }

        res.on('data', (chunk) => {
          const chunkStr = chunk.toString();
          totalBytes += Buffer.byteLength(chunkStr);
          onChunk(chunkStr);
        });

        res.on('end', () => {
          finish();
        });

        res.on('error', (err) => {
          finish(new Error(`Response stream error: ${err.message}`));
        });
      });

      req.on('error', (err) => {
        onError(new Error(`Request failed: ${err.message}`));
        resolve();
      });

      req.on('timeout', () => {
        req.destroy();
        onError(new Error(`Streaming timeout after ${this.config.streamingTimeoutMs}ms`));
        resolve();
      });

      req.write(payload);
      req.end();
    });
  }
}
