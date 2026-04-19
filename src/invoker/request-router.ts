import { logger } from '../observability/logger.js';
import type { FunctionDefinition, InvocationRequest } from '../types/index.js';

export type SelectionStrategy = 'round-robin' | 'least-loaded' | 'latency-based' | 'sticky';

export interface RouteResult {
  podId: string;
  strategy: SelectionStrategy;
  attempt: number;
}

export interface RequestRouteConfig {
  strategy: SelectionStrategy;
  stickySessionTTLMs: number;
  maxRetries: number;
}

export class RequestRouter {
  private config: RequestRouteConfig;
  private selectionCounters: Map<string, number> = new Map();
  private stickySessions: Map<string, { podId: string; expiresAt: number }> = new Map();
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(config: Partial<RequestRouteConfig> = {}) {
    this.config = {
      strategy: config.strategy ?? 'round-robin',
      stickySessionTTLMs: config.stickySessionTTLMs ?? 300000,
      maxRetries: config.maxRetries ?? 3,
    };
  }

  start(): void {
    if (this.cleanupInterval) {
      return;
    }

    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, 60000);
    this.cleanupInterval.unref();

    logger.debug('Request router started');
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }

    this.stickySessions.clear();
    this.selectionCounters.clear();

    logger.info('Request router stopped');
  }

  selectPod(
    functionName: string,
    availablePods: Array<{ pod_id: string; active_invocations: number; recent_latency_ms: number }>,
    requestId?: string,
  ): RouteResult {
    if (availablePods.length === 0) {
      throw new Error('No available pods');
    }

    if (this.config.strategy === 'sticky' && requestId) {
      const sticky = this.stickySessions.get(requestId);
      if (sticky && sticky.expiresAt > Date.now()) {
        const podExists = availablePods.some((p) => p.pod_id === sticky.podId);
        if (podExists) {
          logger.debug({ requestId, podId: sticky.podId }, 'Using sticky session');
          return { podId: sticky.podId, strategy: 'sticky', attempt: 1 };
        }
      }
    }

    let selectedPod: string;

    switch (this.config.strategy) {
      case 'least-loaded':
        selectedPod = this.selectLeastLoaded(availablePods);
        break;
      case 'latency-based':
        selectedPod = this.selectLatencyBased(availablePods);
        break;
      case 'round-robin':
      default:
        selectedPod = this.selectRoundRobin(functionName, availablePods);
        break;
    }

    if (this.config.strategy === 'sticky' && requestId) {
      this.stickySessions.set(requestId, {
        podId: selectedPod,
        expiresAt: Date.now() + this.config.stickySessionTTLMs,
      });
    }

    return { podId: selectedPod, strategy: this.config.strategy, attempt: 1 };
  }

  private selectRoundRobin(
    functionName: string,
    pods: Array<{ pod_id: string; active_invocations: number }>,
  ): string {
    let currentCount = this.selectionCounters.get(functionName) ?? 0;

    if (currentCount > 1000000) {
      currentCount = currentCount % pods.length;
    }

    const selectedIndex = currentCount % pods.length;
    this.selectionCounters.set(functionName, currentCount + 1);

    return pods[selectedIndex].pod_id;
  }

  private selectLeastLoaded(
    pods: Array<{ pod_id: string; active_invocations: number }>,
  ): string {
    let minInvocations = Infinity;
    const candidates: string[] = [];

    for (const pod of pods) {
      if (pod.active_invocations < minInvocations) {
        minInvocations = pod.active_invocations;
        candidates.length = 0;
        candidates.push(pod.pod_id);
      } else if (pod.active_invocations === minInvocations) {
        candidates.push(pod.pod_id);
      }
    }

    return candidates[Math.floor(Math.random() * candidates.length)] ?? pods[0].pod_id;
  }

  private selectLatencyBased(
    pods: Array<{ pod_id: string; recent_latency_ms: number }>,
  ): string {
    let minLatency = Infinity;
    const candidates: string[] = [];

    for (const pod of pods) {
      if (pod.recent_latency_ms < minLatency) {
        minLatency = pod.recent_latency_ms;
        candidates.length = 0;
        candidates.push(pod.pod_id);
      } else if (pod.recent_latency_ms === minLatency) {
        candidates.push(pod.pod_id);
      }
    }

    return candidates[Math.floor(Math.random() * candidates.length)] ?? pods[0].pod_id;
  }

  selectFallbackPod(
    _functionName: string,
    availablePods: Array<{ pod_id: string; active_invocations: number; recent_latency_ms: number }>,
    excludePodId?: string,
  ): RouteResult {
    const filteredPods = excludePodId
      ? availablePods.filter((p) => p.pod_id !== excludePodId)
      : availablePods;

    if (filteredPods.length === 0) {
      throw new Error('No available fallback pods');
    }

    return {
      podId: this.selectLeastLoaded(filteredPods),
      strategy: 'least-loaded',
      attempt: 2,
    };
  }

  getStickySession(requestId: string): string | undefined {
    const sticky = this.stickySessions.get(requestId);
    if (sticky && sticky.expiresAt > Date.now()) {
      return sticky.podId;
    }
    this.stickySessions.delete(requestId);
    return undefined;
  }

  clearStickySession(requestId: string): void {
    this.stickySessions.delete(requestId);
  }

  cleanupExpiredSessions(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [requestId, sticky] of this.stickySessions.entries()) {
      if (sticky.expiresAt <= now) {
        this.stickySessions.delete(requestId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug({ cleaned }, 'Cleaned up expired sticky sessions');
    }

    return cleaned;
  }

  getSelectionStrategy(): SelectionStrategy {
    return this.config.strategy;
  }

  setSelectionStrategy(strategy: SelectionStrategy): void {
    logger.info({ strategy }, 'Updated selection strategy');
    this.config.strategy = strategy;
  }

  buildRequestOptions(
    functionDef: FunctionDefinition,
    podId: string,
    request: InvocationRequest,
  ): {
    hostname: string;
    port: number;
    path: string;
    method: string;
    headers: Record<string, string>;
  } {
    return {
      hostname: 'localhost',
      port: functionDef.container.port,
      path: `/invoke/${functionDef.name}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': request.request_id,
        'X-Pod-ID': podId,
        'X-Function-Name': functionDef.name,
      },
    };
  }
}
