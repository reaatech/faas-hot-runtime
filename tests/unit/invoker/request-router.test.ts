import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RequestRouter } from '../../../src/invoker/request-router.js';
import type { RequestRouteConfig } from '../../../src/invoker/request-router.js';
import type { FunctionDefinition, InvocationRequest } from '../../../src/types/index.js';

vi.mock('../../../src/observability/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('RequestRouter', () => {
  let router: RequestRouter;

  const mockPods = [
    { pod_id: 'pod-1', active_invocations: 2, recent_latency_ms: 50 },
    { pod_id: 'pod-2', active_invocations: 5, recent_latency_ms: 30 },
    { pod_id: 'pod-3', active_invocations: 1, recent_latency_ms: 100 },
  ];

  beforeEach(() => {
    router = new RequestRouter({
      strategy: 'round-robin',
      stickySessionTTLMs: 300000,
      maxRetries: 3,
    });
  });

  describe('constructor', () => {
    it('should use default config', () => {
      const defaultRouter = new RequestRouter();
      expect((defaultRouter as unknown as { config: RequestRouteConfig }).config.strategy).toBe('round-robin');
      expect((defaultRouter as unknown as { config: RequestRouteConfig }).config.stickySessionTTLMs).toBe(300000);
    });

    it('should accept custom config', () => {
      const customRouter = new RequestRouter({
        strategy: 'least-loaded',
        stickySessionTTLMs: 600000,
        maxRetries: 5,
      });
      expect((customRouter as unknown as { config: RequestRouteConfig }).config.strategy).toBe('least-loaded');
      expect((customRouter as unknown as { config: RequestRouteConfig }).config.stickySessionTTLMs).toBe(600000);
    });
  });

  describe('selectPod', () => {
    it('should throw when no pods available', () => {
      expect(() => router.selectPod('func', [])).toThrow('No available pods');
    });

    it('should select pod with round-robin', () => {
      const result1 = router.selectPod('func', mockPods);
      const result2 = router.selectPod('func', mockPods);
      const result3 = router.selectPod('func', mockPods);

      expect(result1.podId).toBe('pod-1');
      expect(result2.podId).toBe('pod-2');
      expect(result3.podId).toBe('pod-3');
    });

    it('should select pod with least-loaded', () => {
      const leastLoadedRouter = new RequestRouter({ strategy: 'least-loaded' });
      const result = leastLoadedRouter.selectPod('func', mockPods);

      expect(result.podId).toBe('pod-3');
      expect(result.strategy).toBe('least-loaded');
    });

    it('should select pod with latency-based', () => {
      const latencyRouter = new RequestRouter({ strategy: 'latency-based' });
      const result = latencyRouter.selectPod('func', mockPods);

      expect(result.podId).toBe('pod-2');
      expect(result.strategy).toBe('latency-based');
    });

    it('should use sticky session when available', () => {
      const stickyRouter = new RequestRouter({ strategy: 'sticky' });
      stickyRouter.selectPod('func', mockPods, 'req-1');

      const result = stickyRouter.selectPod('func', mockPods, 'req-1');

      expect(result.podId).toBe('pod-1');
      expect(result.strategy).toBe('sticky');
    });

    it('should use sticky session on subsequent calls', () => {
      const stickyRouter = new RequestRouter({ strategy: 'sticky', stickySessionTTLMs: 60000 });
      const result1 = stickyRouter.selectPod('func', mockPods, 'req-1');
      const result2 = stickyRouter.selectPod('func', mockPods, 'req-1');

      expect(result1.podId).toBe(result2.podId);
      expect(result1.strategy).toBe('sticky');
      expect(result2.strategy).toBe('sticky');
    });
  });

  describe('selectFallbackPod', () => {
    it('should throw when no fallback pods', () => {
      expect(() => router.selectFallbackPod('func', [{ pod_id: 'pod-1', active_invocations: 1, recent_latency_ms: 50 }], 'pod-1'))
        .toThrow('No available fallback pods');
    });

    it('should select least loaded from available pods', () => {
      const result = router.selectFallbackPod('func', mockPods, 'pod-1');

      expect(result.podId).not.toBe('pod-1');
      expect(result.strategy).toBe('least-loaded');
    });

    it('should exclude specified pod', () => {
      const result = router.selectFallbackPod('func', mockPods, 'pod-1');

      expect(result.podId).not.toBe('pod-1');
    });
  });

  describe('getStickySession', () => {
    it('should return undefined for unknown session', () => {
      expect(router.getStickySession('unknown')).toBeUndefined();
    });

    it('should return pod id for valid session', () => {
      const stickyRouter = new RequestRouter({ strategy: 'sticky' });
      stickyRouter.selectPod('func', mockPods, 'req-1');

      expect(stickyRouter.getStickySession('req-1')).toBe('pod-1');
    });
  });

  describe('clearStickySession', () => {
    it('should clear session', () => {
      const stickyRouter = new RequestRouter({ strategy: 'sticky' });
      stickyRouter.selectPod('func', mockPods, 'req-1');
      stickyRouter.clearStickySession('req-1');

      expect(stickyRouter.getStickySession('req-1')).toBeUndefined();
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('should return 0 when no sessions', () => {
      expect(router.cleanupExpiredSessions()).toBe(0);
    });

    it('should clean up expired sessions', async () => {
      const stickyRouter = new RequestRouter({ strategy: 'sticky', stickySessionTTLMs: 1 });
      stickyRouter.selectPod('func', mockPods, 'req-1');

      await new Promise(resolve => setTimeout(resolve, 10));

      const cleaned = stickyRouter.cleanupExpiredSessions();
      expect(cleaned).toBe(1);
    });
  });

  describe('getSelectionStrategy', () => {
    it('should return current strategy', () => {
      expect(router.getSelectionStrategy()).toBe('round-robin');

      const leastLoadedRouter = new RequestRouter({ strategy: 'least-loaded' });
      expect(leastLoadedRouter.getSelectionStrategy()).toBe('least-loaded');
    });
  });

  describe('setSelectionStrategy', () => {
    it('should update strategy', () => {
      router.setSelectionStrategy('least-loaded');
      expect(router.getSelectionStrategy()).toBe('least-loaded');
    });
  });

  describe('buildRequestOptions', () => {
    it('should build request options', () => {
      const funcDef = { name: 'test-func', container: { port: 8080 } } as FunctionDefinition;
      const request = { request_id: 'req-1' } as InvocationRequest;
      const options = router.buildRequestOptions(funcDef, 'pod-1', request);

      expect(options.hostname).toBe('localhost');
      expect(options.port).toBe(8080);
      expect(options.path).toBe('/invoke/test-func');
      expect(options.method).toBe('POST');
      expect(options.headers['X-Request-ID']).toBe('req-1');
      expect(options.headers['X-Pod-ID']).toBe('pod-1');
    });
  });
});