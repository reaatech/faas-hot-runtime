import { logger } from '../observability/logger.js';
import type { FunctionDefinition, PodHealth } from '../types/index.js';
import type { K8sClient } from '../k8s/k8s-client.js';

export interface PodLifecycleConfig {
  gracefulShutdownTimeoutSeconds: number;
  cooldownSeconds: number;
}

export class PodLifecycle {
  private k8sClient: K8sClient;
  private config: PodLifecycleConfig;

  constructor(k8sClient: K8sClient, config: Partial<PodLifecycleConfig> = {}) {
    this.k8sClient = k8sClient;
    this.config = {
      gracefulShutdownTimeoutSeconds: config.gracefulShutdownTimeoutSeconds ?? 30,
      cooldownSeconds: config.cooldownSeconds ?? 60,
    };
  }

  async initializePod(functionDef: FunctionDefinition, podId: string): Promise<PodHealth> {
    logger.info(
      { pod: podId, function: functionDef.name, image: functionDef.container.image },
      'Initializing pod',
    );

    try {
      await this.k8sClient.createPod({
        name: podId,
        image: functionDef.container.image,
        port: functionDef.container.port,
        cpu: functionDef.container.resources.cpu,
        memory: functionDef.container.resources.memory,
        gpu: functionDef.container.resources.gpu,
      });

      const podHealth: PodHealth = {
        pod_id: podId,
        state: 'warm',
        active_invocations: 0,
        recent_latency_ms: 0,
        healthy: true,
        last_health_check: new Date(),
        created_at: new Date(),
      };

      logger.info({ pod: podId, function: functionDef.name }, 'Pod initialized successfully');
      return podHealth;
    } catch (error) {
      logger.error(
        {
          pod: podId,
          function: functionDef.name,
          error: error instanceof Error ? error.message : error,
        },
        'Failed to initialize pod',
      );
      throw error;
    }
  }

  async terminatePod(podId: string, graceful: boolean = true): Promise<void> {
    logger.info({ pod: podId, graceful }, 'Terminating pod');

    try {
      await this.k8sClient.deletePod(podId, graceful);
      logger.info({ pod: podId }, 'Pod terminated successfully');
    } catch (error) {
      logger.error(
        { pod: podId, error: error instanceof Error ? error.message : error },
        'Failed to terminate pod',
      );
      throw error;
    }
  }

  async checkPodHealth(podId: string): Promise<{ healthy: boolean; phase?: string }> {
    try {
      const status = await this.k8sClient.getPodStatus(podId);
      if (!status) {
        return { healthy: false };
      }
      return {
        healthy: status.ready && status.phase === 'Running',
        phase: status.phase,
      };
    } catch (error) {
      logger.error(
        { pod: podId, error: error instanceof Error ? error.message : error },
        'Failed to check pod health',
      );
      return { healthy: false };
    }
  }

  transitionToWarm(pod: PodHealth): void {
    pod.state = 'warm';
    pod.last_health_check = new Date();
    logger.debug({ pod: pod.pod_id }, 'Pod transitioned to warm state');
  }

  transitionToActive(pod: PodHealth): void {
    pod.state = 'active';
    pod.active_invocations += 1;
    logger.debug(
      { pod: pod.pod_id, active_invocations: pod.active_invocations },
      'Pod transitioned to active state',
    );
  }

  transitionToCooling(pod: PodHealth): void {
    pod.state = 'cooling';
    logger.debug({ pod: pod.pod_id }, 'Pod transitioned to cooling state');
  }

  transitionToTerminated(pod: PodHealth): void {
    pod.state = 'terminated';
    logger.debug({ pod: pod.pod_id }, 'Pod transitioned to terminated state');
  }

  transitionToUnhealthy(pod: PodHealth): void {
    pod.state = 'unhealthy';
    pod.healthy = false;
    logger.warn({ pod: pod.pod_id }, 'Pod transitioned to unhealthy state');
  }

  releaseInvocation(pod: PodHealth, latencyMs: number): void {
    pod.active_invocations = Math.max(0, pod.active_invocations - 1);
    pod.recent_latency_ms = latencyMs;
    pod.last_health_check = new Date();

    if (pod.active_invocations === 0) {
      this.transitionToWarm(pod);
    }
  }

  async gracefulShutdown(podId: string, pod?: PodHealth): Promise<void> {
    logger.info({ pod: podId }, 'Starting graceful shutdown');

    const health = await this.checkPodHealth(podId);
    if (health.healthy && pod) {
      this.transitionToCooling(pod);
    }

    await this.terminatePod(podId, true);
  }

  async forceShutdown(podId: string): Promise<void> {
    logger.warn({ pod: podId }, 'Force shutting down pod');
    await this.terminatePod(podId, false);
  }

  isPodReadyForInvocation(pod: PodHealth): boolean {
    return pod.state === 'warm' && pod.healthy && pod.active_invocations === 0;
  }

  getCooldownPeriodMs(): number {
    return this.config.cooldownSeconds * 1000;
  }

  getGracefulShutdownTimeoutMs(): number {
    return this.config.gracefulShutdownTimeoutSeconds * 1000;
  }
}
