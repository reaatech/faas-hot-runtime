import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { observabilityStore } from '../../observability/store.js';

export type ObservabilitySkillConfig = object;

export interface GetTracesParams {
  function?: string;
  trace_id?: string;
  limit?: number;
}

export interface GetMetricsParams {
  function?: string;
  metric_names?: string[];
  range?: string;
}

export interface GetLogsParams {
  function?: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  request_id?: string;
  limit?: number;
}

export class ObservabilitySkillHandler {
  constructor(_config?: ObservabilitySkillConfig) {}
  getTools(): Tool[] {
    return [
      {
        name: 'get_traces',
        description: 'Get trace data for serverless function invocations',
        inputSchema: {
          type: 'object',
          properties: {
            function: {
              type: 'string',
              description: 'Function name to get traces for (optional)',
            },
            trace_id: {
              type: 'string',
              description: 'Specific trace ID to retrieve',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of traces to return',
              default: 10,
            },
          },
        },
      },
      {
        name: 'get_metrics',
        description: 'Get metrics for serverless function invocations',
        inputSchema: {
          type: 'object',
          properties: {
            function: {
              type: 'string',
              description: 'Function name to get metrics for (optional)',
            },
            metric_names: {
              type: 'array',
              items: { type: 'string' },
              description: 'Specific metric names to retrieve',
            },
            range: {
              type: 'string',
              description: 'Time range (e.g., "1h", "24h", "7d")',
              default: '1h',
            },
          },
        },
      },
      {
        name: 'get_logs',
        description: 'Get log entries for serverless function invocations',
        inputSchema: {
          type: 'object',
          properties: {
            function: {
              type: 'string',
              description: 'Function name to get logs for (optional)',
            },
            level: {
              type: 'string',
              enum: ['debug', 'info', 'warn', 'error'],
              description: 'Filter by log level',
            },
            request_id: {
              type: 'string',
              description: 'Specific request ID to get logs for',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of log entries to return',
              default: 50,
            },
          },
        },
      },
    ];
  }

  private static readonly MAX_LIMIT = 1000;

  async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    switch (toolName) {
      case 'get_traces':
        return this.getTraces(this.validateTracesArgs(args));
      case 'get_metrics':
        return this.getMetrics(this.validateMetricsArgs(args));
      case 'get_logs':
        return this.getLogs(this.validateLogsArgs(args));
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown observability tool: ${toolName}`);
    }
  }

  private validateTracesArgs(args: Record<string, unknown>): GetTracesParams {
    const result: GetTracesParams = {};
    if (args['function'] !== undefined) {
      if (typeof args['function'] !== 'string')
        throw new McpError(ErrorCode.InvalidParams, 'function must be a string');
      result.function = args['function'];
    }
    if (args['trace_id'] !== undefined) {
      if (typeof args['trace_id'] !== 'string')
        throw new McpError(ErrorCode.InvalidParams, 'trace_id must be a string');
      result.trace_id = args['trace_id'];
    }
    if (args['limit'] !== undefined) {
      if (typeof args['limit'] !== 'number')
        throw new McpError(ErrorCode.InvalidParams, 'limit must be a number');
      result.limit = Math.min(args['limit'], ObservabilitySkillHandler.MAX_LIMIT);
    }
    return result;
  }

  private validateMetricsArgs(args: Record<string, unknown>): GetMetricsParams {
    const result: GetMetricsParams = {};
    if (args['function'] !== undefined) {
      if (typeof args['function'] !== 'string')
        throw new McpError(ErrorCode.InvalidParams, 'function must be a string');
      result.function = args['function'];
    }
    if (args['metric_names'] !== undefined) {
      if (!Array.isArray(args['metric_names']))
        throw new McpError(ErrorCode.InvalidParams, 'metric_names must be an array');
      result.metric_names = args['metric_names'] as string[];
    }
    if (args['range'] !== undefined) {
      if (typeof args['range'] !== 'string')
        throw new McpError(ErrorCode.InvalidParams, 'range must be a string');
      result.range = args['range'];
    }
    return result;
  }

  private validateLogsArgs(args: Record<string, unknown>): GetLogsParams {
    const result: GetLogsParams = {};
    if (args['function'] !== undefined) {
      if (typeof args['function'] !== 'string')
        throw new McpError(ErrorCode.InvalidParams, 'function must be a string');
      result.function = args['function'];
    }
    if (args['level'] !== undefined) {
      if (
        typeof args['level'] !== 'string' ||
        !['debug', 'info', 'warn', 'error'].includes(args['level'])
      ) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'level must be one of: debug, info, warn, error',
        );
      }
      result.level = args['level'] as GetLogsParams['level'];
    }
    if (args['request_id'] !== undefined) {
      if (typeof args['request_id'] !== 'string')
        throw new McpError(ErrorCode.InvalidParams, 'request_id must be a string');
      result.request_id = args['request_id'];
    }
    if (args['limit'] !== undefined) {
      if (typeof args['limit'] !== 'number')
        throw new McpError(ErrorCode.InvalidParams, 'limit must be a number');
      result.limit = Math.min(args['limit'], ObservabilitySkillHandler.MAX_LIMIT);
    }
    return result;
  }

  private getTraces(params: GetTracesParams): { content: Array<{ type: string; text: string }> } {
    const limit = Math.min(params.limit || 10, ObservabilitySkillHandler.MAX_LIMIT);
    const traces = observabilityStore.getTraces({
      function: params.function,
      trace_id: params.trace_id,
      limit,
    });

    const traceSummaries = traces.map((trace) => ({
      trace_id: trace.trace_id,
      span_count: traces.filter((t) => t.trace_id === trace.trace_id).length,
      duration_ms: trace.duration_ms,
      start_time: trace.start_time,
      root_span: {
        name: trace.operation_name,
        status: trace.status,
        function: trace.attributes['faas.function'] || trace.attributes['function'] || 'unknown',
      },
      spans: [trace],
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify({ traces: traceSummaries }, null, 2) }],
    };
  }

  private getMetrics(params: GetMetricsParams): { content: Array<{ type: string; text: string }> } {
    const metrics = observabilityStore.getMetrics({
      function: params.function,
      metric_names: params.metric_names,
      range: params.range || '1h',
    });

    const groupedMetrics = new Map<
      string,
      {
        name: string;
        type: string;
        points: Array<{ timestamp: string; value: number; labels: Record<string, string> }>;
      }
    >();

    for (const metric of metrics) {
      const key = `${metric.name}:${JSON.stringify(metric.labels)}`;
      if (!groupedMetrics.has(key)) {
        groupedMetrics.set(key, {
          name: metric.name,
          type: metric.type,
          points: [],
        });
      }
      groupedMetrics.get(key)!.points.push({
        timestamp: metric.timestamp,
        value: metric.value,
        labels: metric.labels,
      });
    }

    const result = {
      metrics: Array.from(groupedMetrics.values()),
    };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  private getLogs(params: GetLogsParams): { content: Array<{ type: string; text: string }> } {
    const limit = Math.min(params.limit || 50, ObservabilitySkillHandler.MAX_LIMIT);
    const logs = observabilityStore.getLogs({
      function: params.function,
      level: params.level,
      request_id: params.request_id,
      limit,
    });

    const result = {
      logs: logs.map((log) => ({
        timestamp: log.timestamp,
        level: log.level,
        message: log.message,
        service: log.service,
        function: log.function,
        request_id: log.request_id,
        trace_id: log.trace_id,
        span_id: log.span_id,
        attributes: log.attributes,
      })),
      count: logs.length,
    };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
}
