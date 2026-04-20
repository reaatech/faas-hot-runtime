import type { CostRecord, FunctionDefinition } from '../types/index.js';
import { logger } from '../observability/logger.js';

export interface OptimizationConfig {
  targetUtilization: number;
  minCostImprovementPercent: number;
  analysisWindowMs: number;
  autoResizeEnabled: boolean;
  costPerPodHour?: number;
}

export interface CostOptimizationRecommendation {
  functionName: string;
  type: 'right_size' | 'pool_resize' | 'schedule' | 'spot_instance';
  currentCost: number;
  projectedCost: number;
  savingsPercent: number;
  reasoning: string;
  action: string;
}

export interface ResourceUsageStats {
  avgCPUUtilization: number;
  avgMemoryUtilization: number;
  avgDurationMs: number;
  totalInvocations: number;
}

export interface UtilizationRecord {
  functionName: string;
  timestamp: Date;
  cpuUtilization: number;
  memoryUtilization: number;
  invocationsPerMinute: number;
}

export interface SchedulePattern {
  hour: number;
  dayOfWeek: number;
  avgInvocations: number;
  avgDurationMs: number;
  isHighTraffic: boolean;
}

export class OptimizationEngine {
  private config: OptimizationConfig;
  private costHistory: Map<string, CostRecord[]> = new Map();
  private utilizationHistory: Map<string, UtilizationRecord[]> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<OptimizationConfig> = {}) {
    this.config = {
      targetUtilization: config.targetUtilization ?? 0.7,
      minCostImprovementPercent: config.minCostImprovementPercent ?? 10,
      analysisWindowMs: config.analysisWindowMs ?? 3600000,
      autoResizeEnabled: config.autoResizeEnabled ?? false,
      costPerPodHour: config.costPerPodHour ?? 0.05,
    };
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  cleanup(): void {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [fn, records] of this.costHistory.entries()) {
      const filtered = records.filter((r) => r.timestamp.getTime() > cutoff);
      this.costHistory.set(fn, filtered);
    }
    for (const [fn, records] of this.utilizationHistory.entries()) {
      const filtered = records.filter((r) => r.timestamp.getTime() > cutoff);
      this.utilizationHistory.set(fn, filtered);
    }
    logger.info('Cleaned up optimization engine history');
  }

  recordInvocation(record: CostRecord): void {
    const history = this.costHistory.get(record.function) || [];
    history.push(record);
    this.costHistory.set(record.function, history);
  }

  recordUtilization(record: UtilizationRecord): void {
    const history = this.utilizationHistory.get(record.functionName) || [];
    history.push(record);
    this.utilizationHistory.set(record.functionName, history);
  }

  analyzeFunction(functionName: string): ResourceUsageStats | null {
    const history = this.costHistory.get(functionName);
    const utilizationHistory = this.utilizationHistory.get(functionName);

    if (
      (!history || history.length === 0) &&
      (!utilizationHistory || utilizationHistory.length === 0)
    ) {
      return null;
    }

    const cutoff = Date.now() - this.config.analysisWindowMs;
    const recentRecords = history?.filter((r) => r.timestamp.getTime() > cutoff) || [];
    const recentUtilization =
      utilizationHistory?.filter((r) => r.timestamp.getTime() > cutoff) || [];

    if (recentRecords.length === 0 && recentUtilization.length === 0) {
      return null;
    }

    const totalDuration = recentRecords.reduce((sum, r) => sum + r.duration_ms, 0);
    const avgDurationMs = recentRecords.length > 0 ? totalDuration / recentRecords.length : 0;

    let avgCPUUtilization = 0.5;
    let avgMemoryUtilization = 0.5;

    if (recentUtilization.length > 0) {
      avgCPUUtilization =
        recentUtilization.reduce((sum, r) => sum + r.cpuUtilization, 0) / recentUtilization.length;
      avgMemoryUtilization =
        recentUtilization.reduce((sum, r) => sum + r.memoryUtilization, 0) /
        recentUtilization.length;
    }

    return {
      avgCPUUtilization: Math.min(avgCPUUtilization, 1),
      avgMemoryUtilization: Math.min(avgMemoryUtilization, 1),
      avgDurationMs,
      totalInvocations: recentRecords.length,
    };
  }

  getRecommendations(functionDef: FunctionDefinition): CostOptimizationRecommendation[] {
    const recommendations: CostOptimizationRecommendation[] = [];

    const stats = this.analyzeFunction(functionDef.name);
    if (!stats) {
      return recommendations;
    }

    const rightSizeRec = this.analyzeRightSizing(functionDef, stats);
    if (rightSizeRec) {
      recommendations.push(rightSizeRec);
    }

    const poolRec = this.analyzePoolSize(functionDef, stats);
    if (poolRec) {
      recommendations.push(poolRec);
    }

    const scheduleRec = this.analyzeScheduling(functionDef, stats);
    if (scheduleRec) {
      recommendations.push(scheduleRec);
    }

    return recommendations;
  }

  private analyzeRightSizing(
    functionDef: FunctionDefinition,
    stats: ResourceUsageStats,
  ): CostOptimizationRecommendation | null {
    const cpuUsage = stats.avgCPUUtilization;
    const memoryUsage = stats.avgMemoryUtilization;

    if (cpuUsage < 0.3 || memoryUsage < 0.3) {
      const cpu = this.parseCPU(functionDef.container.resources.cpu);
      const memory = this.parseMemory(functionDef.container.resources.memory);

      const safeCpuUsage = cpuUsage > 0 ? cpuUsage : 0.01;
      const safeMemoryUsage = memoryUsage > 0 ? memoryUsage : 0.01;

      const targetCPU = cpu * (this.config.targetUtilization / safeCpuUsage);
      const targetMemory = memory * (this.config.targetUtilization / safeMemoryUsage);

      const currentCost = this.estimateMonthlyCost(functionDef);
      const projectedCost = this.estimateMonthlyCost({
        ...functionDef,
        container: {
          ...functionDef.container,
          resources: {
            ...functionDef.container.resources,
            cpu: `${Math.max(targetCPU * 0.8, 0.1) * 1000}m`,
            memory: `${Math.max(targetMemory * 0.8, 128)}Mi`,
          },
        },
      });

      const savings = currentCost > 0 ? ((currentCost - projectedCost) / currentCost) * 100 : 0;

      if (savings >= this.config.minCostImprovementPercent) {
        return {
          functionName: functionDef.name,
          type: 'right_size',
          currentCost,
          projectedCost,
          savingsPercent: savings,
          reasoning: `CPU utilization ${(cpuUsage * 100).toFixed(0)}%, Memory utilization ${(memoryUsage * 100).toFixed(0)}%. Current resources are over-provisioned.`,
          action: `Reduce CPU to ${Math.max(targetCPU * 0.8, 0.1) * 1000}m and memory to ${Math.max(targetMemory * 0.8, 128)}Mi`,
        };
      }
    }

    return null;
  }

  private analyzePoolSize(
    functionDef: FunctionDefinition,
    stats: ResourceUsageStats,
  ): CostOptimizationRecommendation | null {
    const utilization = stats.avgCPUUtilization;
    const currentMinSize = functionDef.pool.min_size;

    if (utilization < this.config.targetUtilization && currentMinSize > 1) {
      const newMinSize = Math.max(1, Math.floor(currentMinSize * 0.5));
      const currentCost = this.estimateMonthlyCost(functionDef);

      const projectedCost = this.estimateMonthlyCost({
        ...functionDef,
        pool: {
          ...functionDef.pool,
          min_size: newMinSize,
        },
      });

      const savings = currentCost > 0 ? ((currentCost - projectedCost) / currentCost) * 100 : 0;

      if (savings >= this.config.minCostImprovementPercent) {
        return {
          functionName: functionDef.name,
          type: 'pool_resize',
          currentCost,
          projectedCost,
          savingsPercent: savings,
          reasoning: `Pool utilization ${(utilization * 100).toFixed(0)}% is below target ${(this.config.targetUtilization * 100).toFixed(0)}%. Min pool size can be reduced.`,
          action: `Reduce min pool size from ${currentMinSize} to ${newMinSize}`,
        };
      }
    }

    return null;
  }

  private analyzeScheduling(
    functionDef: FunctionDefinition,
    _stats: ResourceUsageStats,
  ): CostOptimizationRecommendation | null {
    const history = this.costHistory.get(functionDef.name);
    if (!history || history.length < 10) {
      return null;
    }

    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentRecords = history.filter((r) => r.timestamp.getTime() > cutoff);

    if (recentRecords.length < 10) {
      return null;
    }

    const patterns = this.detectSchedulePatterns(recentRecords);

    const highTrafficPeriods = patterns.filter((p) => p.isHighTraffic);
    const lowTrafficPeriods = patterns.filter((p) => !p.isHighTraffic);

    if (lowTrafficPeriods.length === 0) {
      return null;
    }

    const avgHighTrafficInvocations =
      highTrafficPeriods.length > 0
        ? highTrafficPeriods.reduce((sum, p) => sum + p.avgInvocations, 0) /
          highTrafficPeriods.length
        : 0;
    const avgLowTrafficInvocations =
      lowTrafficPeriods.reduce((sum, p) => sum + p.avgInvocations, 0) / lowTrafficPeriods.length;

    if (
      avgHighTrafficInvocations === 0 ||
      avgLowTrafficInvocations >= avgHighTrafficInvocations * 0.5
    ) {
      return null;
    }

    const reductionRatio = avgLowTrafficInvocations / avgHighTrafficInvocations;
    const peakMinSize = functionDef.pool.min_size;
    const offPeakMinSize = Math.max(1, Math.floor(peakMinSize * reductionRatio));

    if (offPeakMinSize >= peakMinSize) {
      return null;
    }

    const currentCost = this.estimateMonthlyCost(functionDef);
    const offPeakHoursPerDay = lowTrafficPeriods.length;

    const savingsPerDay =
      (peakMinSize - offPeakMinSize) *
      (this.config.costPerPodHour ?? 0.05) *
      (offPeakHoursPerDay / 24);
    const monthlySavings = savingsPerDay * 30;

    const projectedCost = currentCost - monthlySavings;

    const lowestTrafficHour = lowTrafficPeriods.sort(
      (a, b) => a.avgInvocations - b.avgInvocations,
    )[0];
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    return {
      functionName: functionDef.name,
      type: 'schedule',
      currentCost,
      projectedCost,
      savingsPercent: currentCost > 0 ? (monthlySavings / currentCost) * 100 : 0,
      reasoning: `Traffic pattern detected: high traffic avg ${avgHighTrafficInvocations.toFixed(1)} invocations/hr during peak, ${avgLowTrafficInvocations.toFixed(1)} invocations/hr during off-peak. Scheduled scaling can reduce costs during low-traffic periods.`,
      action: `Reduce min pool size from ${peakMinSize} to ${offPeakMinSize} during ${dayNames[lowestTrafficHour.dayOfWeek]} ${lowestTrafficHour.hour}:00-${lowestTrafficHour.hour + 1}:00 when traffic is lowest (${lowestTrafficHour.avgInvocations.toFixed(1)} invocations/hr)`,
    };
  }

  private detectSchedulePatterns(records: CostRecord[]): SchedulePattern[] {
    const hourlyData: Map<string, { count: number; totalDuration: number; dayOfWeek: number }> =
      new Map();

    for (const record of records) {
      const date = new Date(record.timestamp);
      const hour = date.getHours();
      const dayOfWeek = date.getDay();
      const key = `${dayOfWeek}-${hour}`;

      const existing = hourlyData.get(key) || { count: 0, totalDuration: 0, dayOfWeek };
      existing.count += 1;
      existing.totalDuration += record.duration_ms;
      hourlyData.set(key, existing);
    }

    const timeSpanMs =
      records.length > 1
        ? new Date(records[records.length - 1].timestamp).getTime() -
          new Date(records[0].timestamp).getTime()
        : 0;
    const numWeeks = timeSpanMs > 0 ? timeSpanMs / (7 * 24 * 60 * 60 * 1000) : 1;

    let globalAvgInvocations = 0;

    for (const [_key, data] of hourlyData.entries()) {
      globalAvgInvocations += data.count;
    }
    globalAvgInvocations /= hourlyData.size || 1;

    const patterns: SchedulePattern[] = [];

    for (const [key, data] of hourlyData.entries()) {
      const [dayOfWeek, hour] = key.split('-').map(Number);
      const avgInvocations = data.count / numWeeks;
      const avgDurationMs = data.totalDuration / data.count;

      patterns.push({
        hour,
        dayOfWeek,
        avgInvocations,
        avgDurationMs,
        isHighTraffic: avgInvocations > globalAvgInvocations * 1.5,
      });
    }

    return patterns;
  }

  getSchedulePatterns(functionName: string): SchedulePattern[] | null {
    const history = this.costHistory.get(functionName);
    if (!history || history.length < 10) {
      return null;
    }

    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentRecords = history.filter((r) => r.timestamp.getTime() > cutoff);

    if (recentRecords.length < 10) {
      return null;
    }

    return this.detectSchedulePatterns(recentRecords);
  }

  estimateMonthlyCost(functionDef: FunctionDefinition): number {
    const hourlyCost = this.estimateHourlyCost(functionDef);
    return hourlyCost * 24 * 30;
  }

  estimateHourlyCost(functionDef: FunctionDefinition): number {
    const cpu = this.parseCPU(functionDef.container.resources.cpu);
    const memory = this.parseMemory(functionDef.container.resources.memory);
    const avgPods = (functionDef.pool.min_size + functionDef.pool.max_size) / 2;

    const cpuCostPerCoreHour = 0.05;
    const memoryCostPerGiBHour = 0.01;

    const hourlyPodCost = cpu * cpuCostPerCoreHour + (memory / 1024) * memoryCostPerGiBHour;
    return hourlyPodCost * avgPods;
  }

  parseCPU(cpu: string): number {
    if (cpu.endsWith('m')) {
      return parseFloat(cpu.slice(0, -1)) / 1000;
    }
    return parseFloat(cpu);
  }

  parseMemory(memory: string): number {
    if (memory.endsWith('Mi')) {
      return parseFloat(memory.slice(0, -2));
    }
    if (memory.endsWith('Gi')) {
      return parseFloat(memory.slice(0, -2)) * 1024;
    }
    return parseFloat(memory);
  }

  getAllRecommendations(functionDefs: FunctionDefinition[]): CostOptimizationRecommendation[] {
    const allRecs: CostOptimizationRecommendation[] = [];

    for (const functionDef of functionDefs) {
      const recs = this.getRecommendations(functionDef);
      allRecs.push(...recs);
    }

    return allRecs.sort((a, b) => b.savingsPercent - a.savingsPercent);
  }

  getTotalPotentialSavings(functionDefs: FunctionDefinition[]): number {
    const recs = this.getAllRecommendations(functionDefs);
    return recs.reduce((sum, rec) => sum + (rec.currentCost - rec.projectedCost), 0);
  }

  clearHistory(functionName?: string): void {
    if (functionName) {
      this.costHistory.delete(functionName);
      this.utilizationHistory.delete(functionName);
    } else {
      this.costHistory.clear();
      this.utilizationHistory.clear();
    }
  }
}
