import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CostReporting } from '../../../src/cost/reporting.js';
import type { CostRecord } from '../../../src/types/index.js';
import type { ExportFormat } from '../../../src/cost/reporting.js';

vi.mock('../../../src/observability/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('CostReporting', () => {
  let reporting: CostReporting;

  const createCostRecord = (functionName: string, cost: number, timestamp: Date): CostRecord => ({
    id: `rec-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    function: functionName,
    request_id: `req-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp,
    cost_usd: cost,
    duration_ms: 100,
    pod_id: `pod-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    breakdown: { compute: cost * 0.8, network: cost * 0.1, queue: cost * 0.1 },
  });

  beforeEach(() => {
    reporting = new CostReporting();
  });

  describe('setBudgetLimit', () => {
    it('should set budget limit', () => {
      reporting.setBudgetLimit(100);
      expect((reporting as unknown as { budgetLimit: number }).budgetLimit).toBe(100);
    });
  });

  describe('addRecord / addRecords', () => {
    it('should add single record', () => {
      const record = createCostRecord('func1', 0.01, new Date());
      reporting.addRecord(record);
      expect((reporting as unknown as { records: CostRecord[] }).records).toHaveLength(1);
    });

    it('should add multiple records', () => {
      const records = [
        createCostRecord('func1', 0.01, new Date()),
        createCostRecord('func2', 0.02, new Date()),
      ];
      reporting.addRecords(records);
      expect((reporting as unknown as { records: CostRecord[] }).records).toHaveLength(2);
    });
  });

  describe('generateReport', () => {
    it('should generate report for date range', () => {
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-01-31');
      const record1 = createCostRecord('func1', 0.01, new Date('2024-01-10'));
      const record2 = createCostRecord('func1', 0.02, new Date('2024-01-15'));

      reporting.addRecords([record1, record2]);
      const report = reporting.generateReport(startDate, endDate);

      expect(report.totalCost).toBe(0.03);
      expect(report.byFunction).toHaveLength(1);
      expect(report.byDay).toHaveLength(2);
    });

    it('should filter by function name', () => {
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-01-31');
      reporting.addRecords([
        createCostRecord('func1', 0.01, new Date('2024-01-10')),
        createCostRecord('func2', 0.02, new Date('2024-01-15')),
      ]);

      const report = reporting.generateReport(startDate, endDate, 'func1');

      expect(report.totalCost).toBe(0.01);
      expect(report.byFunction).toHaveLength(1);
      expect(report.byFunction[0].functionName).toBe('func1');
    });

    it('should calculate budget percent used', () => {
      reporting.setBudgetLimit(100);
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-01-31');
      reporting.addRecords([
        createCostRecord('func1', 10, new Date('2024-01-10')),
        createCostRecord('func2', 20, new Date('2024-01-15')),
      ]);

      const report = reporting.generateReport(startDate, endDate);

      expect(report.budgetLimit).toBe(100);
      expect(report.budgetUsed).toBe(30);
      expect(report.budgetPercentUsed).toBe(30);
    });

    it('should handle empty records', () => {
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-01-31');
      const report = reporting.generateReport(startDate, endDate);

      expect(report.totalCost).toBe(0);
      expect(report.byFunction).toHaveLength(0);
      expect(report.byDay).toHaveLength(0);
    });
  });

  describe('aggregateByFunction', () => {
    it('should aggregate costs by function', () => {
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-01-31');
      reporting.addRecords([
        createCostRecord('func1', 0.01, new Date('2024-01-10')),
        createCostRecord('func1', 0.02, new Date('2024-01-11')),
        createCostRecord('func2', 0.03, new Date('2024-01-12')),
      ]);

      const report = reporting.generateReport(startDate, endDate);

      expect(report.byFunction).toHaveLength(2);
      const func1 = report.byFunction.find(f => f.functionName === 'func1');
      expect(func1?.totalCost).toBe(0.03);
      expect(func1?.invocationCount).toBe(2);
      expect(func1?.avgCostPerInvocation).toBe(0.015);
    });

    it('should calculate percent of total', () => {
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-01-31');
      reporting.addRecords([
        createCostRecord('func1', 25, new Date('2024-01-10')),
        createCostRecord('func2', 75, new Date('2024-01-11')),
      ]);

      const report = reporting.generateReport(startDate, endDate);

      const func1 = report.byFunction.find(f => f.functionName === 'func1');
      const func2 = report.byFunction.find(f => f.functionName === 'func2');
      expect(func1?.percentOfTotal).toBe(25);
      expect(func2?.percentOfTotal).toBe(75);
    });
  });

  describe('forecastCosts', () => {
    it('should return zero forecast with insufficient data', () => {
      const forecast = reporting.forecastCosts(7);
      expect(forecast.projectedDaily).toBe(0);
      expect(forecast.confidence).toBe(0);
    });

    it('should forecast costs based on recent records', () => {
      const now = Date.now();
      for (let i = 0; i < 7; i++) {
        const date = new Date(now - i * 24 * 60 * 60 * 1000);
        reporting.addRecord(createCostRecord('func1', 10, date));
      }

      const forecast = reporting.forecastCosts(7);

      expect(forecast.projectedDaily).toBe(10);
      expect(forecast.projectedWeekly).toBe(70);
      expect(forecast.projectedMonthly).toBe(300);
      expect(forecast.trend).toBe('stable');
    });

    it('should detect increasing trend', () => {
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        reporting.addRecord(createCostRecord('func1', 5, new Date(now - (7 + i) * 24 * 60 * 60 * 1000)));
      }
      for (let i = 0; i < 3; i++) {
        reporting.addRecord(createCostRecord('func1', 15, new Date(now - i * 24 * 60 * 60 * 1000)));
      }

      const forecast = reporting.forecastCosts(7);
      expect(forecast.trend).toBe('increasing');
    });

    it('should detect decreasing trend', () => {
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        reporting.addRecord(createCostRecord('func1', 15, new Date(now - (7 + i) * 24 * 60 * 60 * 1000)));
      }
      for (let i = 0; i < 3; i++) {
        reporting.addRecord(createCostRecord('func1', 5, new Date(now - i * 24 * 60 * 60 * 1000)));
      }

      const forecast = reporting.forecastCosts(7);
      expect(forecast.trend).toBe('decreasing');
    });
  });

  describe('exportReport', () => {
    beforeEach(() => {
      const now = Date.now();
      reporting.addRecords([
        createCostRecord('func1', 0.01, new Date(now - 2 * 24 * 60 * 60 * 1000)),
        createCostRecord('func1', 0.02, new Date(now - 1 * 24 * 60 * 60 * 1000)),
      ]);
    });

    it('should export as JSON', () => {
      const result = reporting.exportReport({ type: 'json', includeRawData: false });
      expect(result).toContain('"totalCost"');
      expect(result).toContain('"byFunction"');
    });

    it('should export JSON with raw data', () => {
      const result = reporting.exportReport({ type: 'json', includeRawData: true });
      expect(result).toContain('"rawData"');
    });

    it('should export as CSV', () => {
      const result = reporting.exportReport({ type: 'csv', includeRawData: false });
      expect(result).toContain('Date,Function,TotalCost');
      expect(result).toContain('func1');
    });

    it('should export as Prometheus format', () => {
      const result = reporting.exportReport({ type: 'prometheus', includeRawData: false });
      expect(result).toContain('# HELP faas_cost_total');
      expect(result).toContain('# TYPE faas_cost_total counter');
      expect(result).toContain('faas_cost_total');
    });

    it('should default to JSON for unknown format', () => {
      const result = reporting.exportReport({ type: 'unknown' as unknown as ExportFormat['type'], includeRawData: false });
      expect(result).toContain('"totalCost"');
    });
  });

  describe('comparePeriods', () => {
    it('should compare two periods with data', () => {
      const now = Date.now();
      reporting.addRecords([
        createCostRecord('func1', 10, new Date(now - 12 * 24 * 60 * 60 * 1000)),
        createCostRecord('func1', 10, new Date(now - 11 * 24 * 60 * 60 * 1000)),
        createCostRecord('func1', 5, new Date(now - 2 * 24 * 60 * 60 * 1000)),
        createCostRecord('func1', 5, new Date(now - 1 * 24 * 60 * 60 * 1000)),
      ]);

      const result = reporting.comparePeriods(
        new Date(now - 3 * 24 * 60 * 60 * 1000),
        new Date(now - 1 * 24 * 60 * 60 * 1000),
        new Date(now - 12 * 24 * 60 * 60 * 1000),
        new Date(now - 10 * 24 * 60 * 60 * 1000),
      );

      expect(result.previousTotal).toBe(20);
      expect(result.currentTotal).toBe(10);
    });

    it('should handle zero previous total', () => {
      const result = reporting.comparePeriods(
        new Date(),
        new Date(),
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        new Date(Date.now() - 25 * 24 * 60 * 60 * 1000),
      );

      expect(result.changePercent).toBe(0);
    });
  });

  describe('cleanupOldRecords', () => {
    it('should remove old records', () => {
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      const recentDate = new Date();

      reporting.addRecords([
        createCostRecord('func1', 0.01, oldDate),
        createCostRecord('func2', 0.02, recentDate),
      ]);

      const removed = reporting.cleanupOldRecords(30 * 24 * 60 * 60 * 1000);

      expect(removed).toBe(1);
      expect((reporting as unknown as { records: CostRecord[] }).records).toHaveLength(1);
    });

    it('should return 0 when no records removed', () => {
      reporting.addRecord(createCostRecord('func1', 0.01, new Date()));
      const removed = reporting.cleanupOldRecords();
      expect(removed).toBe(0);
    });
  });
});