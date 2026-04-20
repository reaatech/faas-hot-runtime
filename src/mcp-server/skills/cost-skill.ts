import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CostReporting } from '../../cost/reporting.js';
import type { BudgetManager } from '../../cost/budget-manager.js';
import type { FunctionRegistry } from '../../registry/function-registry.js';
import type { FunctionDefinition } from '../../types/index.js';

export interface CostSkillConfig {
  reporting: CostReporting;
  budgetManager: BudgetManager;
  functionRegistry?: FunctionRegistry;
}

export interface GetCostReportParams {
  function?: string;
  range?: '1h' | '24h' | '7d' | '30d';
  granularity?: 'hourly' | 'daily' | 'monthly';
}

export interface GetBudgetStatusParams {
  function?: string;
}

export interface UpdateBudgetParams {
  function: string;
  daily_limit: number;
  alert_thresholds?: number[];
  hard_limit?: boolean;
}

export interface EstimateCostParams {
  function: string;
  input_size?: number;
  expected_duration_ms?: number;
}

export class CostSkillHandler {
  private reporting: CostReporting;
  private budgetManager: BudgetManager;
  private functionRegistry?: FunctionRegistry;

  constructor(config: CostSkillConfig) {
    this.reporting = config.reporting;
    this.budgetManager = config.budgetManager;
    this.functionRegistry = config.functionRegistry;
  }

  getTools(): Tool[] {
    return [
      {
        name: 'get_cost_report',
        description: 'Get cost report for serverless function invocations',
        inputSchema: {
          type: 'object',
          properties: {
            function: {
              type: 'string',
              description: 'Function name to get report for (optional for all functions)',
            },
            range: {
              type: 'string',
              enum: ['1h', '24h', '7d', '30d'],
              description: 'Time range for the report',
              default: '24h',
            },
            granularity: {
              type: 'string',
              enum: ['hourly', 'daily', 'monthly'],
              description: 'Report granularity',
              default: 'daily',
            },
          },
        },
      },
      {
        name: 'get_budget_status',
        description: 'Get budget status for serverless functions',
        inputSchema: {
          type: 'object',
          properties: {
            function: {
              type: 'string',
              description: 'Function name to get budget status for (optional for global)',
            },
          },
        },
      },
      {
        name: 'update_budget',
        description: 'Update budget configuration for a function',
        inputSchema: {
          type: 'object',
          properties: {
            function: {
              type: 'string',
              description: 'Function name to update budget for',
            },
            daily_limit: {
              type: 'number',
              description: 'Daily budget limit in USD',
            },
            alert_thresholds: {
              type: 'array',
              items: { type: 'number' },
              description: 'Alert thresholds (e.g., [0.5, 0.75, 0.9])',
            },
            hard_limit: {
              type: 'boolean',
              description: 'Whether to reject invocations when budget exceeded',
            },
          },
          required: ['function', 'daily_limit'],
        },
      },
      {
        name: 'estimate_cost',
        description: 'Estimate cost for a function invocation',
        inputSchema: {
          type: 'object',
          properties: {
            function: {
              type: 'string',
              description: 'Function name to estimate cost for',
            },
            input_size: {
              type: 'number',
              description: 'Estimated input size in bytes',
            },
            expected_duration_ms: {
              type: 'number',
              description: 'Expected invocation duration in milliseconds',
            },
          },
          required: ['function'],
        },
      },
    ];
  }

  async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    switch (toolName) {
      case 'get_cost_report':
        return this.getCostReport(this.validateCostReportArgs(args));
      case 'get_budget_status':
        return this.getBudgetStatus(this.validateBudgetStatusArgs(args));
      case 'update_budget':
        return this.updateBudget(this.validateUpdateBudgetArgs(args));
      case 'estimate_cost':
        return this.estimateCost(this.validateEstimateCostArgs(args));
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown cost tool: ${toolName}`);
    }
  }

  private validateCostReportArgs(args: Record<string, unknown>): GetCostReportParams {
    const result: GetCostReportParams = {};
    if (args['function'] !== undefined) {
      if (typeof args['function'] !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, 'function must be a string');
      }
      result.function = args['function'];
    }
    if (args['range'] !== undefined) {
      if (
        typeof args['range'] !== 'string' ||
        !['1h', '24h', '7d', '30d'].includes(args['range'])
      ) {
        throw new McpError(ErrorCode.InvalidParams, 'range must be one of: 1h, 24h, 7d, 30d');
      }
      result.range = args['range'] as '1h' | '24h' | '7d' | '30d';
    }
    if (args['granularity'] !== undefined) {
      if (
        typeof args['granularity'] !== 'string' ||
        !['hourly', 'daily', 'monthly'].includes(args['granularity'])
      ) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'granularity must be one of: hourly, daily, monthly',
        );
      }
      result.granularity = args['granularity'] as 'hourly' | 'daily' | 'monthly';
    }
    return result;
  }

  private validateBudgetStatusArgs(args: Record<string, unknown>): GetBudgetStatusParams {
    const result: GetBudgetStatusParams = {};
    if (args['function'] !== undefined) {
      if (typeof args['function'] !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, 'function must be a string');
      }
      result.function = args['function'];
    }
    return result;
  }

  private validateUpdateBudgetArgs(args: Record<string, unknown>): UpdateBudgetParams {
    if (typeof args['function'] !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'function is required and must be a string');
    }
    if (typeof args['daily_limit'] !== 'number' || args['daily_limit'] <= 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'daily_limit is required and must be a positive number',
      );
    }
    const result: UpdateBudgetParams = {
      function: args['function'],
      daily_limit: args['daily_limit'],
    };
    if (args['alert_thresholds'] !== undefined) {
      if (!Array.isArray(args['alert_thresholds'])) {
        throw new McpError(ErrorCode.InvalidParams, 'alert_thresholds must be an array');
      }
      result.alert_thresholds = args['alert_thresholds'] as number[];
    }
    if (args['hard_limit'] !== undefined) {
      if (typeof args['hard_limit'] !== 'boolean') {
        throw new McpError(ErrorCode.InvalidParams, 'hard_limit must be a boolean');
      }
      result.hard_limit = args['hard_limit'];
    }
    return result;
  }

  private validateEstimateCostArgs(args: Record<string, unknown>): EstimateCostParams {
    if (typeof args['function'] !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'function is required and must be a string');
    }
    const result: EstimateCostParams = { function: args['function'] };
    if (args['input_size'] !== undefined) {
      if (typeof args['input_size'] !== 'number') {
        throw new McpError(ErrorCode.InvalidParams, 'input_size must be a number');
      }
      result.input_size = args['input_size'];
    }
    if (args['expected_duration_ms'] !== undefined) {
      if (typeof args['expected_duration_ms'] !== 'number') {
        throw new McpError(ErrorCode.InvalidParams, 'expected_duration_ms must be a number');
      }
      result.expected_duration_ms = args['expected_duration_ms'];
    }
    return result;
  }

  private async getCostReport(
    params: GetCostReportParams,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const now = new Date();
    let startDate: Date;

    switch (params.range) {
      case '1h':
        startDate = new Date(now.getTime() - 60 * 60 * 1000);
        break;
      case '7d':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '24h':
      default:
        startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
    }

    const report = this.reporting.generateReport(startDate, now, params.function);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(report, null, 2),
        },
      ],
    };
  }

  private async getBudgetStatus(
    params: GetBudgetStatusParams,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (params.function) {
      const functionBudget = this.budgetManager.getFunctionBudget(params.function);
      const status = this.budgetManager.getBudgetStatus();
      const limit = functionBudget.limit ?? status.daily.limit;
      const spent = functionBudget.spent;
      const result = {
        function: params.function,
        daily_limit: limit,
        daily_spent: spent,
        remaining: Math.max(0, limit - spent),
        percentage_used: limit > 0 ? ((spent / limit) * 100).toFixed(2) : '0.00',
        alert_thresholds: status.daily.limit > 0 ? [0.5, 0.75, 0.9] : [],
      };

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    const status = this.budgetManager.getBudgetStatus();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(status, null, 2),
        },
      ],
    };
  }

  private async updateBudget(
    params: UpdateBudgetParams,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (this.functionRegistry && !this.functionRegistry.hasFunction(params.function)) {
      throw new McpError(ErrorCode.InvalidParams, `Function not found: ${params.function}`);
    }

    this.budgetManager.setFunctionBudget(params.function, params.daily_limit);

    const result = {
      status: 'success',
      function: params.function,
      budget: {
        daily_limit: params.daily_limit,
        alert_thresholds: params.alert_thresholds ?? [0.5, 0.75, 0.9],
        hard_limit: params.hard_limit ?? false,
      },
    };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  private async estimateCost(
    params: EstimateCostParams,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const functionDef = this.getFunctionDefinition(params.function);
    if (!functionDef) {
      throw new McpError(ErrorCode.InvalidParams, `Function not found: ${params.function}`);
    }

    const durationMs = params.expected_duration_ms ?? 100;
    const cpu = this.parseCPU(functionDef.container.resources.cpu);
    const memory = this.parseMemory(functionDef.container.resources.memory);

    const cpuCostPerMs = 0.05 / 1000;
    const memoryCostPerMs = 0.01 / 1000;

    const cpuMs = cpu * durationMs;
    const memoryMs = memory * durationMs;
    const computeCost = cpuMs * cpuCostPerMs + memoryMs * memoryCostPerMs;
    const networkCost = ((params.input_size ?? 1024) / (1024 * 1024)) * 0.01;
    const totalCost = computeCost + networkCost;

    const result = {
      function: params.function,
      estimated_cost_usd: totalCost.toFixed(8),
      confidence: params.expected_duration_ms ? 'medium' : 'low',
      factors: {
        compute: computeCost.toFixed(8),
        network: networkCost.toFixed(8),
        queue: '0.00000000',
      },
      based_on: {
        avg_duration_ms: params.expected_duration_ms ?? 100,
        avg_input_size: params.input_size ?? 1024,
      },
    };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  private getFunctionDefinition(name: string): FunctionDefinition | undefined {
    return this.functionRegistry?.getFunction(name);
  }

  private parseCPU(cpu: string): number {
    if (cpu.endsWith('m')) {
      return parseFloat(cpu.slice(0, -1)) / 1000;
    }
    return parseFloat(cpu);
  }

  private parseMemory(memory: string): number {
    if (memory.endsWith('Mi')) {
      return parseFloat(memory.slice(0, -2));
    }
    if (memory.endsWith('Gi')) {
      return parseFloat(memory.slice(0, -2)) * 1024;
    }
    return parseFloat(memory);
  }
}
