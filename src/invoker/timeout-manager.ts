import { logger } from '../observability/logger.js';

export interface TimeoutConfig {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  cleanupIntervalMs: number;
}

export interface ActiveInvocation {
  requestId: string;
  functionName: string;
  podId: string;
  startedAt: number;
  timeoutMs: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
  onTimeout?: () => void;
}

export interface TimeoutStats {
  activeInvocations: number;
  totalTimeouts: number;
  avgWaitTime: number;
}

export class TimeoutManager {
  private config: TimeoutConfig;
  private activeInvocations: Map<string, ActiveInvocation> = new Map();
  private cleanupInterval?: ReturnType<typeof setInterval>;
  private timeoutCount: number = 0;
  private completedCount: number = 0;
  private totalWaitTime: number = 0;

  constructor(config: Partial<TimeoutConfig> = {}) {
    this.config = {
      defaultTimeoutMs: config.defaultTimeoutMs ?? 30000,
      maxTimeoutMs: config.maxTimeoutMs ?? 300000,
      cleanupIntervalMs: config.cleanupIntervalMs ?? 10000,
    };
  }

  start(): void {
    if (this.cleanupInterval) {
      return;
    }

    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleInvocations();
    }, this.config.cleanupIntervalMs);
    this.cleanupInterval.unref();

    logger.info('Timeout manager started');
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }

    for (const invocation of this.activeInvocations.values()) {
      clearTimeout(invocation.timeoutHandle);
    }
    this.activeInvocations.clear();

    logger.info('Timeout manager stopped');
  }

  startInvocation(
    requestId: string,
    functionName: string,
    podId: string,
    timeoutMs?: number,
    onTimeout?: () => void,
  ): number {
    const effectiveTimeout = Math.min(
      timeoutMs ?? this.config.defaultTimeoutMs,
      this.config.maxTimeoutMs,
    );

    const timeoutHandle = setTimeout(() => {
      this.handleTimeout(requestId, onTimeout);
    }, effectiveTimeout);
    timeoutHandle.unref();

    const invocation: ActiveInvocation = {
      requestId,
      functionName,
      podId,
      startedAt: Date.now(),
      timeoutMs: effectiveTimeout,
      timeoutHandle,
      onTimeout,
    };

    this.activeInvocations.set(requestId, invocation);

    logger.debug(
      { requestId, functionName, podId, timeoutMs: effectiveTimeout },
      'Started tracking invocation',
    );

    return effectiveTimeout;
  }

  endInvocation(requestId: string): void {
    const invocation = this.activeInvocations.get(requestId);
    if (!invocation) {
      return;
    }

    clearTimeout(invocation.timeoutHandle);
    this.totalWaitTime += Date.now() - invocation.startedAt;
    this.completedCount++;
    this.activeInvocations.delete(requestId);

    logger.debug(
      { requestId, durationMs: Date.now() - invocation.startedAt },
      'Ended invocation tracking',
    );
  }

  private handleTimeout(requestId: string, onTimeout?: () => void): void {
    const invocation = this.activeInvocations.get(requestId);
    if (!invocation) {
      return;
    }

    this.timeoutCount++;
    this.activeInvocations.delete(requestId);

    logger.warn(
      { requestId, functionName: invocation.functionName, podId: invocation.podId },
      'Invocation timed out',
    );

    if (onTimeout) {
      try {
        onTimeout();
      } catch (error) {
        logger.error(
          { requestId, error: error instanceof Error ? error.message : error },
          'Timeout callback failed',
        );
      }
    }
  }

  private cleanupStaleInvocations(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [requestId, invocation] of this.activeInvocations.entries()) {
      const elapsed = now - invocation.startedAt;
      if (elapsed > invocation.timeoutMs * 2) {
        clearTimeout(invocation.timeoutHandle);
        this.activeInvocations.delete(requestId);
        cleaned++;

        logger.warn(
          { requestId, functionName: invocation.functionName },
          'Cleaned up stale invocation',
        );
      }
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up stale invocations');
    }
  }

  getActiveInvocation(requestId: string): ActiveInvocation | undefined {
    return this.activeInvocations.get(requestId);
  }

  isInvocationActive(requestId: string): boolean {
    return this.activeInvocations.has(requestId);
  }

  getStats(): TimeoutStats {
    const activeCount = this.activeInvocations.size;
    const avgWaitTime = this.completedCount > 0 ? this.totalWaitTime / this.completedCount : 0;

    return {
      activeInvocations: activeCount,
      totalTimeouts: this.timeoutCount,
      avgWaitTime,
    };
  }

  extendTimeout(requestId: string, additionalMs: number): boolean {
    const invocation = this.activeInvocations.get(requestId);
    if (!invocation) {
      return false;
    }

    const elapsed = Date.now() - invocation.startedAt;
    const remaining = Math.max(0, invocation.startedAt + invocation.timeoutMs - Date.now());
    const newAbsoluteTimeout = remaining + additionalMs;
    const newTimeout = Math.min(newAbsoluteTimeout, this.config.maxTimeoutMs - elapsed);

    if (newTimeout <= 0) {
      return false;
    }

    clearTimeout(invocation.timeoutHandle);
    invocation.timeoutHandle = setTimeout(() => {
      this.handleTimeout(requestId, invocation.onTimeout);
    }, newTimeout);
    invocation.timeoutMs = elapsed + newTimeout;

    logger.debug(
      { requestId, newTimeoutMs: newTimeout, remainingMs: remaining },
      'Extended invocation timeout',
    );

    return true;
  }

  cancelTimeout(requestId: string): boolean {
    const invocation = this.activeInvocations.get(requestId);
    if (!invocation) {
      return false;
    }

    clearTimeout(invocation.timeoutHandle);
    this.activeInvocations.delete(requestId);

    logger.debug({ requestId }, 'Cancelled invocation timeout');

    return true;
  }

  clearInvocationTimeout(requestId: string): void {
    const invocation = this.activeInvocations.get(requestId);
    if (invocation) {
      clearTimeout(invocation.timeoutHandle);
      this.activeInvocations.delete(requestId);
    }
  }
}
