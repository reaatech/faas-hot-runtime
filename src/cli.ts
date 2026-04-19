#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Command } from 'commander';
import { logger } from './observability/logger.js';
import { FunctionRegistry } from './registry/function-registry.js';
import { SchemaValidator } from './registry/schema-validator.js';
import { MCPServer } from './mcp-server/mcp-server.js';
import { ToolRegistry } from './mcp-server/tool-registry.js';
import { RequestHandler } from './mcp-server/request-handler.js';
import { InvokerEngine } from './invoker/invoker-engine.js';
import { PoolManager } from './pool-manager/pool-manager.js';
import { K8sClient } from './k8s/k8s-client.js';

const pkg = JSON.parse(
  fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
);

const program = new Command();

program
  .name('faas-hot-runtime')
  .description('MCP-native FaaS runtime with warm pod pools for sub-100ms invocations')
  .version(pkg.version);

program
  .command('start')
  .description('Start the FaaS runtime server')
  .option('-p, --port <number>', 'Port to listen on', (v) => parseInt(v, 10), 8080)
  .option('-h, --host <host>', 'Host to bind to', '127.0.0.1')
  .option('-c, --config-dir <dir>', 'Directory containing function definitions', './config/functions')
  .option('--api-key <key>', 'API key for authentication', process.env.FAAS_API_KEY ?? 'dev-api-key')
  .action(async (options) => {
    const registry = new FunctionRegistry({
      configDir: options.configDir,
      watchEnabled: true,
      debounceMs: 500,
    });

    await registry.initialize();

    const functions = registry.getAllFunctions();
    console.log(`Loaded ${functions.length} function(s):`);
    for (const fn of functions) {
      console.log(`  - ${fn.name}: ${fn.description}`);
    }
    console.log('');

    const toolRegistry = new ToolRegistry();
    for (const fn of functions) {
      toolRegistry.registerTool(fn);
    }

    const k8sClient = new K8sClient({
      namespace: process.env.K8S_NAMESPACE ?? 'default',
    });
    await k8sClient.initialize();

    const poolManager = new PoolManager({
      defaultMinSize: 2,
      defaultMaxSize: 10,
      defaultTargetUtilization: 0.7,
      healthCheckIntervalMs: 30000,
      scaleUpThreshold: 0.8,
      scaleDownThreshold: 0.3,
      scalingCooldownSeconds: 60,
    }, k8sClient);
    await poolManager.initialize();

    for (const fn of functions) {
      await poolManager.createPool(fn);
    }

    const invokerEngine = new InvokerEngine(poolManager, registry);

    const requestHandler = new RequestHandler(toolRegistry, invokerEngine, registry);

    const server = new MCPServer(
      {
        host: options.host,
        port: options.port,
        apiKey: options.apiKey,
      },
      toolRegistry,
      requestHandler,
    );
    toolRegistry.setPoolUtilizationFn(() => poolManager.getPoolUtilization());

    registry.onFunctionAdded(async ({ current }) => {
      if (!current) {
        return;
      }

      await poolManager.createPool(current);
      server.registerFunction(current);
    });

    registry.onFunctionUpdated(async ({ previous, current }) => {
      if (previous) {
        server.unregisterFunction(previous.name);
        await poolManager.unregisterFunction(previous.name);
      }

      if (current) {
        await poolManager.createPool(current);
        server.registerFunction(current);
      }
    });

    registry.onFunctionRemoved(async ({ previous }) => {
      if (!previous) {
        return;
      }

      server.unregisterFunction(previous.name);
      await poolManager.unregisterFunction(previous.name);
    });

    console.log(`Starting MCP server on ${options.host}:${options.port}...`);
    await server.start();
    console.log('Server started. Press Ctrl+C to stop.');

    const shutdown = async () => {
      console.log('\nShutting down...');
      await server.stop();
      await invokerEngine.stop();
      await poolManager.stop();
      await registry.stop();
      process.exit(0);
    };

    process.once('SIGINT', () => {
      void shutdown();
    });
    process.once('SIGTERM', () => {
      void shutdown();
    });
  });

program
  .command('invoke')
  .description('Invoke a function directly')
  .requiredOption('-f, --function <name>', 'Function name to invoke')
  .option('-a, --args <json>', 'Function arguments as JSON', '{}')
  .option('-t, --timeout <number>', 'Invocation timeout in milliseconds', (v) => parseInt(v, 10), 30000)
  .option('-c, --config-dir <dir>', 'Directory containing function definitions', './config/functions')
  .action(async (options) => {
    let parsedArgs: Record<string, unknown>;
    try {
      parsedArgs = JSON.parse(options.args);
    } catch {
      console.error('Error: --args must be valid JSON');
      process.exit(1);
    }

    const registry = new FunctionRegistry({
      configDir: options.configDir,
      watchEnabled: false,
      debounceMs: 0,
    });
    await registry.initialize();

    const k8sClient = new K8sClient({
      namespace: process.env.K8S_NAMESPACE ?? 'default',
    });
    await k8sClient.initialize();

    const poolManager = new PoolManager({
      defaultMinSize: 2,
      defaultMaxSize: 10,
      defaultTargetUtilization: 0.7,
      healthCheckIntervalMs: 30000,
      scaleUpThreshold: 0.8,
      scaleDownThreshold: 0.3,
      scalingCooldownSeconds: 60,
    }, k8sClient);
    await poolManager.initialize();

    const functionDef = registry.getFunction(options.function);
    if (!functionDef) {
      console.error(`Error: function "${options.function}" not found`);
      process.exit(1);
    }

    await poolManager.createPool(functionDef);

    const invoker = new InvokerEngine(poolManager, registry);

    const result = await invoker.invoke({
      function: options.function,
      arguments: parsedArgs,
      request_id: crypto.randomUUID(),
      timeout_ms: options.timeout,
    });

    console.log(JSON.stringify(result, null, 2));
    await invoker.stop();
    await poolManager.stop();
    await registry.stop();
  });

program
  .command('list')
  .description('List all registered functions')
  .option('-c, --config-dir <dir>', 'Directory containing function definitions', './config/functions')
  .action(async (options) => {
    const registry = new FunctionRegistry({
      configDir: options.configDir,
      watchEnabled: false,
      debounceMs: 0,
    });

    await registry.initialize();

    const functions = registry.getAllFunctions();
    if (functions.length === 0) {
      console.log('No functions registered.');
      return;
    }

    console.log(`Registered functions (${functions.length}):\n`);
    for (const fn of functions) {
      console.log(`  ${fn.name}`);
      console.log(`    Description: ${fn.description}`);
      console.log(`    Version: ${fn.version}`);
      console.log(`    Triggers: ${fn.triggers.map((t) => t.type).join(', ')}`);
      console.log(`    MCP Tool: ${fn.mcp.tool_name}`);
      console.log('');
    }
  });

program
  .command('validate')
  .description('Validate function configuration files')
  .option('-c, --config-dir <dir>', 'Directory containing function definitions', './config/functions')
  .action(async (options) => {
    const configDir = options.configDir;

    const files = await fs.promises.readdir(configDir);
    const yamlFiles = files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

    if (yamlFiles.length === 0) {
      console.log('No function definition files found.');
      return;
    }

    const validator = new SchemaValidator();
    let validCount = 0;
    let invalidCount = 0;

    for (const file of yamlFiles) {
      const filePath = path.join(configDir, file);
      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const data = YAML.parse(content);
        const result = validator.validateFunctionDefinition(data);

        if (result.valid) {
          console.log(`  ✓ ${file}: valid`);
          validCount++;
          if (data.name) {
            validator.registerFunction(data.name, data.mcp?.tool_name);
          }
        } else {
          console.log(`  ✗ ${file}: invalid`);
          for (const err of result.errors) {
            console.log(`      Error: ${err}`);
          }
          invalidCount++;
        }

        for (const warn of result.warnings) {
          console.log(`      Warning: ${warn}`);
        }
      } catch (error) {
        console.log(`  ✗ ${file}: failed to parse`);
        console.log(`      ${error instanceof Error ? error.message : error}`);
        invalidCount++;
      }
    }

    console.log('');
    console.log(`Validation complete: ${validCount} valid, ${invalidCount} invalid`);
    if (invalidCount > 0) {
      process.exit(1);
    }
  });

program
  .command('logs')
  .description('Stream function logs')
  .requiredOption('-f, --function <name>', 'Function name')
  .option('--follow', 'Follow log output', false)
  .option('--since <duration>', 'Show logs since duration (e.g., 1h, 30m)', '1h')
  .option('-n, --tail <number>', 'Number of lines to show', (v) => parseInt(v, 10), 100)
  .action(async (options) => {
    console.log(`Streaming logs for: ${options.function}`);
    console.log('This command requires a running faas-hot-runtime server.');
    console.log('Use: curl http://<host>:<port>/logs?function=<name>');
  });

program
  .command('metrics')
  .description('Show function metrics')
  .requiredOption('-f, --function <name>', 'Function name')
  .option('--period <duration>', 'Time period for metrics (e.g., 1h, 24h)', '1h')
  .action(async (options) => {
    console.log(`Metrics for: ${options.function}`);
    console.log('This command requires a running faas-hot-runtime server.');
    console.log('Use: curl -H "X-API-Key: <key>" http://<host>:<port>/metrics');
  });

program
  .command('cost')
  .description('Show cost breakdown')
  .option('--period <duration>', 'Time period for cost report (e.g., 1d, 7d, 30d)', '1d')
  .option('-f, --function <name>', 'Filter by function name')
  .action(async (options) => {
    console.log('Cost breakdown:');
    console.log(`  Period: ${options.period}`);
    if (options.function) {
      console.log(`  Function: ${options.function}`);
    }
    console.log('');
    console.log('This command requires a running faas-hot-runtime server.');
    console.log('Use the get_cost_report MCP tool or query the cost API endpoint.');
  });

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled rejection');
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

try {
  program.parse();
} catch (error) {
  logger.error({ error }, 'CLI error');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
