import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import {
  trace,
  context,
  propagation,
  type Tracer,
  type Span,
  type Context,
} from '@opentelemetry/api';
import { logger } from './logger.js';

let tracerProvider: NodeTracerProvider | null = null;
let tracer: Tracer | null = null;

export interface TracingConfig {
  enabled: boolean;
  otlpEndpoint: string;
  serviceName: string;
  serviceVersion: string;
}

export function initTracing(config: TracingConfig): void {
  if (!config.enabled) {
    logger.info('Tracing disabled');
    return;
  }

  tracerProvider = new NodeTracerProvider({
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: config.otlpEndpoint,
        }),
      ),
    ],
  });

  tracerProvider.register();

  registerInstrumentations({
    tracerProvider,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  tracer = trace.getTracer(config.serviceName, config.serviceVersion);

  logger.info(
    { otlpEndpoint: config.otlpEndpoint, serviceName: config.serviceName },
    'Tracing initialized',
  );
}

export function getTracer(): Tracer {
  if (!tracer) {
    throw new Error('Tracing not initialized. Call initTracing() first.');
  }
  return tracer;
}

export function startInvocationSpan(functionName: string, requestId: string): Span {
  const span = getTracer().startSpan('faas.invoke', {
    attributes: {
      'faas.function': functionName,
      'faas.request_id': requestId,
    },
  });

  return span;
}

export function startPoolSelectionSpan(functionName: string): Span {
  return getTracer().startSpan('pool.select', {
    attributes: {
      'faas.function': functionName,
    },
  });
}

export function startFunctionExecutionSpan(functionName: string, podId: string): Span {
  return getTracer().startSpan('function.execute', {
    attributes: {
      'faas.function': functionName,
      'faas.pod': podId,
    },
  });
}

export function injectContext(headers: Record<string, string>): void {
  propagation.inject(context.active(), headers);
}

export function extractContext(headers: Record<string, string>): Context {
  const extractedContext = propagation.extract(context.active(), headers);
  return extractedContext;
}

export async function shutdownTracing(): Promise<void> {
  if (tracerProvider) {
    await tracerProvider.shutdown();
    tracerProvider = null;
    tracer = null;
    logger.info('Tracing shutdown complete');
  }
}
