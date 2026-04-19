import { SQSClient, ReceiveMessageCommand, DeleteMessageBatchCommand, SendMessageCommand, type Message } from '@aws-sdk/client-sqs';
import { logger } from '../observability/logger.js';
import type { InvocationRequest, InvocationResult, FunctionDefinition } from '../types/index.js';

export interface SQSTriggerConfig {
  queueUrl: string;
  region: string;
  accountId: string;
  queueName: string;
  batchSize: number;
  visibilityTimeoutSeconds: number;
  maxReceiveCount: number;
  pollIntervalMs: number;
  dlqUrl?: string;
}

export interface SQSTriggerHandler {
  handleRequest(request: InvocationRequest): Promise<InvocationResult>;
}

export class SQSTrigger {
  private config: SQSTriggerConfig;
  private client: SQSClient;
  private handlers: Map<string, SQSTriggerHandler> = new Map();
  private functions: Map<string, FunctionDefinition> = new Map();
  private running: boolean = false;
  private pollTimeout?: ReturnType<typeof setTimeout>;
  private attempt: number = 0;
  private queueUrl: string;

  constructor(config: SQSTriggerConfig) {
    this.config = config;
    this.client = new SQSClient({ region: config.region });
    this.queueUrl = config.queueUrl ?? `https://sqs.${config.region}.amazonaws.com/${config.accountId}/${config.queueName}`;
  }

  async start(): Promise<void> {
    this.running = true;
    logger.info({ queue: this.queueUrl }, 'Starting SQS trigger');
    this.pollQueue();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = undefined;
    }
    this.client.destroy();
    logger.info('SQS trigger stopped');
  }

  private async pollQueue(): Promise<void> {
    if (!this.running) return;

    try {
      const response = await this.client.send(new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: this.config.batchSize,
        WaitTimeSeconds: 20,
        VisibilityTimeout: this.config.visibilityTimeoutSeconds,
      }));

      this.attempt = 0;

      if (!response.Messages || response.Messages.length === 0) {
        this.pollTimeout = setTimeout(() => this.pollQueue(), this.config.pollIntervalMs);
        this.pollTimeout.unref();
        return;
      }

      const deleteEntries: { Id: string; ReceiptHandle: string }[] = [];

      for (const message of response.Messages) {
        if (!message.MessageId || !message.ReceiptHandle) continue;

        try {
          const body = JSON.parse(message.Body ?? '{}');

          const functionName = body.function ?? body.functionName;
          const handler = functionName ? this.handlers.get(functionName) : undefined;

          if (!handler || !functionName) {
            logger.warn({ messageId: message.MessageId }, 'No handler found for SQS message');
            deleteEntries.push({ Id: message.MessageId, ReceiptHandle: message.ReceiptHandle });
            continue;
          }

          const request: InvocationRequest = {
            function: functionName,
            arguments: body.arguments ?? body.payload ?? {},
            request_id: message.MessageId,
          };

          const result = await handler.handleRequest(request);

          if (result.success) {
            deleteEntries.push({ Id: message.MessageId, ReceiptHandle: message.ReceiptHandle });
          } else {
            await this.handleFailedMessage(message, body);
          }
        } catch (error) {
          logger.error({ error, messageId: message.MessageId }, 'Error processing SQS message');
          await this.handleFailedMessage(message, {});
        }
      }

      if (deleteEntries.length > 0) {
        await this.client.send(new DeleteMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: deleteEntries,
        }));
      }

      this.pollTimeout = setTimeout(() => this.pollQueue(), 0);
      this.pollTimeout.unref();
    } catch (error) {
      logger.error({ error }, 'Error polling SQS queue');
      this.attempt++;
      const delay = Math.min(Math.pow(2, this.attempt) * 5000 + Math.random() * 1000, 60000);
      this.pollTimeout = setTimeout(() => this.pollQueue(), delay);
      this.pollTimeout.unref();
    }
  }

  private async handleFailedMessage(
    message: Message,
    body: Record<string, unknown>,
  ): Promise<void> {
    const receiveCount = parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10);

    if (receiveCount >= this.config.maxReceiveCount) {
      const dlqUrl = this.config.dlqUrl ?? `${this.queueUrl}-dlq`;
      try {
        await this.client.send(new SendMessageCommand({
          QueueUrl: dlqUrl,
          MessageBody: message.Body ?? JSON.stringify(body),
        }));
        if (message.MessageId && message.ReceiptHandle) {
          await this.client.send(new DeleteMessageBatchCommand({
            QueueUrl: this.queueUrl,
            Entries: [{ Id: message.MessageId, ReceiptHandle: message.ReceiptHandle }],
          }));
        }
        logger.info({ messageId: message.MessageId }, 'Message sent to DLQ');
      } catch (error) {
        logger.error({ error, messageId: message.MessageId }, 'Error sending message to DLQ');
      }
    }
  }

  registerFunction(func: FunctionDefinition, handler: SQSTriggerHandler): void {
    this.functions.set(func.name, func);
    this.handlers.set(func.name, handler);
    logger.info({ function: func.name }, 'Function registered with SQS trigger');
  }

  unregisterFunction(functionName: string): void {
    this.functions.delete(functionName);
    this.handlers.delete(functionName);
    logger.info({ function: functionName }, 'Function unregistered from SQS trigger');
  }
}
