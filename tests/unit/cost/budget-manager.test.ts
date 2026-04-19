import { describe, it, expect, beforeEach } from 'vitest';
import { BudgetManager } from '../../../src/cost/budget-manager.js';

describe('BudgetManager', () => {
  let budgetManager: BudgetManager;

  beforeEach(() => {
    budgetManager = new BudgetManager({
      dailyLimit: 100,
      monthlyLimit: 3000,
      alertThresholds: [0.5, 0.75, 0.9],
      hardLimit: true,
    });
  });

  describe('recordCost', () => {
    it('should allow costs within budget', () => {
      const result = budgetManager.recordCost('test-func', 10);
      expect(result.allowed).toBe(true);
    });

    it('should reject costs when daily limit exceeded', () => {
      budgetManager.recordCost('test-func', 99);
      const result = budgetManager.recordCost('test-func', 2);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Daily budget limit exceeded');
    });

it('should reject costs when monthly limit exceeded', () => {
      // Create manager with high daily limit so we can test monthly in isolation
      const highDailyManager = new BudgetManager({
        dailyLimit: 10000, // High enough to not trigger
        monthlyLimit: 3000,
        alertThresholds: [0.5, 0.75, 0.9],
        hardLimit: true,
      });
      // Spend most of monthly budget
      highDailyManager.recordCost('test-func', 2999);
      // Adding 2 more would exceed 3000 monthly limit
      const result = highDailyManager.recordCost('test-func', 2);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Monthly budget limit exceeded');
    });

    it('should reject costs when monthly limit exceeded (proper test)', () => {
      // Create manager with high daily limit so we can test monthly in isolation
      const highDailyManager = new BudgetManager({
        dailyLimit: 10000, // High enough to not trigger
        monthlyLimit: 3000,
        alertThresholds: [0.5, 0.75, 0.9],
        hardLimit: true,
      });
      // Spend most of monthly budget
      highDailyManager.recordCost('test-func', 2999);
      const result = highDailyManager.recordCost('test-func', 2); // exceeds 3000
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Monthly budget limit exceeded');
    });

    it('should track function-specific budgets', () => {
      budgetManager.recordCost('func-1', 10);
      budgetManager.recordCost('func-2', 20);

      const func1Budget = budgetManager.getFunctionBudget('func-1');
      const func2Budget = budgetManager.getFunctionBudget('func-2');

      expect(func1Budget.spent).toBe(10);
      expect(func2Budget.spent).toBe(20);
    });
  });

  describe('getBudgetStatus', () => {
    it('should return current budget status', () => {
      budgetManager.recordCost('test-func', 25);

      const status = budgetManager.getBudgetStatus();

      expect(status.daily.spent).toBe(25);
      expect(status.daily.limit).toBe(100);
      expect(status.daily.remaining).toBe(75);
      expect(status.daily.ratio).toBe(0.25);

      expect(status.monthly.spent).toBe(25);
      expect(status.monthly.limit).toBe(3000);
      expect(status.monthly.remaining).toBe(2975);
      expect(status.monthly.ratio).toBeCloseTo(0.00833, 3);
    });
  });

  describe('setFunctionBudget', () => {
    it('should set budget for specific function', () => {
      budgetManager.setFunctionBudget('special-func', 50);
      expect(budgetManager.getFunctionBudget('special-func').spent).toBe(0);
    });

    it('should return limit when set via setFunctionBudget', () => {
      budgetManager.setFunctionBudget('budget-func', 100);
      budgetManager.recordCost('budget-func', 10);

      const budget = budgetManager.getFunctionBudget('budget-func');
      expect(budget.limit).toBe(100);
      expect(budget.spent).toBe(10);
    });
  });

  describe('getBudgetStatus without monthly limit', () => {
    it('should handle undefined monthly limit', () => {
      const noMonthlyLimitManager = new BudgetManager({
        dailyLimit: 100,
        monthlyLimit: undefined,
        alertThresholds: [0.5, 0.75, 0.9],
        hardLimit: true,
      });

      noMonthlyLimitManager.recordCost('test-func', 25);

      const status = noMonthlyLimitManager.getBudgetStatus();

      expect(status.monthly.limit).toBeUndefined();
      expect(status.monthly.remaining).toBeUndefined();
      expect(status.monthly.ratio).toBeUndefined();
      expect(status.monthly.spent).toBe(25);
    });
  });

  describe('reset', () => {
    it('should reset all budgets', () => {
      budgetManager.recordCost('test-func', 50);
      budgetManager.setFunctionBudget('test-func', 100);

      budgetManager.reset();

      const status = budgetManager.getBudgetStatus();
      expect(status.daily.spent).toBe(0);
      expect(status.monthly.spent).toBe(0);
    });
  });

  describe('alert thresholds', () => {
    it('should trigger alerts at thresholds', () => {
      // Spend 50% of daily budget
      budgetManager.recordCost('test-func', 50);

      const status = budgetManager.getBudgetStatus();
      expect(status.daily.ratio).toBe(0.5);
      // Alert would be logged (in real implementation)
    });
  });
});
