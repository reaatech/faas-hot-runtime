import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { PoolManager } from '../../pool-manager/pool-manager.js';

export interface WarmPoolSkillConfig {
  poolManager: PoolManager;
}

export interface GetPoolStatusParams {
  function: string;
}

export interface ScalePoolParams {
  function: string;
  min_size: number;
  max_size: number;
}

export interface GetPodHealthParams {
  function: string;
  pod_id?: string;
}

export class WarmPoolSkillHandler {
  private poolManager: PoolManager;

  constructor(config: WarmPoolSkillConfig) {
    this.poolManager = config.poolManager;
  }

  getTools(): Tool[] {
    return [
      {
        name: 'get_pool_status',
        description: 'Get warm pool status for a serverless function',
        inputSchema: {
          type: 'object',
          properties: {
            function: {
              type: 'string',
              description: 'Function name to get pool status for',
            },
          },
          required: ['function'],
        },
      },
      {
        name: 'scale_pool',
        description: 'Scale the warm pool for a serverless function',
        inputSchema: {
          type: 'object',
          properties: {
            function: {
              type: 'string',
              description: 'Function name to scale pool for',
            },
            min_size: {
              type: 'number',
              description: 'New minimum pool size',
            },
            max_size: {
              type: 'number',
              description: 'New maximum pool size',
            },
          },
          required: ['function', 'min_size', 'max_size'],
        },
      },
      {
        name: 'get_pod_health',
        description: 'Get health status of pods in the warm pool',
        inputSchema: {
          type: 'object',
          properties: {
            function: {
              type: 'string',
              description: 'Function name to get pod health for',
            },
            pod_id: {
              type: 'string',
              description: 'Specific pod ID (optional)',
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
      case 'get_pool_status':
        return this.getPoolStatus(this.validatePoolStatusArgs(args));
      case 'scale_pool':
        return this.scalePool(this.validateScalePoolArgs(args));
      case 'get_pod_health':
        return this.getPodHealth(this.validatePodHealthArgs(args));
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown warm pool tool: ${toolName}`);
    }
  }

  private validatePoolStatusArgs(args: Record<string, unknown>): GetPoolStatusParams {
    if (typeof args['function'] !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'function is required and must be a string');
    }
    return { function: args['function'] };
  }

  private validateScalePoolArgs(args: Record<string, unknown>): ScalePoolParams {
    if (typeof args['function'] !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'function is required and must be a string');
    }
    if (typeof args['min_size'] !== 'number') {
      throw new McpError(ErrorCode.InvalidParams, 'min_size is required and must be a number');
    }
    if (typeof args['max_size'] !== 'number') {
      throw new McpError(ErrorCode.InvalidParams, 'max_size is required and must be a number');
    }
    if (args['min_size'] > args['max_size']) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'min_size must be less than or equal to max_size',
      );
    }
    if ((args['min_size'] as number) < 0 || (args['max_size'] as number) < 0) {
      throw new McpError(ErrorCode.InvalidParams, 'min_size and max_size must be non-negative');
    }
    return { function: args['function'], min_size: args['min_size'], max_size: args['max_size'] };
  }

  private validatePodHealthArgs(args: Record<string, unknown>): GetPodHealthParams {
    if (typeof args['function'] !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'function is required and must be a string');
    }
    const result: GetPodHealthParams = { function: args['function'] };
    if (args['pod_id'] !== undefined) {
      if (typeof args['pod_id'] !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, 'pod_id must be a string');
      }
      result.pod_id = args['pod_id'];
    }
    return result;
  }

  private async getPoolStatus(
    params: GetPoolStatusParams,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const poolState = this.poolManager.getPoolState(params.function);

    if (!poolState) {
      throw new McpError(ErrorCode.InvalidParams, `No pool found for function: ${params.function}`);
    }

    const result = {
      function: poolState.function,
      warm: poolState.available_pods,
      active: poolState.active_pods,
      cooling: poolState.cooling_pods,
      total: poolState.total_pods,
      utilization: (poolState.utilization * 100).toFixed(1) + '%',
    };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  private async scalePool(
    params: ScalePoolParams,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    await this.poolManager.scalePool(params.function, params.min_size, params.max_size);

    const result = {
      status: 'success',
      function: params.function,
      new_min: params.min_size,
      new_max: params.max_size,
    };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  private async getPodHealth(
    params: GetPodHealthParams,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const poolState = this.poolManager.getPoolState(params.function);

    if (!poolState) {
      throw new McpError(ErrorCode.InvalidParams, `No pool found for function: ${params.function}`);
    }

    let pods = poolState.pod_states;
    if (params.pod_id) {
      pods = pods.filter((p) => p.pod_id === params.pod_id);
    }

    const result = {
      pods: pods.map((p) => ({
        pod_id: p.pod_id,
        state: p.state,
        latency_ms: p.recent_latency_ms,
        last_invocation: p.last_health_check.toISOString(),
        health_check_status: p.healthy ? 'healthy' : 'unhealthy',
        active_invocations: p.active_invocations,
        resource_usage: {
          cpu: 'unknown',
          memory: 'unknown',
        },
      })),
    };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
}
