import { logger } from '../observability/logger.js';
import type { FunctionDefinition, PodHealth, WarmPoolState } from '../types/index.js';
import type { K8sClient } from '../k8s/k8s-client.js';

export interface ScalingControllerConfig {
  scaleUpThreshold: number;
  scaleDownThreshold: number;
  cooldownSeconds: number;
  predictiveEnabled?: boolean;
}

export interface ScalingDecision {
  action: 'scale_up' | 'scale_down' | 'none';
  targetSize: number;
  reason: string;
  urgency: 'high' | 'medium' | 'low';
}

export interface ScalingMetrics {
  currentUtilization: number;
  avgLatencyMs: number;
  pendingRequests: number;
  availablePods: number;
  activePods: number;
}

export class ScalingController {
  private k8sClient: K8sClient;
  private config: ScalingControllerConfig;
  private lastScaleUp: Map<string, number> = new Map();
  private lastScaleDown: Map<string, number> = new Map();
  private functionDefinitions: Map<string, FunctionDefinition> = new Map();

  constructor(k8sClient: K8sClient, config: Partial<ScalingControllerConfig> = {}) {
    this.k8sClient = k8sClient;
    this.config = {
      scaleUpThreshold: config.scaleUpThreshold ?? 0.7,
      scaleDownThreshold: config.scaleDownThreshold ?? 0.3,
      cooldownSeconds: config.cooldownSeconds ?? 60,
      predictiveEnabled: config.predictiveEnabled ?? true,
    };
  }

  registerFunction(functionDef: FunctionDefinition): void {
    this.functionDefinitions.set(functionDef.name, functionDef);
  }

  unregisterFunction(functionName: string): void {
    this.functionDefinitions.delete(functionName);
    this.lastScaleUp.delete(functionName);
    this.lastScaleDown.delete(functionName);
  }

  getScalingMetrics(poolState: WarmPoolState): ScalingMetrics {
    const availablePods = poolState.pod_states.filter(
      (p) => p.state === 'warm' && p.healthy,
    ).length;
    const activePods = poolState.pod_states.filter((p) => p.state === 'active').length;

    const totalPods = poolState.total_pods || 1;
    const utilization = activePods / totalPods;

    const latencySum = poolState.pod_states.reduce((sum, p) => sum + p.recent_latency_ms, 0);
    const avgLatencyMs =
      poolState.pod_states.length > 0 ? latencySum / poolState.pod_states.length : 0;

    return {
      currentUtilization: utilization,
      avgLatencyMs,
      pendingRequests: activePods,
      availablePods,
      activePods,
    };
  }

  shouldScaleUp(poolState: WarmPoolState): boolean {
    const functionDef = this.functionDefinitions.get(poolState.function);
    const maxSize = functionDef?.pool.max_size ?? 10;

    if (poolState.total_pods >= maxSize) {
      logger.debug({ function: poolState.function }, 'Cannot scale up: at max size');
      return false;
    }

    const now = Date.now();
    const lastScale = this.lastScaleUp.get(poolState.function) ?? 0;
    if (now - lastScale < this.config.cooldownSeconds * 1000) {
      logger.debug({ function: poolState.function }, 'Cannot scale up: in cooldown period');
      return false;
    }

    const metrics = this.getScalingMetrics(poolState);
    const targetUtilization = functionDef?.pool.target_utilization ?? this.config.scaleUpThreshold;

    if (metrics.currentUtilization >= targetUtilization) {
      return true;
    }

    if (metrics.availablePods === 0 && metrics.activePods > 0) {
      return true;
    }

    return false;
  }

  shouldScaleDown(poolState: WarmPoolState): boolean {
    const functionDef = this.functionDefinitions.get(poolState.function);
    const minSize = functionDef?.pool.min_size ?? 1;

    if (poolState.total_pods <= minSize) {
      return false;
    }

    const now = Date.now();
    const lastScale = this.lastScaleDown.get(poolState.function) ?? 0;
    if (now - lastScale < this.config.cooldownSeconds * 1000) {
      return false;
    }

    const metrics = this.getScalingMetrics(poolState);
    const idlePods = metrics.availablePods;

    if (metrics.currentUtilization < this.config.scaleDownThreshold && idlePods > 1) {
      return true;
    }

    return false;
  }

  calculateScaleUpTarget(poolState: WarmPoolState): number {
    const functionDef = this.functionDefinitions.get(poolState.function);
    const maxSize = functionDef?.pool.max_size ?? 10;

    const metrics = this.getScalingMetrics(poolState);
    const currentSize = poolState.total_pods;

    if (metrics.availablePods === 0) {
      return Math.min(currentSize + 1, maxSize);
    }

    const targetUtilization = functionDef?.pool.target_utilization ?? this.config.scaleUpThreshold;
    const desiredSize = Math.ceil(metrics.activePods / targetUtilization);

    return Math.min(Math.max(desiredSize, currentSize + 1), maxSize);
  }

  calculateScaleDownTarget(poolState: WarmPoolState): number {
    const functionDef = this.functionDefinitions.get(poolState.function);
    const minSize = functionDef?.pool.min_size ?? 1;

    const metrics = this.getScalingMetrics(poolState);

    const targetUtilization = this.config.scaleDownThreshold;
    const desiredSize = Math.floor(metrics.activePods / targetUtilization);

    return Math.max(Math.min(desiredSize, poolState.total_pods - 1), minSize);
  }

  makeScalingDecision(poolState: WarmPoolState): ScalingDecision {
    if (this.shouldScaleUp(poolState)) {
      const targetSize = this.calculateScaleUpTarget(poolState);
      return {
        action: 'scale_up',
        targetSize,
        reason: `Utilization high (${this.getScalingMetrics(poolState).currentUtilization.toFixed(2)})`,
        urgency: this.getScalingMetrics(poolState).availablePods === 0 ? 'high' : 'medium',
      };
    }

    if (this.shouldScaleDown(poolState)) {
      const targetSize = this.calculateScaleDownTarget(poolState);
      return {
        action: 'scale_down',
        targetSize,
        reason: `Utilization low (${this.getScalingMetrics(poolState).currentUtilization.toFixed(2)})`,
        urgency: 'low',
      };
    }

    return {
      action: 'none',
      targetSize: poolState.total_pods,
      reason: 'Within target range',
      urgency: 'low',
    };
  }

  async scaleUp(poolState: WarmPoolState, targetSize?: number): Promise<PodHealth | null> {
    const functionDef = this.functionDefinitions.get(poolState.function);
    if (!functionDef) {
      logger.error(
        { function: poolState.function },
        'Cannot scale up: function definition not found',
      );
      return null;
    }

    const maxSize = functionDef.pool.max_size;
    if (poolState.total_pods >= maxSize) {
      logger.warn({ function: poolState.function }, 'Cannot scale up: at max size');
      return null;
    }

    const podId = `${poolState.function}-pod-${crypto.randomUUID().substring(0, 8)}`;

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

      this.lastScaleUp.set(poolState.function, Date.now());

      logger.info({ function: poolState.function, pod: podId, targetSize }, 'Scaled up pool');
      return podHealth;
    } catch (error) {
      logger.error(
        {
          function: poolState.function,
          pod: podId,
          error: error instanceof Error ? error.message : error,
        },
        'Failed to scale up pool',
      );
      return null;
    }
  }

  async scaleDown(poolState: WarmPoolState, _targetSize?: number): Promise<string | null> {
    const functionDef = this.functionDefinitions.get(poolState.function);
    if (!functionDef) {
      logger.error(
        { function: poolState.function },
        'Cannot scale down: function definition not found',
      );
      return null;
    }

    const minSize = functionDef.pool.min_size;
    if (poolState.total_pods <= minSize) {
      logger.warn({ function: poolState.function }, 'Cannot scale down: at min size');
      return null;
    }

    const idlePods = poolState.pod_states.filter(
      (p) => p.state === 'warm' && p.active_invocations === 0,
    );
    if (idlePods.length === 0) {
      logger.debug({ function: poolState.function }, 'No idle pods to remove');
      return null;
    }

    const podToRemove = idlePods[0];

    try {
      await this.k8sClient.deletePod(podToRemove.pod_id, true);
      this.lastScaleDown.set(poolState.function, Date.now());

      logger.info({ function: poolState.function, pod: podToRemove.pod_id }, 'Scaled down pool');
      return podToRemove.pod_id;
    } catch (error) {
      logger.error(
        {
          function: poolState.function,
          pod: podToRemove.pod_id,
          error: error instanceof Error ? error.message : error,
        },
        'Failed to scale down pool',
      );
      return null;
    }
  }

  getScaleHistory(functionName: string): {
    lastScaleUp: number | undefined;
    lastScaleDown: number | undefined;
  } {
    return {
      lastScaleUp: this.lastScaleUp.get(functionName),
      lastScaleDown: this.lastScaleDown.get(functionName),
    };
  }

  getMinSize(functionName: string): number | undefined {
    return this.functionDefinitions.get(functionName)?.pool.min_size;
  }

  getMaxSize(functionName: string): number | undefined {
    return this.functionDefinitions.get(functionName)?.pool.max_size;
  }

  getTargetUtilization(functionName: string): number | undefined {
    return this.functionDefinitions.get(functionName)?.pool.target_utilization;
  }

  getScaleUpThreshold(): number {
    return this.config.scaleUpThreshold;
  }

  getScaleDownThreshold(): number {
    return this.config.scaleDownThreshold;
  }

  getCooldownSeconds(): number {
    return this.config.cooldownSeconds;
  }

  updatePoolLimits(functionName: string, minSize?: number, maxSize?: number): void {
    const def = this.functionDefinitions.get(functionName);
    if (def) {
      if (minSize !== undefined) def.pool.min_size = minSize;
      if (maxSize !== undefined) def.pool.max_size = maxSize;
    }
  }

  updateTargetUtilization(functionName: string, target: number): void {
    const def = this.functionDefinitions.get(functionName);
    if (def) {
      def.pool.target_utilization = target;
    }
  }

  updateScaleUpThreshold(threshold: number): void {
    this.config.scaleUpThreshold = threshold;
  }

  updateScaleDownThreshold(threshold: number): void {
    this.config.scaleDownThreshold = threshold;
  }

  updateCooldownSeconds(seconds: number): void {
    this.config.cooldownSeconds = seconds;
  }

  resetScaleHistory(functionName?: string): void {
    if (functionName) {
      this.lastScaleUp.delete(functionName);
      this.lastScaleDown.delete(functionName);
    } else {
      this.lastScaleUp.clear();
      this.lastScaleDown.clear();
    }
  }

  stop(): void {
    this.functionDefinitions.clear();
    this.lastScaleUp.clear();
    this.lastScaleDown.clear();
    logger.info('Scaling controller stopped');
  }
}
