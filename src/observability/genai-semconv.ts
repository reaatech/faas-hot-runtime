import type { Span, Tracer } from '@opentelemetry/api';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { logger } from './logger.js';

export interface GenAIAttributes {
  operationName: string;
  model?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  finishReason?: string;
  errorType?: string;
  errorMessage?: string;
}

export class GenAISemConv {
  private _tracer: Tracer | null = null;

  private get tracer(): Tracer {
    if (!this._tracer) {
      this._tracer = trace.getTracer('faas-hot-runtime-genai');
    }
    return this._tracer;
  }

  startGenAISpan(functionName: string, attributes: GenAIAttributes, requestId: string): Span {
    const span = this.tracer.startSpan(`faas.invoke.${functionName}`);

    span.setAttribute('gen_ai.operation.name', attributes.operationName);
    if (attributes.model) {
      span.setAttribute('gen_ai.request.model', attributes.model);
    }
    if (attributes.temperature !== undefined) {
      span.setAttribute('gen_ai.request.temperature', attributes.temperature);
    }
    if (attributes.topP !== undefined) {
      span.setAttribute('gen_ai.request.top_p', attributes.topP);
    }
    if (attributes.maxTokens !== undefined) {
      span.setAttribute('gen_ai.request.max_tokens', attributes.maxTokens);
    }

    span.setAttribute('faas.function', functionName);
    span.setAttribute('faas.invocation_id', requestId);

    return span;
  }

  endGenAISpan(span: Span, attributes: GenAIAttributes, durationMs: number): void {
    if (attributes.model) {
      span.setAttribute('gen_ai.response.model', attributes.model);
    }
    if (attributes.inputTokens !== undefined) {
      span.setAttribute('gen_ai.usage.input_tokens', attributes.inputTokens);
    }
    if (attributes.outputTokens !== undefined) {
      span.setAttribute('gen_ai.usage.output_tokens', attributes.outputTokens);
    }
    if (attributes.totalTokens !== undefined) {
      span.setAttribute('gen_ai.usage.total_tokens', attributes.totalTokens);
    }
    if (attributes.finishReason) {
      span.setAttribute('gen_ai.response.finish_reason', attributes.finishReason);
    }

    span.setAttribute('faas.duration_ms', durationMs);

    if (attributes.errorType || attributes.errorMessage) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: attributes.errorMessage,
      });
      if (attributes.errorType) {
        span.setAttribute('error.type', attributes.errorType);
      }
      if (attributes.errorMessage) {
        span.recordException(new Error(attributes.errorMessage));
      }
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }

    span.end();
  }

  calculateTokenCost(params: { model: string; inputTokens: number; outputTokens: number }): {
    cost_usd: number;
    cost_per_million_input: number;
    cost_per_million_output: number;
  } {
    const pricing: Record<string, { input: number; output: number }> = {
      'gpt-4': { input: 0.03, output: 0.06 },
      'gpt-4-turbo': { input: 0.01, output: 0.03 },
      'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
      'claude-3-opus': { input: 0.015, output: 0.075 },
      'claude-3-sonnet': { input: 0.003, output: 0.015 },
      'claude-3-haiku': { input: 0.00025, output: 0.00125 },
    };

    const modelPricing = pricing[params.model] || { input: 0.001, output: 0.002 };

    const inputCost = (params.inputTokens / 1_000_000) * modelPricing.input;
    const outputCost = (params.outputTokens / 1_000_000) * modelPricing.output;

    return {
      cost_usd: inputCost + outputCost,
      cost_per_million_input: modelPricing.input,
      cost_per_million_output: modelPricing.output,
    };
  }

  estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
  }

  logGenAIInvocation(
    functionName: string,
    attributes: GenAIAttributes,
    durationMs: number,
    costUsd: number,
  ): void {
    logger.info(
      {
        function: functionName,
        'gen_ai.operation.name': attributes.operationName,
        'gen_ai.request.model': attributes.model,
        'gen_ai.usage.input_tokens': attributes.inputTokens,
        'gen_ai.usage.output_tokens': attributes.outputTokens,
        'gen_ai.usage.total_tokens': attributes.totalTokens,
        'gen_ai.response.finish_reason': attributes.finishReason,
        duration_ms: durationMs,
        cost_usd: costUsd,
      },
      'GenAI function invocation',
    );
  }
}

export const genAISemConv = new GenAISemConv();
