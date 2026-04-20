import { logger } from '../observability/logger.js';

export interface BudgetConfig {
  dailyLimit: number;
  monthlyLimit?: number;
  alertThresholds: number[];
  hardLimit: boolean;
}

interface BudgetState {
  dailySpent: number;
  monthlySpent: number;
  dailyResetDate: string;
  monthlyResetMonth: string;
  alertsTriggered: Set<number>;
}

interface FunctionBudget {
  limit?: number;
  spent: number;
}

/**
 * Budget Manager - tracks and enforces budget limits
 */
export class BudgetManager {
  private config: BudgetConfig;
  private state: BudgetState;
  private functionBudgets: Map<string, FunctionBudget> = new Map();

  constructor(config: BudgetConfig) {
    this.config = config;
    const today = new Date();
    this.state = {
      dailySpent: 0,
      monthlySpent: 0,
      dailyResetDate: today.toDateString(),
      monthlyResetMonth: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`,
      alertsTriggered: new Set(),
    };
  }

  /**
   * Record a cost and check budget limits
   * Returns true if the cost is within budget, false if exceeded
   */
  recordCost(functionName: string, costUsd: number): { allowed: boolean; reason?: string } {
    if (costUsd < 0) {
      return { allowed: false, reason: 'costUsd must be non-negative' };
    }

    this.checkDailyReset();
    this.checkMonthlyReset();

    const newDailySpent = this.state.dailySpent + costUsd;
    const newMonthlySpent = this.state.monthlySpent + costUsd;

    if (this.config.dailyLimit > 0) {
      const dailyRatio = newDailySpent / this.config.dailyLimit;
      if (dailyRatio >= 1 && this.config.hardLimit) {
        logger.warn(
          { daily_spent: this.state.dailySpent, daily_limit: this.config.dailyLimit },
          'Daily budget limit exceeded - rejecting request',
        );
        return { allowed: false, reason: 'Daily budget limit exceeded' };
      }
      if (!this.config.hardLimit && dailyRatio >= 0.9) {
        logger.warn(
          { daily_spent: newDailySpent, daily_limit: this.config.dailyLimit, ratio: dailyRatio },
          'Budget exceeds 90% of daily limit',
        );
      }
    }

    if (this.config.monthlyLimit && this.config.monthlyLimit > 0) {
      const monthlyRatio = newMonthlySpent / this.config.monthlyLimit;
      if (monthlyRatio >= 1 && this.config.hardLimit) {
        logger.warn(
          { monthly_spent: this.state.monthlySpent, monthly_limit: this.config.monthlyLimit },
          'Monthly budget limit exceeded - rejecting request',
        );
        return { allowed: false, reason: 'Monthly budget limit exceeded' };
      }
      if (!this.config.hardLimit && monthlyRatio >= 0.9) {
        logger.warn(
          {
            monthly_spent: newMonthlySpent,
            monthly_limit: this.config.monthlyLimit,
            ratio: monthlyRatio,
          },
          'Budget exceeds 90% of monthly limit',
        );
      }
    }

    this.state.dailySpent = newDailySpent;
    this.state.monthlySpent = newMonthlySpent;

    const currentBudget = this.functionBudgets.get(functionName);
    const currentFunctionSpend = currentBudget?.spent ?? 0;
    this.functionBudgets.set(functionName, {
      limit: currentBudget?.limit,
      spent: currentFunctionSpend + costUsd,
    });

    if (this.config.dailyLimit > 0) {
      const actualDailyRatio = this.state.dailySpent / this.config.dailyLimit;
      this.checkAlertThresholds(actualDailyRatio);
    }

    return { allowed: true };
  }

  /**
   * Check and reset daily spending if needed
   */
  private checkDailyReset(): void {
    const today = new Date().toDateString();
    if (today !== this.state.dailyResetDate) {
      this.state.dailySpent = 0;
      this.state.dailyResetDate = today;
      this.state.alertsTriggered.clear();
      for (const [name, budget] of this.functionBudgets.entries()) {
        this.functionBudgets.set(name, { ...budget, spent: 0 });
      }
      logger.info('Daily budget reset');
    }
  }

  /**
   * Check and reset monthly spending if needed
   */
  private checkMonthlyReset(): void {
    const today = new Date();
    const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    if (currentMonth !== this.state.monthlyResetMonth) {
      this.state.monthlySpent = 0;
      this.state.monthlyResetMonth = currentMonth;
      logger.info('Monthly budget reset');
    }
  }

  /**
   * Check alert thresholds and trigger alerts
   */
  private checkAlertThresholds(ratio: number): void {
    for (const threshold of this.config.alertThresholds) {
      if (ratio >= threshold && !this.state.alertsTriggered.has(threshold)) {
        this.state.alertsTriggered.add(threshold);
        logger.warn(
          {
            threshold: threshold * 100,
            daily_spent: this.state.dailySpent,
            daily_limit: this.config.dailyLimit,
          },
          `Budget alert: ${threshold * 100}% of daily budget consumed`,
        );
        // In a real implementation, this would send notifications
      }
    }
  }

  /**
   * Get current budget status
   */
  getBudgetStatus(): {
    daily: { spent: number; limit: number; remaining: number; ratio: number };
    monthly: {
      spent: number;
      limit: number | undefined;
      remaining: number | undefined;
      ratio: number | undefined;
    };
  } {
    this.checkDailyReset();
    this.checkMonthlyReset();

    const dailyRatio =
      this.config.dailyLimit > 0 ? this.state.dailySpent / this.config.dailyLimit : 0;

    return {
      daily: {
        spent: this.state.dailySpent,
        limit: this.config.dailyLimit,
        remaining: Math.max(0, this.config.dailyLimit - this.state.dailySpent),
        ratio: dailyRatio,
      },
      monthly: {
        spent: this.state.monthlySpent,
        limit: this.config.monthlyLimit,
        remaining: this.config.monthlyLimit
          ? Math.max(0, this.config.monthlyLimit - this.state.monthlySpent)
          : undefined,
        ratio: this.config.monthlyLimit
          ? this.state.monthlySpent / this.config.monthlyLimit
          : undefined,
      },
    };
  }

  /**
   * Get function-specific budget status
   */
  getFunctionBudget(functionName: string): { spent: number; limit?: number } {
    const budget = this.functionBudgets.get(functionName);
    return {
      spent: budget?.spent ?? 0,
      limit: budget?.limit,
    };
  }

  /**
   * Set a budget for a specific function
   */
  setFunctionBudget(functionName: string, budget: number): void {
    const currentBudget = this.functionBudgets.get(functionName);
    this.functionBudgets.set(functionName, { limit: budget, spent: currentBudget?.spent ?? 0 });
    logger.info({ function: functionName, budget }, 'Function budget set');
  }

  /**
   * Reset all budgets (for testing)
   */
  reset(): void {
    this.state.dailySpent = 0;
    this.state.monthlySpent = 0;
    this.state.alertsTriggered.clear();
    this.functionBudgets.clear();
    logger.info('Budget manager reset');
  }
}
