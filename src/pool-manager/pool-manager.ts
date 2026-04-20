import { logger } from '../observability/logger.js';
import type { FunctionDefinition, WarmPoolState, PodHealth } from '../types/index.js';
import type { K8sClient } from '../k8s/k8s-client.js';
import { PodLifecycle } from './pod-lifecycle.js';
import { HealthMonitor } from './health-monitor.js';
import { ScalingController } from './scaling-controller.js';

export interface PoolManagerConfig {
  defaultMinSize: number;
  defaultMaxSize: number;
  defaultTargetUtilization: number;
  healthCheckIntervalMs: number;
  scaleUpThreshold: number;
  scaleDownThreshold: number;
  scalingCooldownSeconds: number;
}

interface Lock {
  locked: boolean;
  waiters: Array<() => void>;
}

export class PoolManager {
  private poolStates: Map<string, WarmPoolState> = new Map();
  private podLifecycle: PodLifecycle;
  private healthMonitor: HealthMonitor;
  private scalingController: ScalingController;
  private locks: Map<string, Lock> = new Map();

  constructor(config: PoolManagerConfig, k8sClient: K8sClient) {
    this.podLifecycle = new PodLifecycle(k8sClient);

    this.healthMonitor = new HealthMonitor(k8sClient, {
      checkIntervalMs: config.healthCheckIntervalMs,
    });

    this.scalingController = new ScalingController(k8sClient, {
      scaleUpThreshold: config.scaleUpThreshold,
      scaleDownThreshold: config.scaleDownThreshold,
      cooldownSeconds: config.scalingCooldownSeconds,
    });

    this.healthMonitor.onHealthCheck((results) => {
      this.handleHealthCheckResults(results);
    });
  }

  private async withLock<T>(functionName: string, fn: () => Promise<T>): Promise<T> {
    let lock = this.locks.get(functionName);
    if (!lock) {
      lock = { locked: false, waiters: [] };
      this.locks.set(functionName, lock);
    }

    if (lock.locked) {
      await new Promise<void>((resolve) => {
        lock!.waiters.push(resolve);
      });
    }

    lock.locked = true;
    try {
      return await fn();
    } finally {
      lock.locked = false;
      const next = lock.waiters.shift();
      if (next) {
        next();
      }
    }
  }

  async initialize(): Promise<void> {
    logger.info('Initializing pool manager');
    this.healthMonitor.start();
  }

  async createPool(functionDef: FunctionDefinition): Promise<void> {
    if (this.poolStates.has(functionDef.name)) {
      await this.unregisterFunction(functionDef.name);
    }

    const podStates: PodHealth[] = [];

    this.scalingController.registerFunction(functionDef);

    for (let i = 0; i < functionDef.pool.min_size; i++) {
      const podId = `${functionDef.name}-pod-${crypto.randomUUID().substring(0, 8)}`;

      try {
        const podHealth = await this.podLifecycle.initializePod(functionDef, podId);
        podStates.push(podHealth);
      } catch (error) {
        logger.error(
          {
            pod: podId,
            function: functionDef.name,
            error: error instanceof Error ? error.message : error,
          },
          'Failed to create pod',
        );
      }
    }

    const availablePods = podStates.filter((p) => p.state === 'warm' && p.healthy).length;
    const poolState: WarmPoolState = {
      function: functionDef.name,
      total_pods: podStates.length,
      available_pods: availablePods,
      active_pods: 0,
      cooling_pods: 0,
      utilization: 0,
      pod_states: podStates,
    };

    this.poolStates.set(functionDef.name, poolState);
    this.healthMonitor.registerPool(poolState);
    logger.info(
      { function: functionDef.name, min_size: functionDef.pool.min_size, actual: podStates.length },
      'Created warm pool',
    );
  }

  async unregisterFunction(functionName: string): Promise<void> {
    const poolState = this.poolStates.get(functionName);
    if (!poolState) {
      this.scalingController.unregisterFunction(functionName);
      this.healthMonitor.unregisterPool(functionName);
      return;
    }

    for (const pod of poolState.pod_states) {
      try {
        await this.podLifecycle.gracefulShutdown(pod.pod_id, pod);
      } catch {
        // Ignore errors during cleanup
      }
    }

    this.poolStates.delete(functionName);
    this.scalingController.unregisterFunction(functionName);
    this.healthMonitor.unregisterPool(functionName);
    this.locks.delete(functionName);
    logger.info({ function: functionName }, 'Warm pool removed');
  }

  async selectPod(functionName: string): Promise<string> {
    return this.withLock(functionName, async () => {
      const poolState = this.poolStates.get(functionName);
      if (!poolState) {
        throw new Error(`No pool found for function: ${functionName}`);
      }

      const availablePods = poolState.pod_states.filter((p) =>
        this.podLifecycle.isPodReadyForInvocation(p),
      );

      if (availablePods.length === 0) {
        const decision = this.scalingController.makeScalingDecision(poolState);
        if (decision.action === 'scale_up') {
          const podsToCreate = Math.min(decision.targetSize - poolState.total_pods, 3);
          for (let i = 0; i < podsToCreate; i++) {
            const newPod = await this.scalingController.scaleUp(poolState);
            if (newPod) {
              poolState.pod_states.push(newPod);
            }
          }
          poolState.total_pods = poolState.pod_states.length;
          poolState.available_pods = poolState.pod_states.filter((p) =>
            this.podLifecycle.isPodReadyForInvocation(p),
          ).length;
        }

        const newAvailablePods = poolState.pod_states.filter((p) =>
          this.podLifecycle.isPodReadyForInvocation(p),
        );

        if (newAvailablePods.length === 0) {
          throw new Error(`No available pods for function: ${functionName} (scaling in progress)`);
        }

        const selectedPod = newAvailablePods[0];
        this.podLifecycle.transitionToActive(selectedPod);
        poolState.active_pods += 1;
        poolState.available_pods -= 1;
        poolState.utilization =
          poolState.total_pods > 0 ? poolState.active_pods / poolState.total_pods : 0;

        return selectedPod.pod_id;
      }

      const selectedPod = availablePods[0];
      this.podLifecycle.transitionToActive(selectedPod);
      poolState.active_pods += 1;
      poolState.available_pods -= 1;
      poolState.utilization =
        poolState.total_pods > 0 ? poolState.active_pods / poolState.total_pods : 0;

      logger.debug(
        { function: functionName, pod_id: selectedPod.pod_id },
        'Selected pod for invocation',
      );

      return selectedPod.pod_id;
    });
  }

  async releasePod(functionName: string, podId: string, latencyMs: number): Promise<void> {
    return this.withLock(functionName, async () => {
      const poolState = this.poolStates.get(functionName);
      if (!poolState) return;

      const pod = poolState.pod_states.find((p) => p.pod_id === podId);
      if (!pod) return;

      const wasActive = pod.state === 'active';
      this.podLifecycle.releaseInvocation(pod, latencyMs);

      if (wasActive) {
        poolState.active_pods = Math.max(0, poolState.active_pods - 1);
      }

      if (pod.state === 'warm') {
        poolState.available_pods += 1;
        poolState.cooling_pods = Math.max(0, poolState.cooling_pods - 1);
      } else if (pod.state === 'cooling') {
        poolState.cooling_pods += 1;
      }

      poolState.utilization =
        poolState.total_pods > 0 ? poolState.active_pods / poolState.total_pods : 0;

      const decision = this.scalingController.makeScalingDecision(poolState);
      if (decision.action === 'scale_down') {
        const podsToRemove = Math.min(poolState.total_pods - decision.targetSize, 3);
        for (let i = 0; i < podsToRemove; i++) {
          const removedPodId = await this.scalingController.scaleDown(poolState);
          if (removedPodId) {
            const idx = poolState.pod_states.findIndex((p) => p.pod_id === removedPodId);
            if (idx !== -1) {
              const removedPod = poolState.pod_states[idx];
              poolState.pod_states.splice(idx, 1);
              poolState.total_pods -= 1;
              if (removedPod.state === 'warm') {
                poolState.available_pods = Math.max(0, poolState.available_pods - 1);
              }
            }
          }
        }
      }
    });
  }

  getPoolState(functionName: string): WarmPoolState | undefined {
    return this.poolStates.get(functionName);
  }

  async scalePool(functionName: string, minSize: number, maxSize: number): Promise<void> {
    const poolState = this.poolStates.get(functionName);
    if (!poolState) {
      throw new Error(`No pool found for function: ${functionName}`);
    }

    this.scalingController.updatePoolLimits(functionName, minSize, maxSize);

    while (poolState.total_pods < minSize) {
      const newPod = await this.scalingController.scaleUp(poolState);
      if (newPod) {
        poolState.pod_states.push(newPod);
      } else {
        break;
      }
    }
    poolState.total_pods = poolState.pod_states.length;
    poolState.available_pods = poolState.pod_states.filter((p) =>
      this.podLifecycle.isPodReadyForInvocation(p),
    ).length;
  }

  getAllPoolStates(): WarmPoolState[] {
    return Array.from(this.poolStates.values());
  }

  getPoolUtilization(): number {
    const states = this.getAllPoolStates();
    if (states.length === 0) return 0;
    const totalUtil = states.reduce((sum, s) => sum + s.utilization, 0);
    return totalUtil / states.length;
  }

  async healthCheck(): Promise<void> {
    for (const poolState of this.poolStates.values()) {
      await this.healthMonitor.checkPool(poolState);

      const terminatedPods = poolState.pod_states.filter((p) => p.state === 'terminated');
      for (const pod of terminatedPods) {
        try {
          await this.podLifecycle.terminatePod(pod.pod_id, false);
        } catch {
          // Ignore cleanup errors
        }
      }

      poolState.pod_states = poolState.pod_states.filter((p) => p.state !== 'terminated');
      poolState.total_pods = poolState.pod_states.length;
      poolState.available_pods = poolState.pod_states.filter(
        (p) => p.state === 'warm' && p.healthy,
      ).length;
    }
  }

  private handleHealthCheckResults(results: Map<string, { healthy: boolean }>): void {
    for (const [podId, result] of results) {
      for (const poolState of this.poolStates.values()) {
        const pod = poolState.pod_states.find((p) => p.pod_id === podId);
        if (pod) {
          pod.healthy = result.healthy;
          pod.last_health_check = new Date();

          if (!result.healthy) {
            logger.warn({ pod: podId, function: poolState.function }, 'Pod health check failed');
          }
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.healthMonitor.stop();
    this.scalingController.stop();

    for (const poolState of this.poolStates.values()) {
      for (const pod of poolState.pod_states) {
        try {
          await this.podLifecycle.gracefulShutdown(pod.pod_id, pod);
        } catch {
          // Ignore errors during cleanup
        }
      }
    }

    this.poolStates.clear();
    this.locks.clear();
    logger.info('Pool manager stopped');
  }
}
