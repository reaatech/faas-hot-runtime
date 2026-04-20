import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OptimizationEngine } from '../../../src/cost/optimization-engine.js';
import type { CostRecord, FunctionDefinition } from '../../../src/types/index.js';
import type {
  OptimizationConfig,
  ResourceUsageStats,
  CostOptimizationRecommendation,
} from '../../../src/cost/optimization-engine.js';

vi.mock('../../../src/observability/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('OptimizationEngine', () => {
  let engine: OptimizationEngine;

  const createMockFunction = (
    name: string,
    cpu: string = '100m',
    memory: string = '128Mi',
    minSize: number = 1,
    maxSize: number = 5,
  ): FunctionDefinition => ({
    name,
    description: 'Test function',
    version: '1.0.0',
    container: {
      image: 'test:latest',
      port: 8080,
      resources: { cpu, memory, gpu: 0 },
    },
    pool: {
      min_size: minSize,
      max_size: maxSize,
      target_utilization: 0.7,
      warm_up_time_seconds: 30,
    },
    triggers: [{ type: 'http', path: `/${name}`, methods: ['POST'] }],
    mcp: {
      enabled: true,
      tool_name: name.replace(/-/g, '_'),
      description: 'Test',
      input_schema: { type: 'object', properties: {} },
    },
    cost: {
      budget_daily: 10,
      cost_per_invocation_estimate: 0.0001,
      alert_thresholds: [0.5, 0.75, 0.9],
    },
    observability: { tracing_enabled: true, metrics_enabled: true, log_level: 'info' },
  });

  const createCostRecord = (functionName: string, durationMs: number = 100): CostRecord => ({
    id: `rec-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    function: functionName,
    request_id: `req-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date(),
    cost_usd: 0.001,
    duration_ms: durationMs,
    pod_id: `pod-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    breakdown: { compute: 0.0008, network: 0.0001, queue: 0.0001 },
  });

  beforeEach(() => {
    engine = new OptimizationEngine({
      targetUtilization: 0.7,
      minCostImprovementPercent: 10,
      analysisWindowMs: 3600000,
      autoResizeEnabled: false,
    });
  });

  describe('constructor', () => {
    it('should use default config', () => {
      const defaultEngine = new OptimizationEngine();
      expect(
        (defaultEngine as unknown as { config: OptimizationConfig }).config.targetUtilization,
      ).toBe(0.7);
      expect(
        (defaultEngine as unknown as { config: OptimizationConfig }).config
          .minCostImprovementPercent,
      ).toBe(10);
    });

    it('should accept custom config', () => {
      const customEngine = new OptimizationEngine({
        targetUtilization: 0.8,
        minCostImprovementPercent: 15,
      });
      expect(
        (customEngine as unknown as { config: OptimizationConfig }).config.targetUtilization,
      ).toBe(0.8);
      expect(
        (customEngine as unknown as { config: OptimizationConfig }).config
          .minCostImprovementPercent,
      ).toBe(15);
    });
  });

  describe('recordInvocation', () => {
    it('should record invocation for function', () => {
      const record = createCostRecord('func1');
      engine.recordInvocation(record);
      expect(
        (engine as unknown as { costHistory: Map<string, CostRecord[]> }).costHistory.get('func1'),
      ).toHaveLength(1);
    });

    it('should append to existing history', () => {
      engine.recordInvocation(createCostRecord('func1'));
      engine.recordInvocation(createCostRecord('func1'));
      expect(
        (engine as unknown as { costHistory: Map<string, CostRecord[]> }).costHistory.get('func1'),
      ).toHaveLength(2);
    });
  });

  describe('analyzeFunction', () => {
    it('should return null for unknown function', () => {
      const stats = engine.analyzeFunction('unknown');
      expect(stats).toBeNull();
    });

    it('should return null for function with no recent records', () => {
      const oldRecord = createCostRecord('func1');
      oldRecord.timestamp = new Date(Date.now() - 7200000);
      engine.recordInvocation(oldRecord);

      const stats = engine.analyzeFunction('func1');
      expect(stats).toBeNull();
    });

    it('should return resource usage stats', () => {
      for (let i = 0; i < 5; i++) {
        engine.recordInvocation(createCostRecord('func1', 100 + i * 10));
      }

      const stats = engine.analyzeFunction('func1');
      expect(stats).not.toBeNull();
      expect(stats!.totalInvocations).toBe(5);
      expect(stats!.avgDurationMs).toBe(120);
    });
  });

  describe('getRecommendations', () => {
    it('should return empty array for unknown function', () => {
      const funcDef = createMockFunction('unknown');
      const recs = engine.getRecommendations(funcDef);
      expect(recs).toHaveLength(0);
    });

    it('should return array for known function with records', () => {
      for (let i = 0; i < 10; i++) {
        engine.recordInvocation(createCostRecord('func1'));
      }

      const funcDef = createMockFunction('func1', '1000m', '1024Mi');
      const recs = engine.getRecommendations(funcDef);

      expect(Array.isArray(recs)).toBe(true);
    });
  });

  describe('analyzeRightSizing', () => {
    it('should not recommend right-sizing for high utilization', () => {
      const funcDef = createMockFunction('func1', '100m', '128Mi');
      const stats: ResourceUsageStats = {
        avgCPUUtilization: 0.8,
        avgMemoryUtilization: 0.8,
        avgDurationMs: 100,
        totalInvocations: 100,
      };

      const rec = (
        engine as unknown as {
          analyzeRightSizing(
            funcDef: FunctionDefinition,
            stats: ResourceUsageStats,
          ): CostOptimizationRecommendation | null;
        }
      ).analyzeRightSizing(funcDef, stats);
      expect(rec).toBeNull();
    });
  });

  describe('analyzePoolSize', () => {
    it('should not recommend pool resize for high utilization', () => {
      const funcDef = createMockFunction('func1', '100m', '128Mi', 2, 5);
      const stats: ResourceUsageStats = {
        avgCPUUtilization: 0.8,
        avgMemoryUtilization: 0.8,
        avgDurationMs: 100,
        totalInvocations: 100,
      };

      const rec = (
        engine as unknown as {
          analyzePoolSize(
            funcDef: FunctionDefinition,
            stats: ResourceUsageStats,
          ): CostOptimizationRecommendation | null;
        }
      ).analyzePoolSize(funcDef, stats);
      expect(rec).toBeNull();
    });

    it('should not recommend pool resize when min size is 1', () => {
      const funcDef = createMockFunction('func1', '100m', '128Mi', 1, 5);
      const stats: ResourceUsageStats = {
        avgCPUUtilization: 0.2,
        avgMemoryUtilization: 0.2,
        avgDurationMs: 100,
        totalInvocations: 100,
      };

      const rec = (
        engine as unknown as {
          analyzePoolSize(
            funcDef: FunctionDefinition,
            stats: ResourceUsageStats,
          ): CostOptimizationRecommendation | null;
        }
      ).analyzePoolSize(funcDef, stats);
      expect(rec).toBeNull();
    });
  });

  describe('estimateMonthlyCost', () => {
    it('should estimate monthly cost', () => {
      const funcDef = createMockFunction('func1', '100m', '128Mi', 1, 2);
      const monthlyCost = engine.estimateMonthlyCost(funcDef);

      expect(monthlyCost).toBeGreaterThan(0);
      expect(typeof monthlyCost).toBe('number');
    });
  });

  describe('estimateHourlyCost', () => {
    it('should estimate hourly cost based on resources', () => {
      const funcDef = createMockFunction('func1', '100m', '128Mi', 1, 2);
      const hourlyCost = engine.estimateHourlyCost(funcDef);

      expect(hourlyCost).toBeGreaterThan(0);
    });

    it('should scale with pool size', () => {
      const smallPool = createMockFunction('func1', '100m', '128Mi', 1, 1);
      const largePool = createMockFunction('func2', '100m', '128Mi', 5, 10);

      const smallCost = engine.estimateHourlyCost(smallPool);
      const largeCost = engine.estimateHourlyCost(largePool);

      expect(largeCost).toBeGreaterThan(smallCost);
    });
  });

  describe('parseCPU', () => {
    it('should parse millicpu', () => {
      expect(engine.parseCPU('100m')).toBe(0.1);
      expect(engine.parseCPU('500m')).toBe(0.5);
    });

    it('should parse whole CPU', () => {
      expect(engine.parseCPU('1')).toBe(1);
      expect(engine.parseCPU('2')).toBe(2);
    });
  });

  describe('parseMemory', () => {
    it('should parse Mi', () => {
      expect(engine.parseMemory('128Mi')).toBe(128);
      expect(engine.parseMemory('256Mi')).toBe(256);
    });

    it('should parse Gi', () => {
      expect(engine.parseMemory('1Gi')).toBe(1024);
      expect(engine.parseMemory('2Gi')).toBe(2048);
    });
  });

  describe('getAllRecommendations', () => {
    it('should return recommendations for multiple functions', () => {
      for (let i = 0; i < 10; i++) {
        engine.recordInvocation(createCostRecord('func1'));
        engine.recordInvocation(createCostRecord('func2'));
      }

      const funcDefs = [
        createMockFunction('func1', '1000m', '1024Mi'),
        createMockFunction('func2', '1000m', '1024Mi'),
      ];

      const allRecs = engine.getAllRecommendations(funcDefs);
      expect(Array.isArray(allRecs)).toBe(true);
    });

    it('should sort by savings percent descending', () => {
      for (let i = 0; i < 10; i++) {
        engine.recordInvocation(createCostRecord('func1'));
        engine.recordInvocation(createCostRecord('func2'));
      }

      const funcDefs = [
        createMockFunction('func1', '2000m', '2048Mi'),
        createMockFunction('func2', '500m', '256Mi'),
      ];

      const allRecs = engine.getAllRecommendations(funcDefs);

      for (let i = 1; i < allRecs.length; i++) {
        expect(allRecs[i - 1].savingsPercent).toBeGreaterThanOrEqual(allRecs[i].savingsPercent);
      }
    });
  });

  describe('getTotalPotentialSavings', () => {
    it('should calculate total potential savings', () => {
      for (let i = 0; i < 10; i++) {
        engine.recordInvocation(createCostRecord('func1'));
      }

      const funcDefs = [createMockFunction('func1', '1000m', '1024Mi')];
      const savings = engine.getTotalPotentialSavings(funcDefs);

      expect(savings).toBeGreaterThanOrEqual(0);
    });
  });

  describe('clearHistory', () => {
    it('should clear history for specific function', () => {
      engine.recordInvocation(createCostRecord('func1'));
      engine.recordInvocation(createCostRecord('func2'));

      engine.clearHistory('func1');

      expect(
        (engine as unknown as { costHistory: Map<string, CostRecord[]> }).costHistory.get('func1'),
      ).toBeUndefined();
      expect(
        (engine as unknown as { costHistory: Map<string, CostRecord[]> }).costHistory.get('func2'),
      ).toHaveLength(1);
    });

    it('should clear all history when no function specified', () => {
      engine.recordInvocation(createCostRecord('func1'));
      engine.recordInvocation(createCostRecord('func2'));

      engine.clearHistory();

      expect(
        (engine as unknown as { costHistory: Map<string, CostRecord[]> }).costHistory.size,
      ).toBe(0);
    });
  });
});
