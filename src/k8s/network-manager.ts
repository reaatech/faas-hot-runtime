import * as k8s from '@kubernetes/client-node';
import { logger } from '../observability/logger.js';

export interface NetworkManagerConfig {
  namespace: string;
  serviceType: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  ingressClass: string;
}

export interface ServiceEndpoint {
  name: string;
  clusterIP: string;
  port: number;
  targetPort: number;
  protocol: string;
}

export interface IngressConfig {
  name: string;
  host: string;
  path: string;
  serviceName: string;
  servicePort: number;
  tlsEnabled: boolean;
}

export class NetworkManager {
  private config: NetworkManagerConfig;
  private kubeClient: k8s.CoreV1Api | null = null;
  private networkingClient: k8s.NetworkingV1Api | null = null;
  private kc: k8s.KubeConfig | null = null;

  constructor(config: NetworkManagerConfig) {
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
    this.networkingClient = this.kc.makeApiClient(k8s.NetworkingV1Api);
    logger.info('Network manager initialized');
  }

  async createService(
    name: string,
    port: number,
    targetPort: number,
    selector?: Record<string, string>,
  ): Promise<ServiceEndpoint> {
    if (!this.kubeClient) {
      throw new Error('Network manager not initialized');
    }

    const serviceSelector = selector || { app: name };

    logger.info(
      { service: name, port, targetPort, selector: Object.keys(serviceSelector).join(',') },
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
        selector: serviceSelector,
        ports: [
          {
            port,
            targetPort,
            protocol: 'TCP',
          },
        ],
        type: this.config.serviceType,
      },
    };

    try {
      await this.kubeClient.createNamespacedService({
        namespace: this.config.namespace,
        body: serviceManifest,
      });

      const endpoint: ServiceEndpoint = {
        name,
        clusterIP: 'pending',
        port,
        targetPort,
        protocol: 'TCP',
      };

      logger.info({ service: name }, 'Service created successfully');
      return endpoint;
    } catch (error) {
      const apiError = error as k8s.ApiException<unknown>;
      if (apiError.code === 409) {
        logger.warn({ service: name }, 'Service already exists');
        const existing = await this.getService(name);
        if (existing) return existing;
        throw error;
      }
      logger.error(
        { service: name, error: error instanceof Error ? error.message : error },
        'Failed to create service',
      );
      throw error;
    }
  }

  async getService(name: string): Promise<ServiceEndpoint | null> {
    if (!this.kubeClient) {
      throw new Error('Network manager not initialized');
    }

    try {
      const body = await this.kubeClient.readNamespacedService({
        name,
        namespace: this.config.namespace,
      });

      return {
        name,
        clusterIP: body.spec?.clusterIP || '',
        port: body.spec?.ports?.[0]?.port || 0,
        targetPort: (body.spec?.ports?.[0]?.targetPort as number) || 0,
        protocol: body.spec?.ports?.[0]?.protocol || 'TCP',
      };
    } catch (error) {
      const apiError = error as k8s.ApiException<unknown>;
      if (apiError.code === 404) {
        return null;
      }
      logger.error(
        { service: name, error: error instanceof Error ? error.message : error },
        'Failed to get service',
      );
      throw error;
    }
  }

  async deleteService(name: string): Promise<void> {
    if (!this.kubeClient) {
      throw new Error('Network manager not initialized');
    }

    logger.info({ service: name }, 'Deleting service');

    try {
      await this.kubeClient.deleteNamespacedService({ name, namespace: this.config.namespace });
      logger.info({ service: name }, 'Service deleted successfully');
    } catch (error) {
      const apiError = error as k8s.ApiException<unknown>;
      if (apiError.code === 404) {
        logger.warn({ service: name }, 'Service not found');
        return;
      }
      logger.error(
        { service: name, error: error instanceof Error ? error.message : error },
        'Failed to delete service',
      );
      throw error;
    }
  }

  async createIngress(config: IngressConfig): Promise<void> {
    if (!this.networkingClient) {
      throw new Error('Network manager not initialized');
    }

    logger.info({ ingress: config.name, host: config.host, path: config.path }, 'Creating ingress');

    const ingressManifest: k8s.V1Ingress = {
      metadata: {
        name: config.name,
        namespace: this.config.namespace,
        labels: {
          'faas-hot-runtime/ingress': config.name,
        },
      },
      spec: {
        ingressClassName: this.config.ingressClass,
        rules: [
          {
            host: config.host,
            http: {
              paths: [
                {
                  path: config.path,
                  pathType: 'Prefix',
                  backend: {
                    service: {
                      name: config.serviceName,
                      port: {
                        number: config.servicePort,
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    };

    if (config.tlsEnabled) {
      ingressManifest.spec!.tls = [
        {
          hosts: [config.host],
          secretName: `${config.name}-tls`,
        },
      ];
    }

    try {
      await this.networkingClient.createNamespacedIngress({
        namespace: this.config.namespace,
        body: ingressManifest,
      });
      logger.info({ ingress: config.name }, 'Ingress created successfully');
    } catch (error) {
      const apiError = error as k8s.ApiException<unknown>;
      if (apiError.code === 409) {
        logger.warn({ ingress: config.name }, 'Ingress already exists');
        return;
      }
      logger.error(
        { ingress: config.name, error: error instanceof Error ? error.message : error },
        'Failed to create ingress',
      );
      throw error;
    }
  }

  async deleteIngress(name: string): Promise<void> {
    if (!this.networkingClient) {
      throw new Error('Network manager not initialized');
    }

    logger.info({ ingress: name }, 'Deleting ingress');

    try {
      await this.networkingClient.deleteNamespacedIngress({
        name,
        namespace: this.config.namespace,
      });
      logger.info({ ingress: name }, 'Ingress deleted successfully');
    } catch (error) {
      const apiError = error as k8s.ApiException<unknown>;
      if (apiError.code === 404) {
        logger.warn({ ingress: name }, 'Ingress not found');
        return;
      }
      logger.error(
        { ingress: name, error: error instanceof Error ? error.message : error },
        'Failed to delete ingress',
      );
      throw error;
    }
  }

  async createNetworkPolicy(
    name: string,
    podSelector: Record<string, string>,
    ingressRules?: k8s.V1NetworkPolicyIngressRule[],
    egressRules?: k8s.V1NetworkPolicyEgressRule[],
  ): Promise<void> {
    if (!this.networkingClient) {
      throw new Error('Network manager not initialized');
    }

    logger.info(
      { policy: name, podSelector: Object.keys(podSelector).join(',') },
      'Creating network policy',
    );

    const policyManifest: k8s.V1NetworkPolicy = {
      metadata: {
        name,
        namespace: this.config.namespace,
        labels: {
          'faas-hot-runtime/network-policy': name,
        },
      },
      spec: {
        podSelector: { matchLabels: podSelector },
        policyTypes: ['Ingress', 'Egress'],
        ingress: ingressRules,
        egress: egressRules,
      },
    };

    try {
      await this.networkingClient.createNamespacedNetworkPolicy({
        namespace: this.config.namespace,
        body: policyManifest,
      });
      logger.info({ policy: name }, 'Network policy created successfully');
    } catch (error) {
      const apiError = error as k8s.ApiException<unknown>;
      if (apiError.code === 409) {
        logger.warn({ policy: name }, 'Network policy already exists');
        return;
      }
      logger.error(
        { policy: name, error: error instanceof Error ? error.message : error },
        'Failed to create network policy',
      );
      throw error;
    }
  }

  async deleteNetworkPolicy(name: string): Promise<void> {
    if (!this.networkingClient) {
      throw new Error('Network manager not initialized');
    }

    logger.info({ policy: name }, 'Deleting network policy');

    try {
      await this.networkingClient.deleteNamespacedNetworkPolicy({
        name,
        namespace: this.config.namespace,
      });
      logger.info({ policy: name }, 'Network policy deleted successfully');
    } catch (error) {
      const apiError = error as k8s.ApiException<unknown>;
      if (apiError.code === 404) {
        logger.warn({ policy: name }, 'Network policy not found');
        return;
      }
      logger.error(
        { policy: name, error: error instanceof Error ? error.message : error },
        'Failed to delete network policy',
      );
      throw error;
    }
  }

  async createServiceForFunction(functionName: string, port: number): Promise<ServiceEndpoint> {
    return this.createService(`faas-${functionName}`, port, port, {
      'faas-hot-runtime/function': functionName,
    });
  }

  async deleteServiceForFunction(functionName: string): Promise<void> {
    await this.deleteService(`faas-${functionName}`);
  }

  async createIngressForFunction(
    functionName: string,
    host: string,
    path: string,
    servicePort: number,
    tlsEnabled: boolean = true,
  ): Promise<void> {
    await this.createIngress({
      name: `faas-${functionName}`,
      host,
      path,
      serviceName: `faas-${functionName}`,
      servicePort,
      tlsEnabled,
    });
  }

  async createNetworkPolicyForFunction(functionName: string): Promise<void> {
    await this.createNetworkPolicy(
      `faas-${functionName}`,
      { 'faas-hot-runtime/function': functionName },
      [
        {
          _from: [{ podSelector: { matchLabels: { 'faas-hot-runtime/function': functionName } } }],
        },
      ],
      [
        { to: [{ podSelector: { matchLabels: { 'faas-hot-runtime/function': functionName } } }] },
        {
          to: [
            {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
            },
          ],
          ports: [
            { port: 53, protocol: 'UDP' },
            { port: 53, protocol: 'TCP' },
          ],
        },
      ],
    );
  }

  async close(): Promise<void> {
    this.kubeClient = null;
    this.networkingClient = null;
    this.kc = null;
    logger.info('Network manager closed');
  }
}
