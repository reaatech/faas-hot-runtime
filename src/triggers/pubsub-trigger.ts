import { PubSub } from '@google-cloud/pubsub';
import { logger } from '../observability/logger.js';
import type { InvocationRequest, InvocationResult, FunctionDefinition } from '../types/index.js';

export interface PubSubTriggerConfig {
  projectId: string;
  topicName: string;
  subscriptionName: string;
  maxMessages: number;
  ackDeadlineSeconds: number;
}

export interface PubSubTriggerHandler {
  handleRequest(request: InvocationRequest): Promise<InvocationResult>;
}

export class PubSubTrigger {
  private config: PubSubTriggerConfig;
  private pubsub: PubSub;
  private subscription: ReturnType<PubSub['subscription']> | undefined;
  private handlers: Map<string, PubSubTriggerHandler> = new Map();
  private functions: Map<string, FunctionDefinition> = new Map();

  constructor(config: PubSubTriggerConfig) {
    this.config = config;
    this.pubsub = new PubSub({ projectId: config.projectId });
  }

  async start(): Promise<void> {
    logger.info(
      { topic: this.config.topicName, subscription: this.config.subscriptionName },
      'Starting Pub/Sub trigger',
    );

    this.subscription = this.pubsub.subscription(this.config.subscriptionName, {
      ackDeadline: this.config.ackDeadlineSeconds,
      flowControl: {
        maxMessages: this.config.maxMessages,
      },
    });

    this.subscription.on('message', async (message) => {
      await this.handleMessage(message);
    });

    this.subscription.on('error', (error) => {
      logger.error({ error }, 'Pub/Sub subscription error');
    });
  }

  private async handleMessage(message: {
    id: string;
    data: Buffer;
    attributes: Record<string, string>;
    ack(): void;
    nack(): void;
  }): Promise<void> {
    try {
      const decoded = message.data.toString('base64');
      const body = JSON.parse(decoded);

      const functionName = body.function ?? body.functionName;
      const handler = functionName ? this.handlers.get(functionName) : undefined;

      if (!handler || !functionName) {
        logger.warn({ messageId: message.id }, 'No handler found for Pub/Sub message');
        message.ack();
        return;
      }

      const request: InvocationRequest = {
        function: functionName,
        arguments: body.arguments ?? body.payload ?? {},
        request_id: message.id,
      };

      const result = await handler.handleRequest(request);

      if (result.success) {
        message.ack();
      } else {
        message.nack();
      }
    } catch (error) {
      logger.error({ error, messageId: message.id }, 'Error processing Pub/Sub message');
      message.nack();
    }
  }

  async stop(): Promise<void> {
    if (this.subscription) {
      this.subscription.removeAllListeners('message');
      this.subscription.removeAllListeners('error');
    }
    await this.pubsub.close();
    logger.info('Pub/Sub trigger stopped');
  }

  registerFunction(func: FunctionDefinition, handler: PubSubTriggerHandler): void {
    this.functions.set(func.name, func);
    this.handlers.set(func.name, handler);
    logger.info({ function: func.name }, 'Function registered with Pub/Sub trigger');
  }

  unregisterFunction(functionName: string): void {
    this.functions.delete(functionName);
    this.handlers.delete(functionName);
    logger.info({ function: functionName }, 'Function unregistered from Pub/Sub trigger');
  }
}
