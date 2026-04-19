import { logger } from '../observability/logger.js';
import type { PodHealth, WarmPoolState } from '../types/index.js';
import type { K8sClient } from '../k8s/k8s-client.js';

export interface HealthMonitorConfig {
  checkIntervalMs: number;
  unhealthyThreshold: number;
  latencyThresholdMs: number;
}

export interface HealthCheckResult {
  podId: string;
  healthy: boolean;
  phase?: string;
  latencyMs?: number;
  error?: string;
}

export class HealthMonitor {
  private k8sClient: K8sClient;
  private config: HealthMonitorConfig;
  private intervalHandle?: ReturnType<typeof setInterval>;
  private checkCallbacks: Array<(results: Map<string, HealthCheckResult>) => void> = [];

  constructor(k8sClient: K8sClient, config: Partial<HealthMonitorConfig> = {}) {
    this.k8sClient = k8sClient;
    this.config = {
      checkIntervalMs: config.checkIntervalMs ?? 10000,
      unhealthyThreshold: config.unhealthyThreshold ?? 3,
      latencyThresholdMs: config.latencyThresholdMs ?? 5000,
    };
  }

  start(callback?: (results: Map<string, HealthCheckResult>) => void): void {
    if (callback) {
      this.checkCallbacks.push(callback);
    }

    if (this.intervalHandle) {
      logger.warn('Health monitor already running');
      return;
    }

    logger.info({ intervalMs: this.config.checkIntervalMs }, 'Starting health monitor');

    this.intervalHandle = setInterval(() => {
      this.runHealthCheck().catch((error) => {
        logger.error({ error: error instanceof Error ? error.message : error }, 'Health check failed');
      });
    }, this.config.checkIntervalMs);
    this.intervalHandle.unref();
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
      logger.info('Health monitor stopped');
    }
  }

  onHealthCheck(callback: (results: Map<string, HealthCheckResult>) => void): void {
    this.checkCallbacks.push(callback);
  }

  private poolStates: WarmPoolState[] = [];

  registerPool(poolState: WarmPoolState): void {
    this.poolStates.push(poolState);
  }

  unregisterPool(functionName: string): void {
    this.poolStates = this.poolStates.filter((poolState) => poolState.function !== functionName);
    this.latencyHistory.forEach((_samples, podId) => {
      if (podId.startsWith(`${functionName}-pod-`)) {
        this.latencyHistory.delete(podId);
      }
    });
  }

  async runHealthCheck(): Promise<Map<string, HealthCheckResult>> {
    const allResults = new Map<string, HealthCheckResult>();

    for (const poolState of this.poolStates) {
      const results = await this.checkPool(poolState);
      for (const [podId, result] of results) {
        allResults.set(podId, result);
      }
    }

    for (const callback of this.checkCallbacks) {
      try {
        callback(allResults);
      } catch (error) {
        logger.error({ error: error instanceof Error ? error.message : error }, 'Health check callback failed');
      }
    }

    return allResults;
  }

  async checkPod(podId: string): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      const status = await this.k8sClient.getPodStatus(podId);
      const latencyMs = Date.now() - startTime;

      if (!status) {
        return {
          podId,
          healthy: false,
          error: 'Pod not found',
        };
      }

      const isHealthy = status.ready && status.phase === 'Running';
      const isLatencyOk = latencyMs < this.config.latencyThresholdMs;

      if (!isHealthy || !isLatencyOk) {
        logger.warn(
          {
            pod: podId,
            phase: status.phase,
            ready: status.ready,
            latencyMs,
            thresholdMs: this.config.latencyThresholdMs,
          },
          'Pod health check degraded',
        );
      }

      return {
        podId,
        healthy: isHealthy && isLatencyOk,
        phase: status.phase,
        latencyMs,
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      logger.error(
        { pod: podId, latencyMs, error: error instanceof Error ? error.message : error },
        'Pod health check failed',
      );

      return {
        podId,
        healthy: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latencyMs,
      };
    }
  }

  async checkPool(poolState: WarmPoolState): Promise<Map<string, HealthCheckResult>> {
    const results = new Map<string, HealthCheckResult>();

    const checkPromises = poolState.pod_states.map(async (pod) => {
      const result = await this.checkPod(pod.pod_id);
      results.set(pod.pod_id, result);

      if (result.latencyMs !== undefined) {
        this.recordLatency(pod.pod_id, result.latencyMs);
      }

      if (result.healthy) {
        pod.healthy = true;
        pod.last_health_check = new Date();
      } else {
        pod.healthy = false;
        if (result.phase) {
          logger.warn(
            { pod: pod.pod_id, function: poolState.function, phase: result.phase },
            'Pod health check failed',
          );
        }
      }
    });

    await Promise.allSettled(checkPromises);
    return results;
  }

  updatePodHealthFromResult(pod: PodHealth, result: HealthCheckResult): void {
    pod.last_health_check = new Date();

    if (result.healthy) {
      pod.healthy = true;
    } else {
      pod.healthy = false;
      if (result.phase === 'Failed' || result.phase === 'Unknown') {
        pod.state = 'terminated';
      }
    }

    if (result.latencyMs !== undefined) {
      pod.recent_latency_ms = result.latencyMs;
    }
  }

  shouldReplacePod(pod: PodHealth, consecutiveFailures: number): boolean {
    return !pod.healthy && consecutiveFailures >= this.config.unhealthyThreshold;
  }

  private latencyHistory: Map<string, number[]> = new Map();
  private static readonly MAX_LATENCY_SAMPLES = 100;

  recordLatency(podId: string, latencyMs: number): void {
    let samples = this.latencyHistory.get(podId);
    if (!samples) {
      samples = [];
      this.latencyHistory.set(podId, samples);
    }
    samples.push(latencyMs);
    if (samples.length > HealthMonitor.MAX_LATENCY_SAMPLES) {
      samples.shift();
    }
  }

  getLatencyStats(pod: PodHealth): { avg: number; p50: number; p95: number; p99: number } {
    const samples = this.latencyHistory.get(pod.pod_id);
    if (!samples || samples.length === 0) {
      return { avg: pod.recent_latency_ms, p50: pod.recent_latency_ms, p95: pod.recent_latency_ms, p99: pod.recent_latency_ms };
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.min(Math.floor(sorted.length * 0.99), sorted.length - 1)];
    return { avg, p50, p95, p99 };
  }

  getUnhealthyPods(poolState: WarmPoolState): PodHealth[] {
    return poolState.pod_states.filter((p) => !p.healthy);
  }

  getAverageLatency(poolState: WarmPoolState): number {
    const pods = poolState.pod_states.filter((p) => p.state !== 'terminated');
    if (pods.length === 0) return 0;

    const totalLatency = pods.reduce((sum, p) => sum + p.recent_latency_ms, 0);
    return totalLatency / pods.length;
  }
}
