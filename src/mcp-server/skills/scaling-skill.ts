import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ScalingController } from '../../pool-manager/scaling-controller.js';

export interface ScalingSkillConfig {
  scalingController: ScalingController;
}

export interface GetScalingPolicyParams {
  function: string;
}

export interface UpdateScalingPolicyParams {
  function: string;
  min_pods?: number;
  max_pods?: number;
  target_utilization?: number;
  scale_up_threshold?: number;
  scale_down_threshold?: number;
  cooldown_seconds?: number;
}

export interface GetScalingHistoryParams {
  function?: string;
  range?: string;
}

export class ScalingSkillHandler {
  private scalingController: ScalingController;

  constructor(config: ScalingSkillConfig) {
    this.scalingController = config.scalingController;
  }

  getTools(): Tool[] {
    return [
      {
        name: 'get_scaling_policy',
        description: 'Get scaling policy for a serverless function',
        inputSchema: {
          type: 'object',
          properties: {
            function: {
              type: 'string',
              description: 'Function name to get scaling policy for',
            },
          },
          required: ['function'],
        },
      },
      {
        name: 'update_scaling_policy',
        description: 'Update scaling policy for a serverless function',
        inputSchema: {
          type: 'object',
          properties: {
            function: {
              type: 'string',
              description: 'Function name to update scaling policy for',
            },
            min_pods: {
              type: 'number',
              description: 'Minimum number of warm pods',
            },
            max_pods: {
              type: 'number',
              description: 'Maximum number of pods',
            },
            target_utilization: {
              type: 'number',
              description: 'Target utilization percentage (0-1)',
            },
            scale_up_threshold: {
              type: 'number',
              description: 'Threshold to trigger scale up (0-1)',
            },
            scale_down_threshold: {
              type: 'number',
              description: 'Threshold to trigger scale down (0-1)',
            },
            cooldown_seconds: {
              type: 'number',
              description: 'Cooldown period between scaling events',
            },
          },
          required: ['function'],
        },
      },
      {
        name: 'get_scaling_history',
        description: 'Get scaling history for serverless functions',
        inputSchema: {
          type: 'object',
          properties: {
            function: {
              type: 'string',
              description: 'Function name to get scaling history for (optional for all)',
            },
            range: {
              type: 'string',
              description: 'Time range (e.g., "24h", "7d")',
              default: '24h',
            },
          },
        },
      },
    ];
  }

  async handleToolCall(toolName: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
    switch (toolName) {
      case 'get_scaling_policy':
        return this.getScalingPolicy(this.validateScalingPolicyArgs(args));
      case 'update_scaling_policy':
        return this.updateScalingPolicy(this.validateUpdateScalingPolicyArgs(args));
      case 'get_scaling_history':
        return this.getScalingHistory(this.validateScalingHistoryArgs(args));
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown scaling tool: ${toolName}`);
    }
  }

  private validateScalingPolicyArgs(args: Record<string, unknown>): GetScalingPolicyParams {
    if (typeof args['function'] !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'function is required and must be a string');
    }
    return { function: args['function'] };
  }

  private validateUpdateScalingPolicyArgs(args: Record<string, unknown>): UpdateScalingPolicyParams {
    if (typeof args['function'] !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'function is required and must be a string');
    }
    const result: UpdateScalingPolicyParams = { function: args['function'] };
    if (args['min_pods'] !== undefined) {
      if (typeof args['min_pods'] !== 'number') throw new McpError(ErrorCode.InvalidParams, 'min_pods must be a number');
      result.min_pods = args['min_pods'];
    }
    if (args['max_pods'] !== undefined) {
      if (typeof args['max_pods'] !== 'number') throw new McpError(ErrorCode.InvalidParams, 'max_pods must be a number');
      result.max_pods = args['max_pods'];
    }
    if (args['target_utilization'] !== undefined) {
      if (typeof args['target_utilization'] !== 'number') throw new McpError(ErrorCode.InvalidParams, 'target_utilization must be a number');
      result.target_utilization = args['target_utilization'];
    }
    if (args['scale_up_threshold'] !== undefined) {
      if (typeof args['scale_up_threshold'] !== 'number') throw new McpError(ErrorCode.InvalidParams, 'scale_up_threshold must be a number');
      result.scale_up_threshold = args['scale_up_threshold'];
    }
    if (args['scale_down_threshold'] !== undefined) {
      if (typeof args['scale_down_threshold'] !== 'number') throw new McpError(ErrorCode.InvalidParams, 'scale_down_threshold must be a number');
      result.scale_down_threshold = args['scale_down_threshold'];
    }
    if (args['cooldown_seconds'] !== undefined) {
      if (typeof args['cooldown_seconds'] !== 'number') throw new McpError(ErrorCode.InvalidParams, 'cooldown_seconds must be a number');
      result.cooldown_seconds = args['cooldown_seconds'];
    }
    return result;
  }

  private validateScalingHistoryArgs(args: Record<string, unknown>): GetScalingHistoryParams {
    const result: GetScalingHistoryParams = {};
    if (args['function'] !== undefined) {
      if (typeof args['function'] !== 'string') throw new McpError(ErrorCode.InvalidParams, 'function must be a string');
      result.function = args['function'];
    }
    if (args['range'] !== undefined) {
      if (typeof args['range'] !== 'string') throw new McpError(ErrorCode.InvalidParams, 'range must be a string');
      result.range = args['range'];
    }
    return result;
  }

  private async getScalingPolicy(params: GetScalingPolicyParams): Promise<{ content: Array<{ type: string; text: string }> }> {
    const history = this.scalingController.getScaleHistory(params.function);
    const metrics = this.scalingController.getScalingMetrics({
      function: params.function,
      total_pods: 0,
      available_pods: 0,
      active_pods: 0,
      cooling_pods: 0,
      utilization: 0,
      pod_states: [],
    });

    const policy = {
      function: params.function,
      min_pods: this.scalingController.getMinSize(params.function) ?? 2,
      max_pods: this.scalingController.getMaxSize(params.function) ?? 10,
      target_utilization: this.scalingController.getTargetUtilization(params.function) ?? 0.7,
      scale_up_threshold: this.scalingController.getScaleUpThreshold() ?? 0.8,
      scale_down_threshold: this.scalingController.getScaleDownThreshold() ?? 0.3,
      scale_up_cooldown_seconds: this.scalingController.getCooldownSeconds() ?? 60,
      scale_down_cooldown_seconds: this.scalingController.getCooldownSeconds() ?? 300,
      predictive_scaling: true,
      cost_limit_daily: 100.00,
      last_scale_up: history.lastScaleUp,
      last_scale_down: history.lastScaleDown,
      current_metrics: metrics,
    };

    return { content: [{ type: 'text', text: JSON.stringify(policy, null, 2) }] };
  }

  private async updateScalingPolicy(params: UpdateScalingPolicyParams): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (params.min_pods !== undefined || params.max_pods !== undefined) {
      this.scalingController.updatePoolLimits(params.function, params.min_pods, params.max_pods);
    }
    if (params.target_utilization !== undefined) {
      this.scalingController.updateTargetUtilization(params.function, params.target_utilization);
    }
    if (params.scale_up_threshold !== undefined) {
      this.scalingController.updateScaleUpThreshold(params.scale_up_threshold);
    }
    if (params.scale_down_threshold !== undefined) {
      this.scalingController.updateScaleDownThreshold(params.scale_down_threshold);
    }
    if (params.cooldown_seconds !== undefined) {
      this.scalingController.updateCooldownSeconds(params.cooldown_seconds);
    }

    const result = {
      status: 'success',
      function: params.function,
      policy: {
        min_pods: params.min_pods ?? this.scalingController.getMinSize(params.function) ?? 2,
        max_pods: params.max_pods ?? this.scalingController.getMaxSize(params.function) ?? 10,
        target_utilization: params.target_utilization ?? this.scalingController.getTargetUtilization(params.function) ?? 0.7,
        scale_up_threshold: params.scale_up_threshold ?? this.scalingController.getScaleUpThreshold() ?? 0.8,
        scale_down_threshold: params.scale_down_threshold ?? this.scalingController.getScaleDownThreshold() ?? 0.3,
        cooldown_seconds: params.cooldown_seconds ?? this.scalingController.getCooldownSeconds() ?? 60,
      },
    };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  private async getScalingHistory(params: GetScalingHistoryParams): Promise<{ content: Array<{ type: string; text: string }> }> {
    const events: Array<{ timestamp: string; function: string; event_type: string; reason: string }> = [];

    if (params.function) {
      const history = this.scalingController.getScaleHistory(params.function);
      if (history.lastScaleUp) {
        events.push({
          timestamp: new Date(history.lastScaleUp).toISOString(),
          function: params.function,
          event_type: 'scale_up',
          reason: 'Manual or automatic scale up',
        });
      }
      if (history.lastScaleDown) {
        events.push({
          timestamp: new Date(history.lastScaleDown).toISOString(),
          function: params.function,
          event_type: 'scale_down',
          reason: 'Manual or automatic scale down',
        });
      }
    }

    const result = {
      events,
      range: params.range ?? '24h',
    };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
}