import { logger } from '../observability/logger.js';
import type { FunctionDefinition, TriggerConfig } from '../types/index.js';
import type { HTTPTriggerHandler } from './http-trigger.js';
import { HTTPTrigger } from './http-trigger.js';
import type { SQSTriggerHandler } from './sqs-trigger.js';
import { SQSTrigger } from './sqs-trigger.js';
import type { PubSubTriggerHandler } from './pubsub-trigger.js';
import { PubSubTrigger } from './pubsub-trigger.js';

export interface TriggerRouterConfig {
  httpPort: number;
  httpHost: string;
  sqsRegion: string;
  sqsAccountId: string;
  pubsubProjectId: string;
}

/**
 * Trigger Router - routes events to appropriate functions
 */
export class TriggerRouter {
  private config: TriggerRouterConfig;
  private httpTrigger?: HTTPTrigger;
  private sqsTriggers: Map<string, SQSTrigger> = new Map();
  private pubSubTriggers: Map<string, PubSubTrigger> = new Map();
  private running: boolean = false;

  constructor(config: TriggerRouterConfig) {
    this.config = config;
  }

  /**
   * Initialize and start all triggers
   */
  async start(): Promise<void> {
    this.running = true;
    logger.info('Starting trigger router');

    // Start HTTP trigger
    this.httpTrigger = new HTTPTrigger({
      host: this.config.httpHost,
      port: this.config.httpPort,
    });
    await this.httpTrigger.start();

    logger.info('Trigger router started');
  }

  /**
   * Stop all triggers
   */
  async stop(): Promise<void> {
    this.running = false;
    logger.info('Stopping trigger router');

    if (this.httpTrigger) {
      await this.httpTrigger.stop();
    }

    for (const sqs of this.sqsTriggers.values()) {
      await sqs.stop();
    }

    for (const pubsub of this.pubSubTriggers.values()) {
      await pubsub.stop();
    }

    logger.info('Trigger router stopped');
  }

  /**
   * Register function triggers
   */
  async registerFunction(
    func: FunctionDefinition,
    handlers: {
      http?: HTTPTriggerHandler;
      sqs?: SQSTriggerHandler;
      pubsub?: PubSubTriggerHandler;
    },
  ): Promise<void> {
    for (const trigger of func.triggers) {
      switch (trigger.type) {
        case 'http':
          if (this.httpTrigger && handlers.http) {
            this.httpTrigger.registerFunction(func, handlers.http);
          }
          break;

        case 'sqs':
          await this.registerSQSTrigger(func, trigger, handlers.sqs);
          break;

        case 'pubsub':
          await this.registerPubSubTrigger(func, trigger, handlers.pubsub);
          break;
      }
    }
  }

  /**
   * Register SQS trigger for a function
   */
  private async registerSQSTrigger(
    func: FunctionDefinition,
    trigger: Extract<TriggerConfig, { type: 'sqs' }>,
    handler?: SQSTriggerHandler,
  ): Promise<void> {
    let sqsTrigger = this.sqsTriggers.get(trigger.queue);
      if (!sqsTrigger) {
        sqsTrigger = new SQSTrigger({
          queueUrl: `https://sqs.${this.config.sqsRegion}.amazonaws.com/${this.config.sqsAccountId}/${trigger.queue}`,
          region: this.config.sqsRegion,
          accountId: this.config.sqsAccountId,
          queueName: trigger.queue,
          batchSize: trigger.batch_size || 10,
          visibilityTimeoutSeconds: trigger.visibility_timeout_seconds || 300,
          maxReceiveCount: 3,
          pollIntervalMs: 1000,
        });

      if (this.running) {
        await sqsTrigger.start();
      }

      this.sqsTriggers.set(trigger.queue, sqsTrigger);
    }

    if (handler) {
      sqsTrigger.registerFunction(func, handler);
    }
  }

  /**
   * Register Pub/Sub trigger for a function
   */
  private async registerPubSubTrigger(
    func: FunctionDefinition,
    trigger: Extract<TriggerConfig, { type: 'pubsub' }>,
    handler?: PubSubTriggerHandler,
  ): Promise<void> {
    let pubsubTrigger = this.pubSubTriggers.get(trigger.topic);
    if (!pubsubTrigger) {
      pubsubTrigger = new PubSubTrigger({
        projectId: this.config.pubsubProjectId,
        topicName: trigger.topic,
        subscriptionName: trigger.subscription || `${trigger.topic}-sub`,
        maxMessages: 10,
        ackDeadlineSeconds: 30,
      });

      if (this.running) {
        await pubsubTrigger.start();
      }

      this.pubSubTriggers.set(trigger.topic, pubsubTrigger);
    }

    if (handler) {
      pubsubTrigger.registerFunction(func, handler);
    }
  }

  /**
   * Unregister function triggers
   */
  async unregisterFunction(func: FunctionDefinition): Promise<void> {
    for (const trigger of func.triggers) {
      switch (trigger.type) {
        case 'http':
          if (this.httpTrigger) {
            this.httpTrigger.unregisterFunction(func.name);
          }
          break;

        case 'sqs':
          {
            const sqsTrigger = this.sqsTriggers.get(trigger.queue);
            if (sqsTrigger) {
              sqsTrigger.unregisterFunction(func.name);
            }
          }
          break;

        case 'pubsub':
          {
            const pubsubTrigger = this.pubSubTriggers.get(trigger.topic);
            if (pubsubTrigger) {
              pubsubTrigger.unregisterFunction(func.name);
            }
          }
          break;
      }
    }
  }

  /**
   * Get trigger statistics
   */
  getStats(): {
    http: { functions: number; port: number };
    sqs: { queues: number; total_functions: number };
    pubsub: { topics: number; total_functions: number };
  } {
    let sqsFunctions = 0;
    for (const _sqs of this.sqsTriggers.values()) {
      sqsFunctions++;
    }

    let pubsubFunctions = 0;
    for (const _pubsubTrigger of this.pubSubTriggers.values()) {
      pubsubFunctions++;
    }

    return {
      http: {
        functions: this.httpTrigger ? 1 : 0,
        port: this.config.httpPort,
      },
      sqs: {
        queues: this.sqsTriggers.size,
        total_functions: sqsFunctions,
      },
      pubsub: {
        topics: this.pubSubTriggers.size,
        total_functions: pubsubFunctions,
      },
    };
  }
}
