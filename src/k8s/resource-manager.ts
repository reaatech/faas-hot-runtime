import * as k8s from '@kubernetes/client-node';
import { logger } from '../observability/logger.js';

export interface ResourceManagerConfig {
  namespace: string;
  defaultCPURequest: string;
  defaultMemoryRequest: string;
}

export interface ResourceQuota {
  cpu: { used: number; limit: number; request: number };
  memory: { used: number; limit: number; request: number };
  pods: { used: number; limit: number };
  gpu: { used: number; limit: number };
}

export interface ResourceRecommendation {
  cpu: string;
  memory: string;
  gpu?: number;
  reasoning: string;
}

export interface NodeResources {
  cpu: { capacity: number; allocatable: number };
  memory: { capacity: number; allocatable: number };
  gpu: { capacity: number; allocatable: number };
  labels: Record<string, string>;
}

export class ResourceManager {
  private config: ResourceManagerConfig;
  private kubeClient: k8s.CoreV1Api | null = null;
  private kc: k8s.KubeConfig | null = null;

  constructor(config: ResourceManagerConfig) {
    this.config = config;
  }

  async initialize(kubeconfigPath?: string, clusterContext?: string): Promise<void> {
    this.kc = new k8s.KubeConfig();

    if (kubeconfigPath) {
      this.kc.loadFromFile(kubeconfigPath);
    } else {
      try {
        this.kc.loadFromCluster();
      } catch {
        this.kc.loadFromDefault();
      }
    }

    if (clusterContext) {
      this.kc.setCurrentContext(clusterContext);
    }

    this.kubeClient = this.kc.makeApiClient(k8s.CoreV1Api);
    logger.info('Resource manager initialized');
  }

  async checkResourceQuotas(): Promise<ResourceQuota> {
    if (!this.kubeClient) {
      throw new Error('Resource manager not initialized');
    }

    try {
      const { body } = await this.kubeClient.listNamespacedResourceQuota(this.config.namespace);

      const quota: ResourceQuota = {
        cpu: { used: 0, limit: 0, request: 0 },
        memory: { used: 0, limit: 0, request: 0 },
        pods: { used: 0, limit: 0 },
        gpu: { used: 0, limit: 0 },
      };

      for (const item of body.items || []) {
        if (item.status?.hard) {
          quota.cpu.limit = this.parseQuantity(item.status.hard.cpu as string) || quota.cpu.limit;
          quota.memory.limit = this.parseQuantity(item.status.hard.memory as string) || quota.memory.limit;
          quota.pods.limit = parseInt(item.status.hard.pods as string, 10) || quota.pods.limit;
        }
        if (item.status?.used) {
          quota.cpu.used = this.parseQuantity(item.status.used.cpu as string) || quota.cpu.used;
          quota.memory.used = this.parseQuantity(item.status.used.memory as string) || quota.memory.used;
          quota.pods.used = parseInt(item.status.used.pods as string, 10) || quota.pods.used;
        }
      }

      return quota;
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : error }, 'Failed to check resource quotas');
      throw error;
    }
  }

  async getNodeResources(): Promise<NodeResources[]> {
    if (!this.kubeClient) {
      throw new Error('Resource manager not initialized');
    }

    try {
      const { body } = await this.kubeClient.listNode();
      const nodes: NodeResources[] = [];

      for (const node of body.items || []) {
        const cpu = node.status?.capacity?.cpu ? this.parseQuantity(node.status.capacity.cpu) : 0;
        const memory = this.parseQuantity(node.status?.capacity?.memory as string) || 0;
        const gpu = parseInt(node.status?.capacity?.['nvidia.com/gpu'] as string, 10) || 0;

        const allocatableCpu = node.status?.allocatable?.cpu ? this.parseQuantity(node.status.allocatable.cpu) : cpu;
        const allocatableMemory = this.parseQuantity(node.status?.allocatable?.memory as string) || memory;
        const allocatableGpu = parseInt(node.status?.allocatable?.['nvidia.com/gpu'] as string, 10) || gpu;

        nodes.push({
          cpu: { capacity: cpu, allocatable: allocatableCpu },
          memory: { capacity: memory, allocatable: allocatableMemory },
          gpu: { capacity: gpu, allocatable: allocatableGpu },
          labels: node.metadata?.labels || {},
        });
      }

      return nodes;
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : error }, 'Failed to get node resources');
      throw error;
    }
  }

  async canAllocateResources(requestedCPU: string, requestedMemory: string, requestedGPU?: number): Promise<boolean> {
    const cpu = this.parseQuantity(requestedCPU);
    const memory = this.parseQuantity(requestedMemory);

    const quota = await this.checkResourceQuotas();

    const cpuAvailable = quota.cpu.limit - quota.cpu.used >= cpu;
    const memoryAvailable = quota.memory.limit - quota.memory.used >= memory;
    const gpuAvailable = requestedGPU ? quota.gpu.limit - quota.gpu.used >= requestedGPU : true;

    return cpuAvailable && memoryAvailable && gpuAvailable;
  }

  recommendResources(historicalCPU: string, historicalMemory: string, _avgDurationMs: number): ResourceRecommendation {
    const cpu = this.parseQuantity(historicalCPU);
    const memory = this.parseQuantity(historicalMemory);

    const recommendedCPU = Math.max(cpu * 1.2, 0.1);
    const recommendedMemory = Math.max(memory * 1.2, 128);

    return {
      cpu: `${Math.ceil(recommendedCPU * 1000)}m`,
      memory: `${Math.ceil(recommendedMemory)}Mi`,
      reasoning: `Based on historical usage: CPU ${historicalCPU}, Memory ${historicalMemory}, scaled by 1.2x for headroom`,
    };
  }

  calculateCostOptimizedSize(
    currentCPU: string,
    currentMemory: string,
    avgUtilization: number,
    targetUtilization: number = 0.7,
  ): ResourceRecommendation {
    const cpu = this.parseQuantity(currentCPU);
    const memory = this.parseQuantity(currentMemory);

    if (targetUtilization <= 0) {
      return {
        cpu: `${Math.ceil(cpu * 1000)}m`,
        memory: `${Math.ceil(memory)}Mi`,
        reasoning: `Cost optimization skipped: invalid targetUtilization ${targetUtilization}`,
      };
    }

    const cpuRatio = avgUtilization / targetUtilization;
    const memoryRatio = avgUtilization / targetUtilization;

    const recommendedCPU = Math.max(cpu * cpuRatio, 0.1);
    const recommendedMemory = Math.max(memory * memoryRatio, 128);

    return {
      cpu: `${Math.ceil(recommendedCPU * 1000)}m`,
      memory: `${Math.ceil(recommendedMemory)}Mi`,
      reasoning: `Cost optimization: current utilization ${(avgUtilization * 100).toFixed(0)}%, target ${(targetUtilization * 100).toFixed(0)}%`,
    };
  }

  async createResourceQuota(name: string, cpuLimit: string, memoryLimit: string, podsLimit: number): Promise<void> {
    if (!this.kubeClient) {
      throw new Error('Resource manager not initialized');
    }

    const quota: k8s.V1ResourceQuota = {
      metadata: {
        name,
        namespace: this.config.namespace,
      },
      spec: {
        hard: {
          'limits.cpu': cpuLimit,
          'limits.memory': memoryLimit,
          'requests.cpu': cpuLimit,
          'requests.memory': memoryLimit,
          'pods': podsLimit.toString(),
        },
      },
    };

    try {
      await this.kubeClient.createNamespacedResourceQuota(this.config.namespace, quota);
      logger.info({ name, cpuLimit, memoryLimit, podsLimit }, 'Resource quota created');
    } catch (error) {
      const httpError = error as k8s.HttpError;
      if (httpError.statusCode === 409) {
        logger.warn({ name }, 'Resource quota already exists');
        return;
      }
      logger.error({ error: error instanceof Error ? error.message : error }, 'Failed to create resource quota');
      throw error;
    }
  }

  async deleteResourceQuota(name: string): Promise<void> {
    if (!this.kubeClient) {
      throw new Error('Resource manager not initialized');
    }

    try {
      await this.kubeClient.deleteNamespacedResourceQuota(name, this.config.namespace);
      logger.info({ name }, 'Resource quota deleted');
    } catch (error) {
      const httpError = error as k8s.HttpError;
      if (httpError.statusCode === 404) {
        logger.warn({ name }, 'Resource quota not found');
        return;
      }
      logger.error({ error: error instanceof Error ? error.message : error }, 'Failed to delete resource quota');
      throw error;
    }
  }

  parseQuantity(quantity: string | number | null | undefined): number {
    if (quantity === null || quantity === undefined) {
      return 0;
    }

    if (typeof quantity === 'number') {
      return quantity;
    }

    const str = quantity.toString();
    const match = str.match(/^(\d+\.?\d*)([a-zA-Z]*)$/);

    if (!match) {
      return parseInt(str, 10) || 0;
    }

    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();

    switch (unit) {
      case 'm':
        return value / 1000;
      case 'ki':
        return value * 1024;
      case 'mi':
        return value * 1024 * 1024;
      case 'gi':
        return value * 1024 * 1024 * 1024;
      case 'k':
        return value * 1000;
      case 'g':
        return value * 1000 * 1000 * 1000;
      default:
        return value;
    }
  }

  formatCPU(cpu: number): string {
    if (cpu >= 1) {
      return `${cpu.toFixed(2)} cores`;
    }
    return `${(cpu * 1000).toFixed(0)}m`;
  }

  formatMemory(memory: number): string {
    if (memory >= 1024 * 1024 * 1024) {
      return `${(memory / (1024 * 1024 * 1024)).toFixed(2)} Gi`;
    }
    if (memory >= 1024 * 1024) {
      return `${(memory / (1024 * 1024)).toFixed(0)} Mi`;
    }
    if (memory >= 1024) {
      return `${(memory / 1024).toFixed(0)} Ki`;
    }
    return `${memory.toFixed(0)} B`;
  }

  async close(): Promise<void> {
    this.kubeClient = null;
    this.kc = null;
    logger.info('Resource manager closed');
  }
}