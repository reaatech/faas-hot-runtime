import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import type { Counter, Histogram, ObservableResult } from '@opentelemetry/api';
import { metrics } from '@opentelemetry/api';
import { logger } from './logger.js';

let metricProvider: MeterProvider | null = null;

export interface MetricsConfig {
  enabled: boolean;
  otlpEndpoint: string;
  serviceName: string;
  exportIntervalMs?: number;
}

let invocationsTotal: Counter | null = null;
let invocationsDuration: Histogram | null = null;
let coldStartsTotal: Counter | null = null;
let costTotal: Counter | null = null;
let errorsTotal: Counter | null = null;

export interface PoolMetricsState {
  utilization: Record<string, number>;
  size: Record<string, { total: number; available: number; active: number }>;
}

export const poolMetricsState: PoolMetricsState = {
  utilization: {},
  size: {},
};

export function initMetrics(config: MetricsConfig): void {
  if (!config.enabled) {
    logger.info('Metrics disabled');
    return;
  }

  metricProvider = new MeterProvider({
    readers: config.otlpEndpoint
      ? [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({
              url: config.otlpEndpoint,
            }),
            exportIntervalMillis: config.exportIntervalMs ?? 60000,
          }),
        ]
      : [],
  });

  metrics.setGlobalMeterProvider(metricProvider);

  const meter = metricProvider.getMeter(config.serviceName);

  invocationsTotal = meter.createCounter('faas.invocations.total', {
    description: 'Total number of function invocations',
  });

  invocationsDuration = meter.createHistogram('faas.invocations.duration_ms', {
    description: 'Function invocation duration in milliseconds',
  });

  coldStartsTotal = meter.createCounter('faas.cold_starts.total', {
    description: 'Total number of cold starts',
  });

  const poolUtilizationGauge = meter.createObservableGauge('faas.pool.utilization', {
    description: 'Warm pool utilization (0-1)',
  });
  poolUtilizationGauge.addCallback((observableResult: ObservableResult) => {
    for (const [fn, value] of Object.entries(poolMetricsState.utilization)) {
      observableResult.observe(value, { function: fn });
    }
  });

  const poolSizeGauge = meter.createObservableGauge('faas.pool.size', {
    description: 'Current pool size by state',
  });
  poolSizeGauge.addCallback((observableResult: ObservableResult) => {
    for (const [fn, sizes] of Object.entries(poolMetricsState.size)) {
      observableResult.observe(sizes.total, { function: fn, state: 'total' });
      observableResult.observe(sizes.available, { function: fn, state: 'available' });
      observableResult.observe(sizes.active, { function: fn, state: 'active' });
    }
  });

  costTotal = meter.createCounter('faas.cost.total', {
    description: 'Total cost in USD',
  });

  errorsTotal = meter.createCounter('faas.errors.total', {
    description: 'Total number of errors',
  });

  logger.info(
    { otlpEndpoint: config.otlpEndpoint, serviceName: config.serviceName },
    'Metrics initialized',
  );
}

export function recordInvocation(
  functionName: string,
  status: 'success' | 'error',
  durationMs: number,
  coldStart: boolean,
  costUsd: number,
): void {
  if (!invocationsTotal || !invocationsDuration || !costTotal) return;

  invocationsTotal.add(1, { function: functionName, status });
  invocationsDuration.record(durationMs, { function: functionName });

  if (coldStart) {
    coldStartsTotal?.add(1, { function: functionName });
  }

  costTotal.add(costUsd, { function: functionName });
}

export function recordError(functionName: string, errorType: string): void {
  if (!errorsTotal) return;
  errorsTotal.add(1, { function: functionName, error_type: errorType });
}

export function updatePoolMetrics(
  functionName: string,
  totalPods: number,
  availablePods: number,
  activePods: number,
  utilization: number,
): void {
  poolMetricsState.utilization[functionName] = utilization;
  poolMetricsState.size[functionName] = {
    total: totalPods,
    available: availablePods,
    active: activePods,
  };
}

const SHUTDOWN_TIMEOUT_MS = 5000;

export async function shutdownMetrics(): Promise<void> {
  if (metricProvider) {
    await Promise.race([
      metricProvider.shutdown(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Metrics shutdown timed out')), SHUTDOWN_TIMEOUT_MS),
      ),
    ]);
    metricProvider = null;
    logger.info('Metrics shutdown complete');
  }
}
