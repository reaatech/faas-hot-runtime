import { describe, it, expect, beforeEach } from 'vitest';
import { CostTracker } from '../../../src/cost/cost-tracker.js';

describe('CostTracker', () => {
  let costTracker: CostTracker;

  beforeEach(() => {
    costTracker = new CostTracker({
      cpuCostPerMs: 0.0000001,
      memoryCostPerMs: 0.00000005,
      networkCostPerMB: 0.00001,
      queueCostPerRequest: 0.0000004,
    });
  });

  describe('calculateCost', () => {
    it('should calculate cost for HTTP invocation', () => {
      const cost = costTracker.calculateCost({
        durationMs: 100,
        cpu: '100m',
        memory: '128Mi',
      });

      expect(cost.compute).toBeGreaterThan(0);
      expect(cost.network).toBe(0);
      expect(cost.queue).toBe(0);
    });

    it('should calculate cost for queue-triggered invocation', () => {
      const cost = costTracker.calculateCost({
        durationMs: 100,
        cpu: '100m',
        memory: '128Mi',
        isQueueTrigger: true,
      });

      expect(cost.queue).toBeGreaterThan(0);
    });

    it('should calculate network cost', () => {
      const cost = costTracker.calculateCost({
        durationMs: 100,
        cpu: '100m',
        memory: '128Mi',
        networkBytes: 1024 * 1024, // 1MB
      });

      expect(cost.network).toBe(0.00001);
    });
  });

  describe('recordCost', () => {
    it('should record a cost entry', () => {
      const record = costTracker.recordCost({
        function: 'hello-world',
        request_id: 'req-123',
        cost_usd: 0.0001,
        breakdown: { compute: 0.00008, network: 0.000015, queue: 0.000005 },
        pod_id: 'pod-123',
        duration_ms: 100,
      });

      expect(record.id).toBeDefined();
      expect(record.timestamp).toBeDefined();
      expect(record.function).toBe('hello-world');
      expect(record.cost_usd).toBe(0.0001);
    });

    it('should track daily total', () => {
      costTracker.recordCost({
        function: 'func-1',
        request_id: 'req-1',
        cost_usd: 0.001,
        breakdown: { compute: 0.001, network: 0, queue: 0 },
        pod_id: 'pod-1',
        duration_ms: 100,
      });

      costTracker.recordCost({
        function: 'func-2',
        request_id: 'req-2',
        cost_usd: 0.002,
        breakdown: { compute: 0.002, network: 0, queue: 0 },
        pod_id: 'pod-2',
        duration_ms: 200,
      });

      expect(costTracker.getDailyTotal()).toBe(0.003);
    });
  });

  describe('getFunctionCosts', () => {
    it('should return costs for a specific function', () => {
      costTracker.recordCost({
        function: 'hello-world',
        request_id: 'req-1',
        cost_usd: 0.001,
        breakdown: { compute: 0.001, network: 0, queue: 0 },
        pod_id: 'pod-1',
        duration_ms: 100,
      });

      costTracker.recordCost({
        function: 'other-func',
        request_id: 'req-2',
        cost_usd: 0.002,
        breakdown: { compute: 0.002, network: 0, queue: 0 },
        pod_id: 'pod-2',
        duration_ms: 200,
      });

      const costs = costTracker.getFunctionCosts('hello-world');
      expect(costs).toHaveLength(1);
      expect(costs[0]?.cost_usd).toBe(0.001);
    });
  });

  describe('getTotalCost', () => {
    it('should return total cost across all functions', () => {
      costTracker.recordCost({
        function: 'func-1',
        request_id: 'req-1',
        cost_usd: 0.001,
        breakdown: { compute: 0.001, network: 0, queue: 0 },
        pod_id: 'pod-1',
        duration_ms: 100,
      });

      costTracker.recordCost({
        function: 'func-2',
        request_id: 'req-2',
        cost_usd: 0.002,
        breakdown: { compute: 0.002, network: 0, queue: 0 },
        pod_id: 'pod-2',
        duration_ms: 200,
      });

      expect(costTracker.getTotalCost()).toBe(0.003);
    });
  });

  describe('parseCPU edge cases', () => {
    it('should handle CPU without m suffix', () => {
      const cost = costTracker.calculateCost({
        durationMs: 100,
        cpu: '0.5',
        memory: '128Mi',
      });
      expect(cost.compute).toBeGreaterThan(0);
    });

    it('should handle CPU with integer value', () => {
      const cost = costTracker.calculateCost({
        durationMs: 100,
        cpu: '1',
        memory: '128Mi',
      });
      expect(cost.compute).toBeGreaterThan(0);
    });
  });

  describe('parseMemory edge cases', () => {
    it('should handle Gi suffix', () => {
      const cost = costTracker.calculateCost({
        durationMs: 100,
        cpu: '100m',
        memory: '1Gi',
      });
      expect(cost.compute).toBeGreaterThan(0);
    });

    it('should handle plain number memory', () => {
      const cost = costTracker.calculateCost({
        durationMs: 100,
        cpu: '100m',
        memory: '256',
      });
      expect(cost.compute).toBeGreaterThan(0);
    });
  });

  describe('getFunctionCosts with limit', () => {
    it('should return limited records when limit is specified', () => {
      costTracker.recordCost({
        function: 'hello-world',
        request_id: 'req-1',
        cost_usd: 0.001,
        breakdown: { compute: 0.001, network: 0, queue: 0 },
        pod_id: 'pod-1',
        duration_ms: 100,
      });

      costTracker.recordCost({
        function: 'hello-world',
        request_id: 'req-2',
        cost_usd: 0.002,
        breakdown: { compute: 0.002, network: 0, queue: 0 },
        pod_id: 'pod-2',
        duration_ms: 200,
      });

      costTracker.recordCost({
        function: 'hello-world',
        request_id: 'req-3',
        cost_usd: 0.003,
        breakdown: { compute: 0.003, network: 0, queue: 0 },
        pod_id: 'pod-3',
        duration_ms: 300,
      });

      const costs = costTracker.getFunctionCosts('hello-world', 2);
      expect(costs).toHaveLength(2);
    });
  });

  describe('cleanupOldRecords', () => {
    it('should clean up records older than 24 hours', () => {
      costTracker.recordCost({
        function: 'func-1',
        request_id: 'req-old',
        cost_usd: 0.001,
        breakdown: { compute: 0.001, network: 0, queue: 0 },
        pod_id: 'pod-old',
        duration_ms: 100,
      });

      costTracker.cleanupOldRecords();

      expect(costTracker.getFunctionCosts('func-1')).toHaveLength(1);
    });
  });
});
