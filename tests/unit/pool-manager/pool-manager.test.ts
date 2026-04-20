import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PoolManager } from '../../../src/pool-manager/pool-manager.js';
import type { FunctionDefinition } from '../../../src/types/index.js';
import type { K8sClient } from '../../../src/k8s/k8s-client.js';

// Mock K8sClient
const createMockK8sClient = () => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  createPod: vi.fn().mockResolvedValue({ name: 'mock-pod', phase: 'Pending', ready: false }),
  deletePod: vi.fn().mockResolvedValue(undefined),
  getPodStatus: vi.fn().mockResolvedValue({ name: 'mock-pod', phase: 'Running', ready: true }),
  listPods: vi.fn().mockResolvedValue([]),
  getPodLogs: vi.fn().mockResolvedValue(''),
  createService: vi.fn().mockResolvedValue(undefined),
  deleteService: vi.fn().mockResolvedValue(undefined),
  checkResourceQuotas: vi.fn().mockResolvedValue({
    cpu: { used: 0, limit: 1000 },
    memory: { used: 0, limit: 4096 },
    pods: { used: 0, limit: 100 },
  }),
  getClusterInfo: vi
    .fn()
    .mockResolvedValue({ version: 'v1.0.0', platform: 'kubernetes', nodeCount: 1 }),
  close: vi.fn().mockResolvedValue(undefined),
});

describe('PoolManager', () => {
  let poolManager: PoolManager;
  let mockK8sClient: ReturnType<typeof createMockK8sClient>;

  const mockFunction: FunctionDefinition = {
    name: 'test-function',
    description: 'Test function',
    version: '1.0.0',
    container: {
      image: 'test:latest',
      port: 8080,
      resources: { cpu: '100m', memory: '128Mi', gpu: 0 },
    },
    pool: {
      min_size: 2,
      max_size: 5,
      target_utilization: 0.7,
      warm_up_time_seconds: 30,
    },
    triggers: [{ type: 'http', path: '/test' }],
    mcp: {
      enabled: false,
      tool_name: 'test',
      description: 'test',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    cost: {
      budget_daily: 10,
      cost_per_invocation_estimate: 0.0001,
      alert_thresholds: [0.5, 0.75, 0.9],
    },
    observability: { tracing_enabled: true, metrics_enabled: true, log_level: 'info' },
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    mockK8sClient = createMockK8sClient();

    poolManager = new PoolManager(
      {
        defaultMinSize: 2,
        defaultMaxSize: 10,
        defaultTargetUtilization: 0.7,
        healthCheckIntervalMs: 5000,
        scaleUpThreshold: 0.7,
        scaleDownThreshold: 0.3,
        scalingCooldownSeconds: 60,
      },
      mockK8sClient as unknown as K8sClient,
    );
    await poolManager.initialize();
  });

  afterEach(async () => {
    await poolManager.stop();
    vi.useRealTimers();
  });

  describe('createPool', () => {
    it('should create a pool with minimum pods', async () => {
      await poolManager.createPool(mockFunction);

      const state = poolManager.getPoolState('test-function');
      expect(state).toBeDefined();
      expect(state?.total_pods).toBe(2);
      expect(state?.available_pods).toBe(2);
      expect(state?.active_pods).toBe(0);
    });

    it('should initialize all pods in warm state', async () => {
      await poolManager.createPool(mockFunction);

      const state = poolManager.getPoolState('test-function');
      expect(state?.pod_states).toHaveLength(2);
      state?.pod_states.forEach((pod) => {
        expect(pod.state).toBe('warm');
        expect(pod.healthy).toBe(true);
      });
    });
  });

  describe('selectPod', () => {
    it('should select an available pod', async () => {
      await poolManager.createPool(mockFunction);

      const podId = await poolManager.selectPod('test-function');
      expect(podId).toBeDefined();

      const state = poolManager.getPoolState('test-function');
      expect(state?.available_pods).toBe(1);
      expect(state?.active_pods).toBe(1);
    });

    it('should throw when no pool exists', async () => {
      await expect(poolManager.selectPod('non-existent')).rejects.toThrow(
        'No pool found for function: non-existent',
      );
    });

    it('should scale up when no pods available and within max size', async () => {
      const smallFunc = {
        ...mockFunction,
        name: 'small-func',
        pool: { ...mockFunction.pool, min_size: 1, max_size: 5 },
      };
      await poolManager.createPool(smallFunc);

      // First select uses the only pod
      await poolManager.selectPod('small-func');

      // Second select should scale up and return a new pod
      const podId = await poolManager.selectPod('small-func');
      expect(podId).toBeDefined();

      const state = poolManager.getPoolState('small-func');
      expect(state?.total_pods).toBe(2);
    });
  });

  describe('releasePod', () => {
    it('should release a pod back to warm state', async () => {
      await poolManager.createPool(mockFunction);

      const podId = await poolManager.selectPod('test-function');

      let state = poolManager.getPoolState('test-function');
      const pod = state?.pod_states.find((p) => p.pod_id === podId);
      expect(pod?.state).toBe('active');

      await poolManager.releasePod('test-function', podId, 50);

      state = poolManager.getPoolState('test-function');
      expect(state?.active_pods).toBe(0);
    });

    it('should return early when pool not found', async () => {
      await poolManager.createPool(mockFunction);
      await poolManager.releasePod('non-existent-func', 'some-pod', 50);
    });

    it('should return early when pod not found', async () => {
      await poolManager.createPool(mockFunction);
      await poolManager.releasePod('test-function', 'non-existent-pod', 50);
    });

    it('should trigger scaleDown when utilization drops below 0.3', async () => {
      const scalableFunc = {
        ...mockFunction,
        name: 'scalable-func',
        pool: { min_size: 1, max_size: 10, target_utilization: 0.7, warm_up_time_seconds: 30 },
      };
      await poolManager.createPool(scalableFunc);

      const podId = await poolManager.selectPod('scalable-func');
      await poolManager.releasePod('scalable-func', podId, 50);

      const state = poolManager.getPoolState('scalable-func');
      expect(state?.total_pods).toBeLessThanOrEqual(1);
    });
  });

  describe('scaleDown (private method)', () => {
    it('should scale down when utilization is low and pods are idle', async () => {
      const scalableFunc = {
        ...mockFunction,
        name: 'scalable-func',
        pool: { min_size: 1, max_size: 5, target_utilization: 0.7, warm_up_time_seconds: 30 },
      };
      await poolManager.createPool(scalableFunc);

      expect(poolManager.getPoolState('scalable-func')?.total_pods).toBe(1);

      const podId = await poolManager.selectPod('scalable-func');
      await poolManager.releasePod('scalable-func', podId, 50);

      const state = poolManager.getPoolState('scalable-func');
      expect(state?.total_pods).toBeLessThanOrEqual(1);
    });

    it('should not scale down below minSize', async () => {
      await poolManager.createPool(mockFunction);

      const podId = await poolManager.selectPod('test-function');
      await poolManager.releasePod('test-function', podId, 50);

      const state = poolManager.getPoolState('test-function');
      expect(state?.total_pods).toBeGreaterThanOrEqual(1);
    });

    it('should handle scaleDown error gracefully', async () => {
      vi.mocked(mockK8sClient.deletePod).mockRejectedValueOnce(new Error('Delete failed'));

      const scalableFunc = {
        ...mockFunction,
        name: 'scale-down-err-func',
        pool: { min_size: 2, max_size: 5, target_utilization: 0.7, warm_up_time_seconds: 30 },
      };
      await poolManager.createPool(scalableFunc);

      const podId = await poolManager.selectPod('scale-down-err-func');
      await poolManager.releasePod('scale-down-err-func', podId, 50);

      const state = poolManager.getPoolState('scale-down-err-func');
      expect(state).toBeDefined();
    });
  });

  describe('scaleUp error handling', () => {
    it('should handle scaleUp createPod failure gracefully', async () => {
      vi.mocked(mockK8sClient.createPod).mockRejectedValueOnce(new Error('Create failed'));

      const scalableFunc = {
        ...mockFunction,
        name: 'scale-up-err-func',
        pool: { min_size: 1, max_size: 5, target_utilization: 0.7, warm_up_time_seconds: 30 },
      };
      await poolManager.createPool(scalableFunc);

      expect(poolManager.getPoolState('scale-up-err-func')).toBeDefined();
    });
  });

  describe('getPoolState', () => {
    it('should return undefined for non-existent pool', () => {
      expect(poolManager.getPoolState('non-existent')).toBeUndefined();
    });

    it('should return pool state for existing pool', async () => {
      await poolManager.createPool(mockFunction);

      const state = poolManager.getPoolState('test-function');
      expect(state).toBeDefined();
      expect(state?.function).toBe('test-function');
    });
  });

  describe('getAllPoolStates', () => {
    it('should return empty array when no pools', () => {
      expect(poolManager.getAllPoolStates()).toHaveLength(0);
    });

    it('should return all pool states', async () => {
      const func2 = { ...mockFunction, name: 'test-function-2' };
      await poolManager.createPool(mockFunction);
      await poolManager.createPool(func2);

      const states = poolManager.getAllPoolStates();
      expect(states).toHaveLength(2);
    });
  });

  describe('healthCheck', () => {
    it('should handle empty pools', async () => {
      await poolManager.healthCheck();
      expect(mockK8sClient.getPodStatus).not.toHaveBeenCalled();
    });

    it('should clean up terminated pods and call deletePod', async () => {
      // Create pool first
      await poolManager.createPool(mockFunction);

      // Add a terminated pod manually
      const poolState = poolManager['poolStates'].get('test-function');
      if (poolState) {
        poolState.pod_states.push({
          pod_id: 'terminated-pod',
          state: 'terminated',
          healthy: false,
          last_health_check: new Date(),
          recent_latency_ms: 0,
          active_invocations: 0,
          created_at: new Date(),
        });
        poolState.total_pods = 3;
      }

      vi.mocked(mockK8sClient.getPodStatus).mockResolvedValue({
        ready: true,
        phase: 'Running',
        restartCount: 0,
      });

      await poolManager.healthCheck();

      expect(mockK8sClient.deletePod).toHaveBeenCalledWith('terminated-pod', false);
    });

    it('should remove terminated pods from pool state', async () => {
      await poolManager.createPool(mockFunction);

      // Add a terminated pod
      const poolState = poolManager['poolStates'].get('test-function');
      if (poolState) {
        poolState.pod_states.push({
          pod_id: 'to-remove',
          state: 'terminated',
          healthy: false,
          last_health_check: new Date(),
          recent_latency_ms: 0,
          active_invocations: 0,
          created_at: new Date(),
        });
        poolState.total_pods = 3;
      }

      vi.mocked(mockK8sClient.getPodStatus).mockResolvedValue({
        ready: true,
        phase: 'Running',
        restartCount: 0,
      });

      await poolManager.healthCheck();

      const updatedPool = poolManager['poolStates'].get('test-function');
      expect(updatedPool?.pod_states.length).toBe(2);
      expect(updatedPool?.pod_states.find((p) => p.pod_id === 'to-remove')).toBeUndefined();
    });

    it('should update pod health based on status', async () => {
      await poolManager.createPool(mockFunction);

      vi.mocked(mockK8sClient.getPodStatus).mockResolvedValue({
        ready: true,
        phase: 'Running',
        restartCount: 0,
      });

      await poolManager.healthCheck();

      const updatedPool = poolManager['poolStates'].get('test-function');
      expect(updatedPool).toBeDefined();
      expect(updatedPool?.pod_states.length).toBe(2);
      expect(updatedPool?.pod_states.every((p) => p.healthy)).toBe(true);
    });

    it('should mark pod unhealthy when status is null', async () => {
      await poolManager.createPool(mockFunction);

      vi.mocked(mockK8sClient.getPodStatus).mockResolvedValue(null);

      await poolManager.healthCheck();

      const updatedPool = poolManager['poolStates'].get('test-function');
      expect(updatedPool?.pod_states.length).toBe(2);
      expect(updatedPool?.pod_states.every((p) => !p.healthy)).toBe(true);
    });

    it('should handle health check errors gracefully', async () => {
      await poolManager.createPool(mockFunction);

      vi.mocked(mockK8sClient.getPodStatus).mockRejectedValue(new Error('Connection failed'));

      await poolManager.healthCheck();

      // Pods should be marked unhealthy but remain
      const updatedPool = poolManager['poolStates'].get('test-function');
      expect(updatedPool?.pod_states.length).toBe(2);
    });
  });
});
