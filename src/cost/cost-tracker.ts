import { logger } from '../observability/logger.js';
import type { CostRecord, CostBreakdown } from '../types/index.js';

/** Internal cost rate configuration */
export interface CostRateConfig {
  cpuCostPerMs: number;
  memoryCostPerMs: number;
  networkCostPerMB: number;
  queueCostPerRequest: number;
}

/**
 * Cost Tracker - calculates and tracks per-invocation costs
 */
export class CostTracker {
  private config: CostRateConfig;
  private records: CostRecord[] = [];
  private dailyTotal: number = 0;
  private dailyResetDate: string = new Date().toDateString();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: CostRateConfig) {
    this.config = config;
    this.cleanupTimer = setInterval(() => this.cleanupOldRecords(), 5 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Calculate cost for an invocation
   */
  calculateCost(params: {
    durationMs: number;
    cpu: string;
    memory: string;
    networkBytes?: number;
    isQueueTrigger?: boolean;
  }): CostBreakdown {
    // Parse resource values
    const cpuMs = this.parseCPU(params.cpu) * params.durationMs;
    const memoryMs = this.parseMemory(params.memory) * params.durationMs;

    const compute = cpuMs * this.config.cpuCostPerMs + memoryMs * this.config.memoryCostPerMs;
    const network = ((params.networkBytes ?? 0) / (1024 * 1024)) * this.config.networkCostPerMB;
    const queue = params.isQueueTrigger ? this.config.queueCostPerRequest : 0;

    return { compute, network, queue };
  }

  /**
   * Parse CPU string to numeric value (e.g., "250m" -> 0.25)
   */
  private parseCPU(cpu: string): number {
    if (cpu.endsWith('m')) {
      const val = parseFloat(cpu.slice(0, -1));
      if (isNaN(val)) {
        logger.warn({ cpu }, 'Failed to parse CPU value, returning 0');
        return 0;
      }
      return val / 1000;
    }
    const val = parseFloat(cpu);
    if (isNaN(val)) {
      logger.warn({ cpu }, 'Failed to parse CPU value, returning 0');
      return 0;
    }
    return val;
  }

  /**
   * Parse memory string to numeric value in Mi (e.g., "256Mi" -> 256)
   */
  private parseMemory(memory: string): number {
    const lower = memory.toLowerCase();
    if (lower.endsWith('ki')) {
      const val = parseFloat(memory.slice(0, -2));
      if (isNaN(val)) {
        logger.warn({ memory }, 'Failed to parse memory value, returning 0');
        return 0;
      }
      return val / 1024;
    }
    if (lower.endsWith('mi')) {
      const val = parseFloat(memory.slice(0, -2));
      if (isNaN(val)) {
        logger.warn({ memory }, 'Failed to parse memory value, returning 0');
        return 0;
      }
      return val;
    }
    if (lower.endsWith('gi')) {
      const val = parseFloat(memory.slice(0, -2));
      if (isNaN(val)) {
        logger.warn({ memory }, 'Failed to parse memory value, returning 0');
        return 0;
      }
      return val * 1024;
    }
    if (lower.endsWith('ti')) {
      const val = parseFloat(memory.slice(0, -2));
      if (isNaN(val)) {
        logger.warn({ memory }, 'Failed to parse memory value, returning 0');
        return 0;
      }
      return val * 1024 * 1024;
    }
    const val = parseFloat(memory);
    if (isNaN(val)) {
      logger.warn({ memory }, 'Failed to parse memory value, returning 0');
      return 0;
    }
    return val;
  }

  /**
   * Record a cost entry
   */
  recordCost(record: Omit<CostRecord, 'id' | 'timestamp'>): CostRecord {
    // Check daily reset
    const today = new Date().toDateString();
    if (today !== this.dailyResetDate) {
      this.dailyTotal = 0;
      this.dailyResetDate = today;
    }

    const costRecord: CostRecord = {
      ...record,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };

    this.records.push(costRecord);
    this.dailyTotal += record.cost_usd;

    logger.debug(
      { function: record.function, cost_usd: record.cost_usd, daily_total: this.dailyTotal },
      'Cost recorded',
    );

    return costRecord;
  }

  /**
   * Get daily total cost
   */
  getDailyTotal(): number {
    // Check daily reset
    const today = new Date().toDateString();
    if (today !== this.dailyResetDate) {
      this.dailyTotal = 0;
      this.dailyResetDate = today;
    }
    return this.dailyTotal;
  }

  /**
   * Get cost records for a function
   */
  getFunctionCosts(functionName: string, limit?: number): CostRecord[] {
    const records = this.records.filter((r) => r.function === functionName);
    if (limit) {
      return records.slice(-limit);
    }
    return records;
  }

  /**
   * Get total cost across all functions
   */
  getTotalCost(): number {
    return this.records.reduce((sum, r) => sum + r.cost_usd, 0);
  }

  /**
   * Clear old records (keep last 24 hours)
   */
  cleanupOldRecords(): void {
    const oneDayAgo = Date.now() - 86400000;
    this.records = this.records.filter((r) => r.timestamp.getTime() > oneDayAgo);
    const today = new Date().toDateString();
    if (today !== this.dailyResetDate) {
      this.dailyTotal = 0;
      this.dailyResetDate = today;
    } else {
      this.dailyTotal = this.records.reduce((sum, r) => sum + r.cost_usd, 0);
    }
    logger.info({ remaining_records: this.records.length }, 'Cleaned up old cost records');
  }
}
