import type { Counter, Histogram, Meter, ObservableResult } from '@opentelemetry/api';

interface TraceRecord {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  operation_name: string;
  status: 'OK' | 'ERROR' | 'UNSET';
  start_time: string;
  end_time: string;
  duration_ms: number;
  attributes: Record<string, string | number | boolean>;
}

interface MetricRecord {
  name: string;
  type: 'counter' | 'gauge' | 'histogram';
  value: number;
  labels: Record<string, string>;
  timestamp: string;
}

interface LogRecord {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  service: string;
  function?: string;
  request_id?: string;
  trace_id?: string;
  span_id?: string;
  attributes: Record<string, unknown>;
}

const MAX_TRACES = 1000;
const MAX_METRICS = 10000;
const MAX_LOGS = 5000;

class ObservabilityStore {
  private traces: TraceRecord[] = [];
  private metricsRecords: MetricRecord[] = [];
  private logs: LogRecord[] = [];
  private traceIndex: number = 0;
  private metricIndex: number = 0;
  private logIndex: number = 0;

  private invocationCounter: Counter | null = null;
  private durationHistogram: Histogram | null = null;
  private coldStartCounter: Counter | null = null;
  private costCounter: Counter | null = null;
  private errorsCounter: Counter | null = null;

  private poolUtilizationState: Record<string, number> = {};
  private poolSizeState: Record<string, { total: number; available: number; active: number }> = {};

  constructor() {}

  init(meter: Meter): void {
    this.invocationCounter = meter.createCounter('faas.invocations.total', {
      description: 'Total number of function invocations',
    });

    this.durationHistogram = meter.createHistogram('faas.invocations.duration_ms', {
      description: 'Function invocation duration in milliseconds',
    });

    this.coldStartCounter = meter.createCounter('faas.cold_starts.total', {
      description: 'Total number of cold starts',
    });

    const poolUtilizationGauge = meter.createObservableGauge('faas.pool.utilization', {
      description: 'Warm pool utilization (0-1)',
    });
    poolUtilizationGauge.addCallback((observableResult: ObservableResult) => {
      for (const [fn, value] of Object.entries(this.poolUtilizationState)) {
        observableResult.observe(value, { function: fn });
      }
    });

    const poolSizeGauge = meter.createObservableGauge('faas.pool.size', {
      description: 'Current pool size by state',
    });
    poolSizeGauge.addCallback((observableResult: ObservableResult) => {
      for (const [fn, sizes] of Object.entries(this.poolSizeState)) {
        observableResult.observe(sizes.total, { function: fn, state: 'total' });
        observableResult.observe(sizes.available, { function: fn, state: 'available' });
        observableResult.observe(sizes.active, { function: fn, state: 'active' });
      }
    });

    this.costCounter = meter.createCounter('faas.cost.total', {
      description: 'Total cost in USD',
    });

    this.errorsCounter = meter.createCounter('faas.errors.total', {
      description: 'Total number of errors',
    });
  }

  recordInvocation(
    functionName: string,
    status: 'success' | 'error',
    durationMs: number,
    coldStart: boolean,
    costUsd: number,
  ): void {
    this.invocationCounter?.add(1, { function: functionName, status });
    this.durationHistogram?.record(durationMs, { function: functionName });

    if (coldStart) {
      this.coldStartCounter?.add(1, { function: functionName });
    }

    this.costCounter?.add(costUsd, { function: functionName });

    this.addMetric({
      name: 'faas.invocations.total',
      type: 'counter',
      value: 1,
      labels: { function: functionName, status },
      timestamp: new Date().toISOString(),
    });
  }

  recordError(functionName: string, errorType: string): void {
    this.errorsCounter?.add(1, { function: functionName, error_type: errorType });

    this.addMetric({
      name: 'faas.errors.total',
      type: 'counter',
      value: 1,
      labels: { function: functionName, error_type: errorType },
      timestamp: new Date().toISOString(),
    });
  }

  updatePoolMetrics(
    functionName: string,
    totalPods: number,
    availablePods: number,
    activePods: number,
    utilization: number,
  ): void {
    this.poolUtilizationState[functionName] = utilization;
    this.poolSizeState[functionName] = {
      total: totalPods,
      available: availablePods,
      active: activePods,
    };

    this.addMetric({
      name: 'faas.pool.utilization',
      type: 'gauge',
      value: utilization,
      labels: { function: functionName },
      timestamp: new Date().toISOString(),
    });

    this.addMetric({
      name: 'faas.pool.size',
      type: 'gauge',
      value: totalPods,
      labels: { function: functionName, state: 'total' },
      timestamp: new Date().toISOString(),
    });
  }

  recordTrace(trace: TraceRecord): void {
    const idx = this.traceIndex % MAX_TRACES;
    this.traces[idx] = trace;
    this.traceIndex++;
  }

  addLog(log: Omit<LogRecord, 'timestamp'>): void {
    const record: LogRecord = {
      ...log,
      timestamp: new Date().toISOString(),
    };

    const idx = this.logIndex % MAX_LOGS;
    this.logs[idx] = record;
    this.logIndex++;
  }

  private addMetric(metric: MetricRecord): void {
    const idx = this.metricIndex % MAX_METRICS;
    this.metricsRecords[idx] = metric;
    this.metricIndex++;
  }

  getTraces(params: {
    function?: string;
    trace_id?: string;
    limit?: number;
  }): TraceRecord[] {
    let filtered = this.traces;

    if (params.trace_id) {
      filtered = filtered.filter((t) => t.trace_id === params.trace_id);
    }

    if (params.function) {
      filtered = filtered.filter(
        (t) => t.attributes['faas.function'] === params.function || t.attributes['function'] === params.function,
      );
    }

    return filtered
      .sort((a, b) => b.start_time.localeCompare(a.start_time))
      .slice(0, params.limit || 100);
  }

  getMetrics(params: {
    function?: string;
    metric_names?: string[];
    range?: string;
  }): MetricRecord[] {
    let filtered = this.metricsRecords;

    if (params.metric_names && params.metric_names.length > 0) {
      filtered = filtered.filter((m) => params.metric_names!.includes(m.name));
    }

    if (params.function) {
      filtered = filtered.filter((m) => m.labels['function'] === params.function);
    }

    if (params.range) {
      const now = Date.now();
      const rangeMs = this.parseRangeToMs(params.range);
      const cutoff = new Date(now - rangeMs).toISOString();
      filtered = filtered.filter((m) => m.timestamp >= cutoff);
    }

    return filtered
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 1000);
  }

  getLogs(params: {
    function?: string;
    level?: string;
    request_id?: string;
    limit?: number;
  }): LogRecord[] {
    let filtered = this.logs;

    if (params.level) {
      filtered = filtered.filter((l) => l.level === params.level);
    }

    if (params.function) {
      filtered = filtered.filter((l) => l.function === params.function);
    }

    if (params.request_id) {
      filtered = filtered.filter((l) => l.request_id === params.request_id);
    }

    return filtered
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, params.limit || 100);
  }

  private parseRangeToMs(range: string): number {
    const match = range.match(/^(\d+)([hmd])$/);
    if (!match) return 3600000;

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 'h':
        return value * 3600000;
      case 'd':
        return value * 86400000;
      case 'm':
        return value * 60000;
      default:
        return 3600000;
    }
  }
}

export const observabilityStore = new ObservabilityStore();
