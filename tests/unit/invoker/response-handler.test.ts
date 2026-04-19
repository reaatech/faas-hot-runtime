import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ResponseHandler } from '../../../src/invoker/response-handler.js';
import type { ResponseHandlerConfig } from '../../../src/invoker/response-handler.js';

vi.mock('../../../src/observability/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('ResponseHandler', () => {
  let handler: ResponseHandler;

  beforeEach(() => {
    handler = new ResponseHandler({
      maxResponseSizeBytes: 10 * 1024 * 1024,
      enableCaching: false,
      cacheTTLMs: 60000,
    });
  });

  describe('constructor', () => {
    it('should use default config', () => {
      const defaultHandler = new ResponseHandler();
      expect((defaultHandler as unknown as { config: ResponseHandlerConfig }).config.maxResponseSizeBytes).toBe(10 * 1024 * 1024);
      expect((defaultHandler as unknown as { config: ResponseHandlerConfig }).config.enableCaching).toBe(false);
    });

    it('should accept custom config', () => {
      const customHandler = new ResponseHandler({
        maxResponseSizeBytes: 5 * 1024 * 1024,
        enableCaching: true,
        cacheTTLMs: 30000,
      });
      expect((customHandler as unknown as { config: ResponseHandlerConfig }).config.maxResponseSizeBytes).toBe(5 * 1024 * 1024);
      expect((customHandler as unknown as { config: ResponseHandlerConfig }).config.enableCaching).toBe(true);
    });
  });

  describe('parseResponse', () => {
    it('should parse 200 response as success', () => {
      const result = handler.parseResponse(
        { name: 'test-func' },
        'pod-1',
        200,
        '{"result":"success"}',
        100,
      );

      expect(result.success).toBe(true);
      expect(result.content[0].type).toBe('text');
    });

    it('should parse 200 JSON response', () => {
      const result = handler.parseResponse(
        { name: 'test-func' },
        'pod-1',
        200,
        '{"result":"success"}',
        100,
      );

      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('result');
    });

    it('should handle malformed JSON as text', () => {
      const result = handler.parseResponse(
        { name: 'test-func' },
        'pod-1',
        200,
        'not json',
        100,
      );

      expect(result.success).toBe(true);
      expect((result.content[0] as { type: 'text'; text: string }).text).toBe('not json');
    });

    it('should parse non-200 as error', () => {
      const result = handler.parseResponse(
        { name: 'test-func' },
        'pod-1',
        500,
        'Internal Server Error',
        100,
      );

      expect(result.success).toBe(false);
      expect(result.error?.error_type).toBe('HTTP_500');
      expect(result.error?.error_message).toBe('Internal Server Error');
    });

    it('should parse 404 error', () => {
      const result = handler.parseResponse(
        { name: 'test-func' },
        'pod-1',
        404,
        'Not Found',
        100,
      );

      expect(result.success).toBe(false);
      expect(result.error?.error_type).toBe('HTTP_404');
    });

    it('should include metadata', () => {
      const result = handler.parseResponse(
        { name: 'test-func' },
        'pod-1',
        200,
        '{}',
        150,
      );

      expect(result.metadata?.function).toBe('test-func');
      expect(result.metadata?.pod).toBe('pod-1');
      expect(result.metadata?.duration_ms).toBe(150);
      expect(result.metadata?.cold_start).toBe(false);
    });
  });

  describe('validateResponseSize', () => {
    it('should return true for small response', () => {
      expect(handler.validateResponseSize(1000)).toBe(true);
    });

    it('should return true for exactly max size', () => {
      expect(handler.validateResponseSize(10 * 1024 * 1024)).toBe(true);
    });

    it('should return false for oversized response', () => {
      expect(handler.validateResponseSize(10 * 1024 * 1024 + 1)).toBe(false);
    });
  });

  describe('cacheResponse', () => {
    it('should return undefined when caching disabled', () => {
      const result = handler.getCachedResponse('key');
      expect(result).toBeUndefined();
    });

    it('should cache when enabled', () => {
      const enabledHandler = new ResponseHandler({
        enableCaching: true,
        cacheTTLMs: 60000,
      });

      enabledHandler.cacheResponse('key', [{ type: 'text', text: 'cached' }]);

      const result = enabledHandler.getCachedResponse('key');
      expect(result).toBeDefined();
      expect((result![0] as { type: 'text'; text: string }).text).toBe('cached');
    });

    it('should return undefined for expired cache', async () => {
      const shortTTLHandler = new ResponseHandler({
        enableCaching: true,
        cacheTTLMs: 1,
      });

      shortTTLHandler.cacheResponse('key', [{ type: 'text', text: 'cached' }]);

      await new Promise(resolve => setTimeout(resolve, 10));

      const result = shortTTLHandler.getCachedResponse('key');
      expect(result).toBeUndefined();
    });
  });

  describe('invalidateCache', () => {
    it('should remove cached entry', () => {
      const enabledHandler = new ResponseHandler({
        enableCaching: true,
        cacheTTLMs: 60000,
      });

      enabledHandler.cacheResponse('key', [{ type: 'text', text: 'cached' }]);
      enabledHandler.invalidateCache('key');

      expect(enabledHandler.getCachedResponse('key')).toBeUndefined();
    });
  });

  describe('clearCache', () => {
    it('should clear all cached entries', () => {
      const enabledHandler = new ResponseHandler({
        enableCaching: true,
        cacheTTLMs: 60000,
      });

      enabledHandler.cacheResponse('key1', [{ type: 'text', text: 'cached1' }]);
      enabledHandler.cacheResponse('key2', [{ type: 'text', text: 'cached2' }]);
      enabledHandler.clearCache();

      expect(enabledHandler.getCacheStats().size).toBe(0);
    });
  });

  describe('getCacheStats', () => {
    it('should return cache stats', () => {
      const enabledHandler = new ResponseHandler({
        enableCaching: true,
        cacheTTLMs: 60000,
      });

      enabledHandler.cacheResponse('key1', [{ type: 'text', text: 'cached1' }]);

      const stats = enabledHandler.getCacheStats();
      expect(stats.size).toBe(1);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });
  });

  describe('cleanupExpiredCache', () => {
    it('should return 0 when no expired entries', () => {
      const enabledHandler = new ResponseHandler({
        enableCaching: true,
        cacheTTLMs: 60000,
      });

      enabledHandler.cacheResponse('key', [{ type: 'text', text: 'cached' }]);

      expect(enabledHandler.cleanupExpiredCache()).toBe(0);
    });
  });

  describe('streamResponse', () => {
    it('should call onError when connection fails', async () => {
      const onChunk = vi.fn();
      const onComplete = vi.fn();
      const onError = vi.fn();

      await handler.streamResponse('localhost', 9999, 'test-func', 'req-1', onChunk, onComplete, onError);

      expect(onError).toHaveBeenCalled();
      expect(onChunk).not.toHaveBeenCalled();
      expect(onComplete).not.toHaveBeenCalled();
    });

    it('should have correct signature and call onError on connection refused', async () => {
      const onChunk = vi.fn();
      const onComplete = vi.fn();
      const onError = vi.fn();

      await handler.streamResponse('127.0.0.1', 65432, 'test-func', 'req-123', onChunk, onComplete, onError);

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('streamResponseFromPod', () => {
    it('should call onError when pod is unreachable', async () => {
      const onChunk = vi.fn();
      const onComplete = vi.fn();
      const onError = vi.fn();

      await handler.streamResponseFromPod('unreachable-pod', 9999, 'test-func', { key: 'value' }, onChunk, onComplete, onError);

      expect(onError).toHaveBeenCalled();
    });
  });
});