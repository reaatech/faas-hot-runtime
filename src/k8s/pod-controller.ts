import * as k8s from '@kubernetes/client-node';
import { logger } from '../observability/logger.js';
import type { FunctionDefinition } from '../types/index.js';

export interface PodControllerConfig {
  namespace: string;
  defaultGracePeriodSeconds: number;
  maxPodStartTimeMs: number;
}

export interface PodEvent {
  type: 'ADDED' | 'MODIFIED' | 'DELETED';
  podName: string;
  namespace: string;
  phase?: string;
  reason?: string;
  message?: string;
  timestamp: Date;
}

export type PodEventCallback = (event: PodEvent) => void;

export class PodController {
  private config: PodControllerConfig;
  private kubeClient: k8s.CoreV1Api | null = null;
  private kc: k8s.KubeConfig | null = null;
  private watchHandle?: k8s.Watch;
  private eventCallbacks: PodEventCallback[] = [];

  constructor(config: PodControllerConfig) {
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

    try {
      await this.kubeClient.listNamespacedPod({
        namespace: this.config.namespace,
        limit: 1,
      });
      logger.info('Pod controller initialized');
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : error },
        'Failed to connect to Kubernetes',
      );
      throw error;
    }
  }

  async createPod(functionDef: FunctionDefinition, podName?: string): Promise<string> {
    if (!this.kubeClient) {
      throw new Error('Pod controller not initialized');
    }

    const name = podName ?? `${functionDef.name}-pod-${crypto.randomUUID().substring(0, 8)}`;

    logger.info(
      { pod: name, function: functionDef.name, image: functionDef.container.image },
      'Creating pod',
    );

    const podManifest: k8s.V1Pod = {
      metadata: {
        name,
        namespace: this.config.namespace,
        labels: {
          app: name,
          'faas-hot-runtime/function': functionDef.name,
          'faas-hot-runtime/pool': 'warm',
        },
      },
      spec: {
        containers: [
          {
            name,
            image: functionDef.container.image,
            ports: [{ containerPort: functionDef.container.port, protocol: 'TCP' }],
            resources: {
              requests: {
                cpu: functionDef.container.resources.cpu,
                memory: functionDef.container.resources.memory,
              },
              limits: {
                cpu: functionDef.container.resources.cpu,
                memory: functionDef.container.resources.memory,
              },
            },
            securityContext: {
              runAsNonRoot: true,
              readOnlyRootFilesystem: true,
              allowPrivilegeEscalation: false,
            },
            readinessProbe: {
              httpGet: {
                path: '/health',
                port: functionDef.container.port,
              },
              initialDelaySeconds: 5,
              periodSeconds: 10,
            },
            livenessProbe: {
              httpGet: {
                path: '/health',
                port: functionDef.container.port,
              },
              initialDelaySeconds: 15,
              periodSeconds: 20,
            },
          },
        ],
        securityContext: {
          fsGroup: 1000,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        terminationGracePeriodSeconds: this.config.defaultGracePeriodSeconds,
      },
    };

    if (functionDef.container.resources.gpu && functionDef.container.resources.gpu > 0) {
      const container = podManifest.spec!.containers[0];
      container.resources!.limits!['nvidia.com/gpu'] =
        functionDef.container.resources.gpu.toString();
      container.resources!.requests!['nvidia.com/gpu'] =
        functionDef.container.resources.gpu.toString();
    }

    try {
      await this.kubeClient.createNamespacedPod({
        namespace: this.config.namespace,
        body: podManifest,
      });
      logger.info({ pod: name }, 'Pod created successfully');
      return name;
    } catch (error) {
      logger.error(
        { pod: name, error: error instanceof Error ? error.message : error },
        'Failed to create pod',
      );
      throw error;
    }
  }

  async deletePod(podName: string, graceful: boolean = true): Promise<void> {
    if (!this.kubeClient) {
      throw new Error('Pod controller not initialized');
    }

    logger.info({ pod: podName, graceful }, 'Deleting pod');

    try {
      const gracePeriodSeconds = graceful ? this.config.defaultGracePeriodSeconds : 0;
      const propagationPolicy = graceful ? 'Foreground' : 'Background';

      await this.kubeClient.deleteNamespacedPod({
        name: podName,
        namespace: this.config.namespace,
        gracePeriodSeconds,
        propagationPolicy,
      });

      logger.info({ pod: podName }, 'Pod deletion initiated');
    } catch (error) {
      const apiError = error as k8s.ApiException<unknown>;
      if (apiError.code === 404) {
        logger.warn({ pod: podName }, 'Pod not found');
        return;
      }
      logger.error(
        { pod: podName, error: error instanceof Error ? error.message : error },
        'Failed to delete pod',
      );
      throw error;
    }
  }

  async updatePod(podName: string, _updates: Partial<k8s.V1Pod>): Promise<void> {
    throw new Error(
      `Cannot update pod '${podName}': pod specs are immutable in Kubernetes. ` +
        `Delete the pod and recreate it with the desired configuration.`,
    );
  }

  async getPodStatus(podName: string): Promise<{
    phase: string;
    ready: boolean;
    ip?: string;
    nodeName?: string;
    startTime?: Date;
  } | null> {
    if (!this.kubeClient) {
      throw new Error('Pod controller not initialized');
    }

    try {
      const pod = await this.kubeClient.readNamespacedPodStatus({
        name: podName,
        namespace: this.config.namespace,
      });
      const readyCondition = (pod.status?.conditions || []).find(
        (c: k8s.V1PodCondition) => c.type === 'Ready',
      );

      return {
        phase: pod.status?.phase || 'Unknown',
        ready: readyCondition?.status === 'True',
        ip: pod.status?.podIP,
        nodeName: pod.spec?.nodeName,
        startTime: pod.status?.startTime ? new Date(pod.status.startTime) : undefined,
      };
    } catch (error) {
      const apiError = error as k8s.ApiException<unknown>;
      if (apiError.code === 404) {
        return null;
      }
      logger.error(
        { pod: podName, error: error instanceof Error ? error.message : error },
        'Failed to get pod status',
      );
      throw error;
    }
  }

  async waitForPodReady(podName: string, timeoutMs?: number): Promise<boolean> {
    const startTime = Date.now();
    const timeout = timeoutMs ?? this.config.maxPodStartTimeMs;

    while (Date.now() - startTime < timeout) {
      const status = await this.getPodStatus(podName);
      if (status === null) {
        throw new Error(`Pod '${podName}' was deleted while waiting for it to become ready`);
      }
      if (status.ready && status.phase === 'Running') {
        return true;
      }
      await this.sleep(1000);
    }

    logger.warn({ pod: podName, timeoutMs: timeout }, 'Pod failed to become ready in time');
    return false;
  }

  async listPods(functionName?: string): Promise<string[]> {
    if (!this.kubeClient) {
      throw new Error('Pod controller not initialized');
    }

    const labelSelector = functionName
      ? `faas-hot-runtime/function=${functionName}`
      : 'faas-hot-runtime/function';

    try {
      const body = await this.kubeClient.listNamespacedPod({
        namespace: this.config.namespace,
        labelSelector,
      });

      return (body.items || []).map((pod) => pod.metadata?.name || '').filter(Boolean);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : error },
        'Failed to list pods',
      );
      throw error;
    }
  }

  async watchPods(functionName?: string, callback?: PodEventCallback): Promise<void> {
    if (!this.kc || !this.kubeClient) {
      throw new Error('Pod controller not initialized');
    }

    if (callback) {
      this.eventCallbacks.push(callback);
    }

    const labelSelector = functionName
      ? `faas-hot-runtime/function=${functionName}`
      : 'faas-hot-runtime/function';

    const watch = new k8s.Watch(this.kc);

    this.stopWatching();

    this.watchHandle = watch;

    watch.watch(
      `/api/v1/namespaces/${this.config.namespace}/pods`,
      { labelSelector },
      (phase: string, obj: k8s.V1Pod) => {
        const type = phase as 'ADDED' | 'MODIFIED' | 'DELETED';
        const event: PodEvent = {
          type,
          podName: obj.metadata?.name || '',
          namespace: this.config.namespace,
          phase: obj.status?.phase,
          timestamp: new Date(),
        };

        for (const cb of this.eventCallbacks) {
          try {
            cb(event);
          } catch (error) {
            logger.error(
              { error: error instanceof Error ? error.message : error },
              'Pod event callback failed',
            );
          }
        }
      },
      (err) => {
        logger.error({ error: err }, 'Pod watch error');
      },
    );

    logger.info({ functionName }, 'Started watching pods');
  }

  stopWatching(): void {
    if (this.watchHandle) {
      (this.watchHandle as unknown as { abort: () => void }).abort();
      this.watchHandle = undefined;
      logger.info('Stopped watching pods');
    }
  }

  onPodEvent(callback: PodEventCallback): void {
    this.eventCallbacks.push(callback);
  }

  async close(): Promise<void> {
    this.stopWatching();
    this.kubeClient = null;
    this.kc = null;
    logger.info('Pod controller closed');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
