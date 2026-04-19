import * as k8s from '@kubernetes/client-node';
import { logger } from '../observability/logger.js';

export interface K8sConfig {
  kubeconfigPath?: string;
  namespace: string;
  clusterContext?: string;
}

export interface PodSpec {
  name: string;
  image: string;
  port: number;
  cpu: string;
  memory: string;
  gpu?: number;
  env?: Record<string, string>;
}

export interface PodStatus {
  name: string;
  phase: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown';
  ip?: string;
  nodeName?: string;
  startTime?: Date;
  ready: boolean;
}

/**
 * Kubernetes Client - abstracts K8s API interactions
 * Supports EKS, GKE, AKS with minimal changes
 */
export class K8sClient {
  private config: K8sConfig;
  private kubeClient: k8s.CoreV1Api | null = null;
  private kc: k8s.KubeConfig | null = null;

  constructor(config: K8sConfig) {
    this.config = config;
  }

  /**
   * Initialize the Kubernetes client
   */
  async initialize(): Promise<void> {
    logger.info(
      { namespace: this.config.namespace, context: this.config.clusterContext },
      'Initializing Kubernetes client',
    );

    this.kc = new k8s.KubeConfig();

    if (this.config.kubeconfigPath) {
      this.kc.loadFromFile(this.config.kubeconfigPath);
    } else {
      // Try in-cluster config first, then fallback to default kubeconfig
      try {
        this.kc.loadFromCluster();
        logger.info('Loaded in-cluster Kubernetes config');
      } catch {
        this.kc.loadFromDefault();
        logger.info('Loaded default Kubernetes config');
      }
    }

    if (this.config.clusterContext) {
      this.kc.setCurrentContext(this.config.clusterContext);
    }

    this.kubeClient = this.kc.makeApiClient(k8s.CoreV1Api);

    // Verify cluster connectivity
    try {
      await this.kubeClient.listNamespacedPod(this.config.namespace, undefined, undefined, undefined, undefined, undefined, 1);
      logger.info('Kubernetes cluster connectivity verified');
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : error },
        'Failed to connect to Kubernetes cluster',
      );
      throw new Error('Kubernetes cluster connection failed');
    }

    logger.info('Kubernetes client initialized');
  }

  /**
   * Create a pod for a function
   */
  async createPod(spec: PodSpec): Promise<PodStatus> {
    if (!this.kubeClient) {
      throw new Error('Kubernetes client not initialized');
    }

    logger.info({ pod: spec.name, image: spec.image }, 'Creating pod');

    const podManifest: k8s.V1Pod = {
      metadata: {
        name: spec.name,
        namespace: this.config.namespace,
        labels: {
          app: spec.name,
          'faas-hot-runtime/function': spec.name,
        },
      },
      spec: {
        containers: [
          {
            name: spec.name,
            image: spec.image,
            ports: [{ containerPort: spec.port, protocol: 'TCP' }],
            resources: {
              requests: {
                cpu: spec.cpu,
                memory: spec.memory,
              },
              limits: {
                cpu: spec.cpu,
                memory: spec.memory,
              },
            },
            securityContext: {
              runAsNonRoot: true,
              readOnlyRootFilesystem: true,
              allowPrivilegeEscalation: false,
            },
            env: spec.env
              ? Object.entries(spec.env).map(([name, value]) => ({ name, value }))
              : undefined,
            readinessProbe: {
              httpGet: {
                path: '/health',
                port: spec.port,
              },
              initialDelaySeconds: 5,
              periodSeconds: 10,
            },
            livenessProbe: {
              httpGet: {
                path: '/health',
                port: spec.port,
              },
              initialDelaySeconds: 15,
              periodSeconds: 20,
            },
          },
        ],
        securityContext: {
          fsGroup: 1000,
          seccompProfile: {
            type: 'RuntimeDefault',
          },
        },
        terminationGracePeriodSeconds: 30,
      },
    };

    // Add GPU resources if requested
    if (spec.gpu && spec.gpu > 0) {
      const container = podManifest.spec!.containers[0];
      if (container) {
        container.resources!.limits!['nvidia.com/gpu'] = spec.gpu.toString();
        container.resources!.requests!['nvidia.com/gpu'] = spec.gpu.toString();
      }
    }

    try {
      await this.kubeClient.createNamespacedPod(this.config.namespace, podManifest);

      logger.info({ pod: spec.name }, 'Pod created successfully');

      return {
        name: spec.name,
        phase: 'Pending',
        ready: false,
      };
    } catch (error) {
      logger.error(
        { pod: spec.name, error: error instanceof Error ? error.message : error },
        'Failed to create pod',
      );
      throw error;
    }
  }

  /**
   * Delete a pod
   */
  async deletePod(podName: string, graceful: boolean = true): Promise<void> {
    if (!this.kubeClient) {
      throw new Error('Kubernetes client not initialized');
    }

    logger.info({ pod: podName, graceful }, 'Deleting pod');

    try {
      const gracePeriodSeconds = graceful ? 30 : 0;
      const propagationPolicy = graceful ? 'Foreground' : 'Background';

      await this.kubeClient.deleteNamespacedPod(
        podName,
        this.config.namespace,
        undefined, // pretty
        undefined, // dryRun
        gracePeriodSeconds,
        undefined, // orphanDependents
        propagationPolicy,
      );

      logger.info({ pod: podName }, 'Pod deletion initiated');
    } catch (error) {
      const httpError = error as k8s.HttpError;
      if (httpError.statusCode === 404) {
        logger.warn({ pod: podName }, 'Pod not found, already deleted');
        return;
      }
      logger.error(
        { pod: podName, error: error instanceof Error ? error.message : error },
        'Failed to delete pod',
      );
      throw error;
    }
  }

  /**
   * Get pod status
   */
  async getPodStatus(podName: string): Promise<PodStatus | undefined> {
    if (!this.kubeClient) {
      throw new Error('Kubernetes client not initialized');
    }

    try {
      const { body: pod } = await this.kubeClient.readNamespacedPodStatus(podName, this.config.namespace);

      const conditions = pod.status?.conditions || [];
      const readyCondition = conditions.find((c: k8s.V1PodCondition) => c.type === 'Ready');

      return {
        name: podName,
        phase: (pod.status?.phase as PodStatus['phase']) || 'Unknown',
        ip: pod.status?.podIP,
        nodeName: pod.spec?.nodeName,
        startTime: pod.status?.startTime ? new Date(pod.status.startTime) : undefined,
        ready: readyCondition?.status === 'True',
      };
    } catch (error) {
      const httpError = error as k8s.HttpError;
      if (httpError.statusCode === 404) {
        return undefined;
      }
      logger.error(
        { pod: podName, error: error instanceof Error ? error.message : error },
        'Failed to get pod status',
      );
      throw error;
    }
  }

  /**
   * List pods by label selector
   */
  async listPods(labelSelector?: string): Promise<PodStatus[]> {
    if (!this.kubeClient) {
      throw new Error('Kubernetes client not initialized');
    }

    try {
      const { body: podList } = await this.kubeClient.listNamespacedPod(
        this.config.namespace,
        undefined,
        undefined,
        undefined,
        labelSelector,
        undefined,
      );

      return (podList.items || []).map((pod) => {
        const conditions = pod.status?.conditions || [];
        const readyCondition = conditions.find((c: k8s.V1PodCondition) => c.type === 'Ready');

        return {
          name: pod.metadata?.name || '',
          phase: (pod.status?.phase as PodStatus['phase']) || 'Unknown',
          ip: pod.status?.podIP,
          nodeName: pod.spec?.nodeName,
          startTime: pod.status?.startTime ? new Date(pod.status.startTime) : undefined,
          ready: readyCondition?.status === 'True',
        };
      });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : error },
        'Failed to list pods',
      );
      throw error;
    }
  }

  /**
   * Get pod logs
   */
  async getPodLogs(podName: string, tail?: number, follow?: boolean): Promise<string> {
    if (!this.kubeClient) {
      throw new Error('Kubernetes client not initialized');
    }

    try {
      const { body } = await this.kubeClient.readNamespacedPodLog(
        podName,
        this.config.namespace,
        undefined,
        undefined,
        follow,
        tail,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );

      return body as string;
    } catch (error) {
      const httpError = error as k8s.HttpError;
      if (httpError.statusCode === 404) {
        return '';
      }
      logger.error(
        { pod: podName, error: error instanceof Error ? error.message : error },
        'Failed to get pod logs',
      );
      throw error;
    }
  }

  /**
   * Create a Kubernetes service for a function
   */
  async createService(
    name: string,
    port: number,
    selector: Record<string, string>,
  ): Promise<void> {
    if (!this.kubeClient) {
      throw new Error('Kubernetes client not initialized');
    }

    logger.info(
      { service: name, port, selector: Object.keys(selector).join(',') },
      'Creating service',
    );

    const serviceManifest: k8s.V1Service = {
      metadata: {
        name,
        namespace: this.config.namespace,
        labels: {
          'faas-hot-runtime/service': name,
        },
      },
      spec: {
        selector,
        ports: [
          {
            port,
            targetPort: port,
            protocol: 'TCP',
          },
        ],
        type: 'ClusterIP',
      },
    };

    try {
      await this.kubeClient.createNamespacedService(this.config.namespace, serviceManifest);

      logger.info({ service: name }, 'Service created successfully');
    } catch (error) {
      const httpError = error as k8s.HttpError;
      if (httpError.statusCode === 409) {
        logger.warn({ service: name }, 'Service already exists');
        return;
      }
      logger.error(
        { service: name, error: error instanceof Error ? error.message : error },
        'Failed to create service',
      );
      throw error;
    }
  }

  /**
   * Delete a Kubernetes service
   */
  async deleteService(name: string): Promise<void> {
    if (!this.kubeClient) {
      throw new Error('Kubernetes client not initialized');
    }

    logger.info({ service: name }, 'Deleting service');

    try {
      await this.kubeClient.deleteNamespacedService(name, this.config.namespace);

      logger.info({ service: name }, 'Service deleted successfully');
    } catch (error) {
      const httpError = error as k8s.HttpError;
      if (httpError.statusCode === 404) {
        logger.warn({ service: name }, 'Service not found, already deleted');
        return;
      }
      logger.error(
        { service: name, error: error instanceof Error ? error.message : error },
        'Failed to delete service',
      );
      throw error;
    }
  }

  /**
   * Check resource quotas
   */
  async checkResourceQuotas(): Promise<{
    cpu: { used: number; limit: number };
    memory: { used: number; limit: number };
    pods: { used: number; limit: number };
  }> {
    if (!this.kubeClient) {
      throw new Error('Kubernetes client not initialized');
    }

    try {
      const { body } = await this.kubeClient.listNamespacedResourceQuota(this.config.namespace);

      let cpuUsed = 0;
      let cpuLimit = 0;
      let memoryUsed = 0;
      let memoryLimit = 0;
      let podsUsed = 0;
      let podsLimit = 0;

      for (const quota of body.items || []) {
        const status = quota.status;
        if (status?.hard) {
          cpuLimit = this.parseQuantity(status.hard.cpu as string) || 0;
          memoryLimit = this.parseQuantity(status.hard.memory as string) || 0;
          podsLimit = parseInt(status.hard.pods as string, 10) || 0;
        }
        if (status?.used) {
          cpuUsed = this.parseQuantity(status.used.cpu as string) || 0;
          memoryUsed = this.parseQuantity(status.used.memory as string) || 0;
          podsUsed = parseInt(status.used.pods as string, 10) || 0;
        }
      }

      return {
        cpu: { used: cpuUsed, limit: cpuLimit },
        memory: { used: memoryUsed, limit: memoryLimit },
        pods: { used: podsUsed, limit: podsLimit },
      };
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : error },
        'Failed to check resource quotas',
      );
      // Return default values on error
      return {
        cpu: { used: 0, limit: 1000 },
        memory: { used: 0, limit: 4096 },
        pods: { used: 0, limit: 100 },
      };
    }
  }

  /**
   * Parse Kubernetes quantity string (e.g., "100m", "1Gi")
   */
  private parseQuantity(quantity: string | number | null | undefined): number {
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
        return value / 1000; // millicores
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

  /**
   * Get cluster info
   */
  async getClusterInfo(): Promise<{
    version: string;
    platform: string;
    nodeCount: number;
  }> {
    if (!this.kubeClient || !this.kc) {
      throw new Error('Kubernetes client not initialized');
    }

    try {
      const { body: versionResponse } = await this.kc.makeApiClient(k8s.VersionApi).getCode();
      const version = versionResponse.gitVersion || 'unknown';

      const { body: nodesResponse } = await this.kubeClient.listNode();
      const nodeCount = nodesResponse.items?.length || 0;

      // Detect platform
      let platform = 'kubernetes';
      if (nodesResponse.items && nodesResponse.items.length > 0) {
        const firstNode = nodesResponse.items[0];
        const providerID = firstNode.spec?.providerID || '';

        if (providerID.includes('aws')) {
          platform = 'eks';
        } else if (providerID.includes('gce')) {
          platform = 'gke';
        } else if (providerID.includes('azure')) {
          platform = 'aks';
        }
      }

      return { version, platform, nodeCount };
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : error },
        'Failed to get cluster info',
      );
      return {
        version: 'unknown',
        platform: 'unknown',
        nodeCount: 0,
      };
    }
  }

  /**
   * Close the Kubernetes client connection
   */
  async close(): Promise<void> {
    this.kubeClient = null;
    this.kc = null;
    logger.info('Kubernetes client closed');
  }
}
