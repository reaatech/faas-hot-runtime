import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import chokidar from 'chokidar';
import { logger } from '../observability/logger.js';
import type { FunctionDefinition } from '../types/index.js';
import { FunctionDefinitionSchema } from '../types/index.js';

export interface FunctionRegistryConfig {
  configDir: string;
  watchEnabled: boolean;
  debounceMs: number;
}

export interface FunctionChangeEvent {
  previous?: FunctionDefinition;
  current?: FunctionDefinition;
}

type FunctionMap = Map<string, FunctionDefinition>;

export class FunctionRegistry {
  private config: FunctionRegistryConfig;
  private functions: FunctionMap = new Map();
  private mcpToolNames: Map<string, string> = new Map();
  private watcher?: chokidar.FSWatcher;
  private fileToFunction: Map<string, string> = new Map();
  private addedCallbacks: Array<(event: FunctionChangeEvent) => Promise<void> | void> = [];
  private updatedCallbacks: Array<(event: FunctionChangeEvent) => Promise<void> | void> = [];
  private removedCallbacks: Array<(event: FunctionChangeEvent) => Promise<void> | void> = [];

  constructor(config: FunctionRegistryConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    logger.info({ configDir: this.config.configDir }, 'Initializing function registry');

    try {
      await fs.promises.access(this.config.configDir, fs.constants.R_OK);
    } catch {
      throw new Error(`Function config directory does not exist or is not readable: ${this.config.configDir}`);
    }

    await this.loadAllFunctions();

    if (this.config.watchEnabled) {
      this.startWatching();
    }
  }

  private async loadAllFunctions(): Promise<void> {
    const files = await fs.promises.readdir(this.config.configDir);
    const yamlFiles = files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

    for (const file of yamlFiles) {
      await this.loadFunctionFile(path.join(this.config.configDir, file));
    }

    logger.info({ count: this.functions.size }, 'Loaded function definitions');
  }

  private async loadFunctionFile(filePath: string): Promise<void> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const data = YAML.parse(content);

      if (data == null) {
        logger.warn({ file: filePath }, 'Empty YAML file, skipping');
        return;
      }

      const validated = FunctionDefinitionSchema.parse(data);

      if (this.functions.has(validated.name)) {
        logger.warn(
          { name: validated.name, file: filePath },
          'Duplicate function name, skipping',
        );
        return;
      }

      if (this.mcpToolNames.has(validated.mcp.tool_name)) {
        logger.warn(
          { tool_name: validated.mcp.tool_name, file: filePath, existing_function: this.mcpToolNames.get(validated.mcp.tool_name) },
          'Duplicate MCP tool name, skipping',
        );
        return;
      }

      this.functions.set(validated.name, validated);
      this.mcpToolNames.set(validated.mcp.tool_name, validated.name);
      this.fileToFunction.set(filePath, validated.name);
      logger.info({ name: validated.name, file: filePath }, 'Loaded function definition');

      if (this.config.watchEnabled) {
        await this.emitChange(this.addedCallbacks, { current: validated });
      }
    } catch (error) {
      logger.error(
        { file: filePath, error: error instanceof Error ? error.message : error },
        'Failed to load function definition',
      );
    }
  }

  private startWatching(): void {
    this.watcher = chokidar.watch(this.config.configDir, {
      ignored: /(^|[/\\])\./,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: this.config.debounceMs,
        pollInterval: 100,
      },
    });

    this.watcher.on('change', (filePath) => {
      if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
        void this.reloadFunctionFile(filePath);
      }
    });

    this.watcher.on('add', (filePath) => {
      if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
        void this.loadFunctionFile(filePath);
      }
    });

    this.watcher.on('unlink', (filePath) => {
      if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
        this.handleFileRemoved(filePath);
      }
    });

    logger.info('Started watching for function definition changes');
  }

  private async reloadFunctionFile(filePath: string): Promise<void> {
    logger.info({ file: filePath }, 'Reloading function definition');

    const newFunctions = new Map(this.functions);
    const newToolNames = new Map(this.mcpToolNames);
    const oldFunctionName = this.fileToFunction.get(filePath);
    const previous = oldFunctionName ? this.functions.get(oldFunctionName) : undefined;

    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const data = YAML.parse(content);

      if (data == null) {
        logger.warn({ file: filePath }, 'Empty YAML file on reload, keeping old version');
        return;
      }

      const validated = FunctionDefinitionSchema.parse(data);

      if (oldFunctionName && oldFunctionName !== validated.name) {
        newFunctions.delete(oldFunctionName);
        for (const [toolName, fnName] of newToolNames.entries()) {
          if (fnName === oldFunctionName) {
            newToolNames.delete(toolName);
            break;
          }
        }
      }

      for (const [name, def] of newFunctions.entries()) {
        if (name !== validated.name && def.mcp.tool_name === validated.mcp.tool_name) {
          throw new Error(`Duplicate MCP tool name: ${validated.mcp.tool_name}`);
        }
      }

      newFunctions.set(validated.name, validated);
      newToolNames.set(validated.mcp.tool_name, validated.name);
      this.fileToFunction.set(filePath, validated.name);

      this.functions = newFunctions;
      this.mcpToolNames = newToolNames;
      logger.info({ name: validated.name }, 'Function definition reloaded');
      await this.emitChange(this.updatedCallbacks, { previous, current: validated });
    } catch (error) {
      logger.error(
        { file: filePath, error: error instanceof Error ? error.message : error },
        'Failed to reload function definition, keeping old version',
      );
    }
  }

  private handleFileRemoved(filePath: string): void {
    const functionName = this.fileToFunction.get(filePath);
    if (functionName && this.functions.has(functionName)) {
      const def = this.functions.get(functionName);
      this.functions.delete(functionName);
      if (def) {
        this.mcpToolNames.delete(def.mcp.tool_name);
      }
      this.fileToFunction.delete(filePath);
      logger.info({ file: filePath, function: functionName }, 'Function definition removed');
      void this.emitChange(this.removedCallbacks, { previous: def });
    }
  }

  onFunctionAdded(callback: (event: FunctionChangeEvent) => Promise<void> | void): void {
    this.addedCallbacks.push(callback);
  }

  onFunctionUpdated(callback: (event: FunctionChangeEvent) => Promise<void> | void): void {
    this.updatedCallbacks.push(callback);
  }

  onFunctionRemoved(callback: (event: FunctionChangeEvent) => Promise<void> | void): void {
    this.removedCallbacks.push(callback);
  }

  private async emitChange(
    callbacks: Array<(event: FunctionChangeEvent) => Promise<void> | void>,
    event: FunctionChangeEvent,
  ): Promise<void> {
    for (const callback of callbacks) {
      try {
        await callback(event);
      } catch (error) {
        logger.error(
          { error: error instanceof Error ? error.message : error, event },
          'Function registry change callback failed',
        );
      }
    }
  }

  getFunction(name: string): FunctionDefinition | undefined {
    return this.functions.get(name);
  }

  getAllFunctions(): FunctionDefinition[] {
    return Array.from(this.functions.values());
  }

  hasFunction(name: string): boolean {
    return this.functions.has(name);
  }

  getFunctionCount(): number {
    return this.functions.size;
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }

    this.fileToFunction.clear();
    this.mcpToolNames.clear();
    logger.info('Function registry stopped');
  }
}
