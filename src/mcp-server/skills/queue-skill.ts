import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  SQSClient,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';

export interface QueueSkillConfig {
  region: string;
  accountId: string;
  sqsClient?: SQSClient;
}

export interface GetQueueStatusParams {
  function?: string;
  queue?: string;
}

export interface GetDLQMessagesParams {
  queue: string;
  max_messages?: number;
}

export interface ReplayDLQParams {
  queue: string;
  message_ids?: string[];
}

export class QueueSkillHandler {
  private region: string;
  private accountId: string;
  private sqsClient: SQSClient;

  constructor(config: QueueSkillConfig) {
    this.region = config.region;
    this.accountId = config.accountId;
    this.sqsClient = config.sqsClient || new SQSClient({ region: config.region });
  }

  getTools(): Tool[] {
    return [
      {
        name: 'get_queue_status',
        description: 'Get status of message queues for serverless functions',
        inputSchema: {
          type: 'object',
          properties: {
            function: {
              type: 'string',
              description: 'Function name to get queue status for (optional)',
            },
            queue: {
              type: 'string',
              description: 'Specific queue name (optional)',
            },
          },
        },
      },
      {
        name: 'get_dlq_messages',
        description: 'Get messages from the dead letter queue',
        inputSchema: {
          type: 'object',
          properties: {
            queue: {
              type: 'string',
              description: 'Dead letter queue name',
            },
            max_messages: {
              type: 'number',
              description: 'Maximum number of messages to retrieve',
              default: 10,
            },
          },
          required: ['queue'],
        },
      },
      {
        name: 'replay_dlq',
        description: 'Replay messages from the dead letter queue',
        inputSchema: {
          type: 'object',
          properties: {
            queue: {
              type: 'string',
              description: 'Dead letter queue name to replay from',
            },
            message_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Specific message IDs to replay (optional, replays all if not specified)',
            },
          },
          required: ['queue'],
        },
      },
    ];
  }

  private static readonly VALID_QUEUE_NAME = /^[a-zA-Z0-9_-]+$/;

  async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    switch (toolName) {
      case 'get_queue_status':
        return this.getQueueStatus(this.validateQueueStatusArgs(args));
      case 'get_dlq_messages':
        return this.getDLQMessages(this.validateDlqArgs(args));
      case 'replay_dlq':
        return this.replayDLQ(this.validateReplayDlqArgs(args));
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown queue tool: ${toolName}`);
    }
  }

  private validateQueueName(name: string): void {
    if (!QueueSkillHandler.VALID_QUEUE_NAME.test(name)) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid queue name: ${name}. Only alphanumeric, hyphens, and underscores allowed.`);
    }
  }

  private validateQueueStatusArgs(args: Record<string, unknown>): GetQueueStatusParams {
    const result: GetQueueStatusParams = {};
    if (args['function'] !== undefined) {
      if (typeof args['function'] !== 'string') throw new McpError(ErrorCode.InvalidParams, 'function must be a string');
      result.function = args['function'];
    }
    if (args['queue'] !== undefined) {
      if (typeof args['queue'] !== 'string') throw new McpError(ErrorCode.InvalidParams, 'queue must be a string');
      this.validateQueueName(args['queue']);
      result.queue = args['queue'];
    }
    return result;
  }

  private validateDlqArgs(args: Record<string, unknown>): GetDLQMessagesParams {
    if (typeof args['queue'] !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'queue is required and must be a string');
    }
    this.validateQueueName(args['queue']);
    const result: GetDLQMessagesParams = { queue: args['queue'] };
    if (args['max_messages'] !== undefined) {
      if (typeof args['max_messages'] !== 'number') throw new McpError(ErrorCode.InvalidParams, 'max_messages must be a number');
      result.max_messages = args['max_messages'];
    }
    return result;
  }

  private validateReplayDlqArgs(args: Record<string, unknown>): ReplayDLQParams {
    if (typeof args['queue'] !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'queue is required and must be a string');
    }
    this.validateQueueName(args['queue']);
    const result: ReplayDLQParams = { queue: args['queue'] };
    if (args['message_ids'] !== undefined) {
      if (!Array.isArray(args['message_ids'])) throw new McpError(ErrorCode.InvalidParams, 'message_ids must be an array');
      result.message_ids = args['message_ids'] as string[];
    }
    return result;
  }

  private async getQueueStatus(
    params: GetQueueStatusParams,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (!params.queue) {
      throw new McpError(ErrorCode.InvalidParams, 'Queue name is required');
    }

    try {
      const queueUrl = this.buildQueueUrl(params.queue);
      const command = new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
          'ApproximateNumberOfMessagesDelayed',
          'VisibilityTimeout',
          'CreatedTimestamp',
          'LastModifiedTimestamp',
        ],
      });

      const response = await this.sqsClient.send(command);

      const result = {
        queue_name: params.queue,
        approximate_messages: parseInt(response.Attributes?.ApproximateNumberOfMessages || '0', 10),
        in_flight: parseInt(response.Attributes?.ApproximateNumberOfMessagesNotVisible || '0', 10),
        delayed: parseInt(response.Attributes?.ApproximateNumberOfMessagesDelayed || '0', 10),
        visibility_timeout_seconds: parseInt(response.Attributes?.VisibilityTimeout || '0', 10),
        created_timestamp: response.Attributes?.CreatedTimestamp,
        last_modified_timestamp: response.Attributes?.LastModifiedTimestamp,
      };

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const result = {
        error: error instanceof Error ? error.message : 'Failed to get queue status',
        queue: params.queue,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  }

  private async getDLQMessages(
    params: GetDLQMessagesParams,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
      const queueUrl = this.buildQueueUrl(params.queue);
      const command = new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: params.max_messages || 10,
        MessageAttributeNames: ['All'],
      });

      const response = await this.sqsClient.send(command);

      const messages = (response.Messages || []).map((msg) => ({
        message_id: msg.MessageId,
        body: msg.Body,
        attributes: msg.MessageAttributes || {},
        received_count: 1,
        sent_timestamp: undefined,
        receipt_handle: msg.ReceiptHandle,
      }));

      const result = {
        queue: params.queue,
        messages,
        count: messages.length,
      };

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const result = {
        error: error instanceof Error ? error.message : 'Failed to get DLQ messages',
        queue: params.queue,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  }

  private async replayDLQ(
    params: ReplayDLQParams,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
      const queueUrl = this.buildQueueUrl(params.queue);

      const receiveCommand = new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: params.message_ids ? params.message_ids.length : 100,
        MessageAttributeNames: ['All'],
      });

      const response = await this.sqsClient.send(receiveCommand);
      const messages = response.Messages || [];

      if (messages.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ replayed: 0, failed: 0, message: 'No messages to replay' }, null, 2),
            },
          ],
        };
      }

      let replayed = 0;
      let failed = 0;
      const targetQueueUrl = queueUrl.replace('-dlq', '').replace('-DLQ', '');

      for (const message of messages) {
        if (params.message_ids && !params.message_ids.includes(message.MessageId || '')) {
          continue;
        }

        try {
          if (message.Body) {
            const sendCommand = new SendMessageCommand({
              QueueUrl: targetQueueUrl,
              MessageBody: message.Body,
              MessageAttributes: message.MessageAttributes,
            });
            await this.sqsClient.send(sendCommand);
          }

          if (message.ReceiptHandle) {
            const deleteCommand = new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle,
            });
            await this.sqsClient.send(deleteCommand);
          }

          replayed++;
        } catch {
          failed++;
        }
      }

      const result = {
        replayed,
        failed,
        queue: params.queue,
      };

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const result = {
        error: error instanceof Error ? error.message : 'Failed to replay DLQ',
        queue: params.queue,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  }

  private buildQueueUrl(queueName: string): string {
    if (queueName.startsWith('https://')) {
      return queueName;
    }
    return `https://sqs.${this.region}.amazonaws.com/${this.accountId}/${queueName}`;
  }
}