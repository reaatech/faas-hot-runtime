import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TimeoutManager } from '../../../src/invoker/timeout-manager.js';
import type { TimeoutConfig, ActiveInvocation } from '../../../src/invoker/timeout-manager.js';

vi.mock('../../../src/observability/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('TimeoutManager', () => {
  let manager: TimeoutManager;

  beforeEach(() => {
    manager = new TimeoutManager({
      defaultTimeoutMs: 30000,
      maxTimeoutMs: 300000,
      cleanupIntervalMs: 1000,
    });
  });

  afterEach(() => {
    manager.stop();
  });

  describe('constructor', () => {
    it('should use default config', () => {
      const defaultManager = new TimeoutManager();
      expect((defaultManager as unknown as { config: TimeoutConfig }).config.defaultTimeoutMs).toBe(30000);
      expect((defaultManager as unknown as { config: TimeoutConfig }).config.maxTimeoutMs).toBe(300000);
    });

    it('should accept custom config', () => {
      const customManager = new TimeoutManager({
        defaultTimeoutMs: 60000,
        maxTimeoutMs: 600000,
        cleanupIntervalMs: 500,
      });
      expect((customManager as unknown as { config: TimeoutConfig }).config.defaultTimeoutMs).toBe(60000);
    });
  });

  describe('start/stop', () => {
    it('should start without error', () => {
      manager.start();
      expect((manager as unknown as { cleanupInterval: ReturnType<typeof setInterval> | undefined }).cleanupInterval).toBeDefined();
    });

    it('should not start twice', () => {
      manager.start();
      const interval1 = (manager as unknown as { cleanupInterval: ReturnType<typeof setInterval> | undefined }).cleanupInterval;
      manager.start();
      expect((manager as unknown as { cleanupInterval: ReturnType<typeof setInterval> | undefined }).cleanupInterval).toBe(interval1);
    });

    it('should stop and cleanup', () => {
      manager.start();
      manager.stop();
      expect((manager as unknown as { cleanupInterval: ReturnType<typeof setInterval> | undefined }).cleanupInterval).toBeUndefined();
      expect((manager as unknown as { activeInvocations: Map<string, ActiveInvocation> }).activeInvocations.size).toBe(0);
    });
  });

  describe('startInvocation', () => {
    it('should start tracking invocation', () => {
      manager.start();

      const timeout = manager.startInvocation('req-1', 'func-1', 'pod-1', 5000);

      expect(timeout).toBe(5000);
      expect(manager.isInvocationActive('req-1')).toBe(true);
    });

    it('should use default timeout when not specified', () => {
      manager.start();

      const timeout = manager.startInvocation('req-1', 'func-1', 'pod-1');

      expect(timeout).toBe(30000);
    });

    it('should cap timeout at maxTimeoutMs', () => {
      manager.start();

      const timeout = manager.startInvocation('req-1', 'func-1', 'pod-1', 600000);

      expect(timeout).toBe(300000);
    });

    it('should call onTimeout callback when specified', async () => {
      manager.start();
      const callback = vi.fn();

      manager.startInvocation('req-1', 'func-1', 'pod-1', 10, callback);

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(callback).toHaveBeenCalled();
    });
  });

  describe('endInvocation', () => {
    it('should stop tracking invocation', () => {
      manager.start();
      manager.startInvocation('req-1', 'func-1', 'pod-1', 5000);

      manager.endInvocation('req-1');

      expect(manager.isInvocationActive('req-1')).toBe(false);
    });

    it('should handle unknown request id', () => {
      manager.start();
      expect(() => manager.endInvocation('unknown')).not.toThrow();
    });
  });

  describe('getActiveInvocation', () => {
    it('should return undefined for unknown id', () => {
      manager.start();
      expect(manager.getActiveInvocation('unknown')).toBeUndefined();
    });

    it('should return invocation details', () => {
      manager.start();
      manager.startInvocation('req-1', 'func-1', 'pod-1', 5000);

      const invocation = manager.getActiveInvocation('req-1');

      expect(invocation?.requestId).toBe('req-1');
      expect(invocation?.functionName).toBe('func-1');
      expect(invocation?.podId).toBe('pod-1');
    });
  });

  describe('getStats', () => {
    it('should return stats', () => {
      manager.start();
      manager.startInvocation('req-1', 'func-1', 'pod-1', 5000);

      const stats = manager.getStats();

      expect(stats.activeInvocations).toBe(1);
      expect(stats.totalTimeouts).toBe(0);
    });
  });

  describe('extendTimeout', () => {
    it('should return false for unknown invocation', () => {
      manager.start();
      expect(manager.extendTimeout('unknown', 5000)).toBe(false);
    });

    it('should extend timeout', () => {
      manager.start();
      manager.startInvocation('req-1', 'func-1', 'pod-1', 5000);

      const result = manager.extendTimeout('req-1', 30000);

      expect(result).toBe(true);
      const invocation = manager.getActiveInvocation('req-1');
      expect(invocation?.timeoutMs).toBe(35000);
    });

    it('should cap extended timeout at max', () => {
      manager.start();
      manager.startInvocation('req-1', 'func-1', 'pod-1', 5000);

      manager.extendTimeout('req-1', 600000);

      const invocation = manager.getActiveInvocation('req-1');
      expect(invocation?.timeoutMs).toBe(300000);
    });
  });

  describe('cancelTimeout', () => {
    it('should return false for unknown invocation', () => {
      manager.start();
      expect(manager.cancelTimeout('unknown')).toBe(false);
    });

    it('should cancel timeout and remove invocation', () => {
      manager.start();
      manager.startInvocation('req-1', 'func-1', 'pod-1', 5000);

      const result = manager.cancelTimeout('req-1');

      expect(result).toBe(true);
      expect(manager.isInvocationActive('req-1')).toBe(false);
    });
  });

  describe('handleTimeout', () => {
    it('should handle timeout and call callback', async () => {
      manager.start();
      const callback = vi.fn();

      manager.startInvocation('req-1', 'func-1', 'pod-1', 10, callback);

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(manager.isInvocationActive('req-1')).toBe(false);
    });
  });
});