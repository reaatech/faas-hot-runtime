import { logger } from '../observability/logger.js';
import type { CostRecord } from '../types/index.js';

export interface CostReport {
  period: { start: Date; end: Date };
  totalCost: number;
  byFunction: FunctionCostBreakdown[];
  byDay: DailyCost[];
  byComponent: { compute: number; network: number; queue: number };
  budgetUsed: number;
  budgetLimit: number;
  budgetPercentUsed: number;
}

export interface FunctionCostBreakdown {
  functionName: string;
  totalCost: number;
  invocationCount: number;
  avgCostPerInvocation: number;
  byComponent: { compute: number; network: number; queue: number };
  percentOfTotal: number;
}

export interface DailyCost {
  date: string;
  totalCost: number;
  invocationCount: number;
  byFunction: Record<string, number>;
}

export interface CostForecast {
  projectedDaily: number;
  projectedWeekly: number;
  projectedMonthly: number;
  confidence: number;
  trend: 'increasing' | 'decreasing' | 'stable';
}

export interface ExportFormat {
  type: 'json' | 'csv' | 'prometheus';
  includeRawData: boolean;
}

export class CostReporting {
  private records: CostRecord[] = [];
  private budgetLimit: number = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupOldRecords(), 5 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  setBudgetLimit(limit: number): void {
    this.budgetLimit = limit;
  }

  addRecord(record: CostRecord): void {
    this.records.push(record);
  }

  addRecords(records: CostRecord[]): void {
    this.records.push(...records);
  }

  generateReport(startDate: Date, endDate: Date, functionName?: string): CostReport {
    const filtered = this.records.filter((r) => {
      const inRange = r.timestamp >= startDate && r.timestamp <= endDate;
      const matchesFunction = !functionName || r.function === functionName;
      return inRange && matchesFunction;
    });

    const totalCost = filtered.reduce((sum, r) => sum + r.cost_usd, 0);
    const byFunction = this.aggregateByFunction(filtered);
    const byDay = this.aggregateByDay(filtered);
    const byComponent = this.aggregateByComponent(filtered);

    const budgetPercentUsed = this.budgetLimit > 0 ? (totalCost / this.budgetLimit) * 100 : 0;

    return {
      period: { start: startDate, end: endDate },
      totalCost,
      byFunction,
      byDay,
      byComponent,
      budgetUsed: totalCost,
      budgetLimit: this.budgetLimit,
      budgetPercentUsed,
    };
  }

  private aggregateByFunction(records: CostRecord[]): FunctionCostBreakdown[] {
    const byFunc = new Map<
      string,
      { cost: number; count: number; compute: number; network: number; queue: number }
    >();

    for (const record of records) {
      const existing = byFunc.get(record.function) || {
        cost: 0,
        count: 0,
        compute: 0,
        network: 0,
        queue: 0,
      };
      existing.cost += record.cost_usd;
      existing.count += 1;
      existing.compute += record.breakdown.compute;
      existing.network += record.breakdown.network;
      existing.queue += record.breakdown.queue;
      byFunc.set(record.function, existing);
    }

    const totalCost = Array.from(byFunc.values()).reduce((sum, f) => sum + f.cost, 0);

    return Array.from(byFunc.entries())
      .map(([name, data]) => ({
        functionName: name,
        totalCost: data.cost,
        invocationCount: data.count,
        avgCostPerInvocation: data.count > 0 ? data.cost / data.count : 0,
        byComponent: {
          compute: data.compute,
          network: data.network,
          queue: data.queue,
        },
        percentOfTotal: totalCost > 0 ? (data.cost / totalCost) * 100 : 0,
      }))
      .sort((a, b) => b.totalCost - a.totalCost);
  }

  private aggregateByDay(records: CostRecord[]): DailyCost[] {
    const byDay = new Map<string, { cost: number; count: number; byFunc: Map<string, number> }>();

    for (const record of records) {
      const dateKey = record.timestamp.toISOString().split('T')[0];
      const existing = byDay.get(dateKey) || { cost: 0, count: 0, byFunc: new Map() };
      existing.cost += record.cost_usd;
      existing.count += 1;
      const funcCost = existing.byFunc.get(record.function) || 0;
      existing.byFunc.set(record.function, funcCost + record.cost_usd);
      byDay.set(dateKey, existing);
    }

    return Array.from(byDay.entries())
      .map(([date, data]) => ({
        date,
        totalCost: data.cost,
        invocationCount: data.count,
        byFunction: Object.fromEntries(data.byFunc),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private aggregateByComponent(records: CostRecord[]): {
    compute: number;
    network: number;
    queue: number;
  } {
    let compute = 0;
    let network = 0;
    let queue = 0;

    for (const record of records) {
      compute += record.breakdown.compute;
      network += record.breakdown.network;
      queue += record.breakdown.queue;
    }

    return { compute, network, queue };
  }

  forecastCosts(daysToForecast: number = 7): CostForecast {
    if (this.records.length < 2) {
      return {
        projectedDaily: 0,
        projectedWeekly: 0,
        projectedMonthly: 0,
        confidence: 0,
        trend: 'stable',
      };
    }

    const cutoff = new Date(Date.now() - daysToForecast * 24 * 60 * 60 * 1000);
    const recentRecords = this.records.filter((r) => r.timestamp >= cutoff);

    const dailyTotals = new Map<string, number>();
    for (const record of recentRecords) {
      const dateKey = record.timestamp.toISOString().split('T')[0];
      const existing = dailyTotals.get(dateKey) || 0;
      dailyTotals.set(dateKey, existing + record.cost_usd);
    }

    const values = Array.from(dailyTotals.values());
    if (values.length === 0) {
      return {
        projectedDaily: 0,
        projectedWeekly: 0,
        projectedMonthly: 0,
        confidence: 0,
        trend: 'stable',
      };
    }

    const avgDaily = values.reduce((sum, v) => sum + v, 0) / values.length;

    let trend: 'increasing' | 'decreasing' | 'stable' = 'stable';
    if (values.length >= 3) {
      const recent = values.slice(-Math.floor(values.length / 2));
      const older = values.slice(0, Math.floor(values.length / 2));
      const recentAvg = recent.reduce((sum, v) => sum + v, 0) / recent.length;
      const olderAvg = older.reduce((sum, v) => sum + v, 0) / older.length;

      if (recentAvg > olderAvg * 1.1) {
        trend = 'increasing';
      } else if (recentAvg < olderAvg * 0.9) {
        trend = 'decreasing';
      }
    }

    const confidence = Math.min(values.length / daysToForecast, 1);

    return {
      projectedDaily: avgDaily,
      projectedWeekly: avgDaily * 7,
      projectedMonthly: avgDaily * 30,
      confidence,
      trend,
    };
  }

  exportReport(format: ExportFormat, startDate?: Date, endDate?: Date): string {
    const timestamps = this.records.map((record) => record.timestamp.getTime());
    const start =
      startDate ||
      (timestamps.length > 0
        ? new Date(Math.min(...timestamps))
        : new Date(Date.now() - 24 * 60 * 60 * 1000));
    const end = endDate || (timestamps.length > 0 ? new Date(Math.max(...timestamps)) : new Date());

    const report = this.generateReport(start, end);

    switch (format.type) {
      case 'json':
        return this.exportJSON(report, format.includeRawData);
      case 'csv':
        return this.exportCSV(report);
      case 'prometheus':
        return this.exportPrometheus(report);
      default:
        return JSON.stringify(report, null, 2);
    }
  }

  private exportJSON(report: CostReport, includeRawData: boolean): string {
    const output: Record<string, unknown> = { report };
    if (includeRawData) {
      const start = report.period.start;
      const end = report.period.end;
      output.rawData = this.records.filter((r) => r.timestamp >= start && r.timestamp <= end);
    }
    return JSON.stringify(output, null, 2);
  }

  private exportCSV(report: CostReport): string {
    const lines: string[] = ['Date,Function,TotalCost,Invocations,AvgCost,Compute,Network,Queue'];

    const funcBreakdowns = new Map<string, { compute: number; network: number; queue: number }>();
    for (const func of report.byFunction) {
      funcBreakdowns.set(func.functionName, func.byComponent);
    }

    for (const day of report.byDay) {
      for (const [func, cost] of Object.entries(day.byFunction)) {
        const escapedFunc = func.startsWith('=') ? `"\t${func}"` : `"${func}"`;
        const breakdown = funcBreakdowns.get(func) ?? { compute: 0, network: 0, queue: 0 };
        lines.push(
          `${day.date},${escapedFunc},${cost.toFixed(6)},${day.invocationCount},${(cost / day.invocationCount).toFixed(6)},${breakdown.compute.toFixed(6)},${breakdown.network.toFixed(6)},${breakdown.queue.toFixed(6)}`,
        );
      }
    }

    return lines.join('\n');
  }

  private exportPrometheus(report: CostReport): string {
    const lines: string[] = [];

    lines.push(`# HELP faas_cost_total Total cost in USD`);
    lines.push(`# TYPE faas_cost_total counter`);
    lines.push(`faas_cost_total{period="daily"} ${report.totalCost}`);

    for (const func of report.byFunction) {
      lines.push(`faas_cost_function_total{function="${func.functionName}"} ${func.totalCost}`);
    }

    lines.push(`# HELP faas_cost_by_component Cost by component`);
    lines.push(`# TYPE faas_cost_by_component gauge`);
    lines.push(`faas_cost_by_component{component="compute"} ${report.byComponent.compute}`);
    lines.push(`faas_cost_by_component{component="network"} ${report.byComponent.network}`);
    lines.push(`faas_cost_by_component{component="queue"} ${report.byComponent.queue}`);

    lines.push(`# HELP faas_budget_usage Budget usage`);
    lines.push(`# TYPE faas_budget_usage gauge`);
    lines.push(`faas_budget_usage_percent ${report.budgetPercentUsed}`);

    return lines.join('\n');
  }

  comparePeriods(
    currentStart: Date,
    currentEnd: Date,
    previousStart: Date,
    previousEnd: Date,
  ): {
    currentTotal: number;
    previousTotal: number;
    changePercent: number;
    changeDirection: 'increased' | 'decreased' | 'unchanged';
  } {
    const current = this.generateReport(currentStart, currentEnd);
    const previous = this.generateReport(previousStart, previousEnd);

    const changePercent =
      previous.totalCost > 0
        ? ((current.totalCost - previous.totalCost) / previous.totalCost) * 100
        : 0;

    return {
      currentTotal: current.totalCost,
      previousTotal: previous.totalCost,
      changePercent,
      changeDirection:
        changePercent > 1 ? 'increased' : changePercent < -1 ? 'decreased' : 'unchanged',
    };
  }

  cleanupOldRecords(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    const before = this.records.length;
    this.records = this.records.filter((r) => r.timestamp.getTime() > cutoff);
    const removed = before - this.records.length;

    if (removed > 0) {
      logger.info({ removed, remaining: this.records.length }, 'Cleaned up old cost records');
    }

    return removed;
  }
}
