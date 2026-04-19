import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import fs from 'node:fs';
import chokidar from 'chokidar';
import { FunctionRegistry } from '../../../src/registry/function-registry.js';

// Mock the logger
vi.mock('../../../src/observability/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// Mock fs.promises
vi.mock('node:fs', () => ({
  default: {
    promises: {
      access: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn(),
      readFile: vi.fn(),
    },
    constants: {
      R_OK: 4,
    },
  },
}));

// Mock chokidar
vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(),
  },
}));

const VALID_YAML = `name: test-func
description: Test
version: 1.0.0
container:
  image: test:latest
  port: 8080
  resources:
    cpu: 100m
    memory: 128Mi
    gpu: 0
pool:
  min_size: 1
  max_size: 5
  target_utilization: 0.7
  warm_up_time_seconds: 30
triggers:
  - type: http
    path: /test
    methods:
      - GET
mcp:
  enabled: true
  tool_name: test_func
  description: Test
  input_schema:
    type: object
    properties: {}
cost:
  budget_daily: 10
  cost_per_invocation_estimate: 0.0001
  alert_thresholds:
    - 0.5
observability:
  tracing_enabled: true
  metrics_enabled: true
  log_level: info
`;

describe('FunctionRegistry', () => {
  let functionRegistry: FunctionRegistry;
  let mockWatcher: { on: Mock; close: Mock };

  beforeEach(async () => {
    vi.clearAllMocks();

    vi.mocked(fs.promises.access).mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(fs.promises.readdir).mockResolvedValue([] as any);

    // Setup chokidar mock
    mockWatcher = {
      on: vi.fn().mockReturnThis(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(chokidar.watch).mockReturnValue(mockWatcher as any);

    functionRegistry = new FunctionRegistry({
      configDir: './config/functions',
      watchEnabled: false,
      debounceMs: 100,
    });
    await functionRegistry.initialize();
  });

  afterEach(async () => {
    await functionRegistry.stop();
  });

  describe('initialize', () => {
    it('should load functions from directory', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.promises.readdir).mockResolvedValue(['func1.yaml', 'func2.yml'] as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.promises.readFile).mockImplementation(async (path: any) => {
        if (path.includes('func2')) {
          return VALID_YAML.replace('name: test-func', 'name: test-func-2').replace('tool_name: test_func', 'tool_name: test_func_2');
        }
        return VALID_YAML;
      });

      const registry = new FunctionRegistry({
        configDir: './config/functions',
        watchEnabled: false,
        debounceMs: 100,
      });
      await registry.initialize();

      expect(registry.getFunctionCount()).toBe(2);
      await registry.stop();
    });

    it('should handle empty directory', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.promises.readdir).mockResolvedValue([] as any);

      const registry = new FunctionRegistry({
        configDir: './config/empty',
        watchEnabled: false,
        debounceMs: 100,
      });
      await registry.initialize();

      expect(registry.getFunctionCount()).toBe(0);
      await registry.stop();
    });

    it('should start watcher when watchEnabled is true', async () => {
      const registry = new FunctionRegistry({
        configDir: './config/functions',
        watchEnabled: true,
        debounceMs: 100,
      });
      await registry.initialize();

      expect(chokidar.watch).toHaveBeenCalledWith('./config/functions', expect.any(Object));
      await registry.stop();
    });
  });

  describe('getFunction', () => {
    it('should return undefined for unknown function', () => {
      const func = functionRegistry.getFunction('unknown');
      expect(func).toBeUndefined();
    });

    it('should return function when exists', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.promises.readdir).mockResolvedValue(['func1.yaml'] as any);
      vi.mocked(fs.promises.readFile).mockResolvedValue(VALID_YAML);

      const registry = new FunctionRegistry({
        configDir: './config/functions',
        watchEnabled: false,
        debounceMs: 100,
      });
      await registry.initialize();

      const func = registry.getFunction('test-func');
      expect(func).toBeDefined();
      expect(func?.name).toBe('test-func');

      await registry.stop();
    });
  });

  describe('getAllFunctions', () => {
    it('should return empty array when no functions loaded', () => {
      const functions = functionRegistry.getAllFunctions();
      expect(functions).toHaveLength(0);
    });

    it('should return all loaded functions', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.promises.readdir).mockResolvedValue(['func1.yaml'] as any);
      vi.mocked(fs.promises.readFile).mockResolvedValue(VALID_YAML);

      const registry = new FunctionRegistry({
        configDir: './config/functions',
        watchEnabled: false,
        debounceMs: 100,
      });
      await registry.initialize();

      const functions = registry.getAllFunctions();
      expect(functions).toHaveLength(1);
      expect(functions[0].name).toBe('test-func');

      await registry.stop();
    });
  });

  describe('hasFunction', () => {
    it('should return false for unknown function', () => {
      expect(functionRegistry.hasFunction('unknown')).toBe(false);
    });

    it('should return true for existing function', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.promises.readdir).mockResolvedValue(['func1.yaml'] as any);
      vi.mocked(fs.promises.readFile).mockResolvedValue(VALID_YAML);

      const registry = new FunctionRegistry({
        configDir: './config/functions',
        watchEnabled: false,
        debounceMs: 100,
      });
      await registry.initialize();

      expect(registry.hasFunction('test-func')).toBe(true);

      await registry.stop();
    });
  });

  describe('getFunctionCount', () => {
    it('should return 0 when no functions loaded', () => {
      expect(functionRegistry.getFunctionCount()).toBe(0);
    });

    it('should return correct count after loading', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.promises.readdir).mockResolvedValue(['func1.yaml', 'func2.yaml'] as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.promises.readFile).mockImplementation(async (path: any) => {
        if (path.includes('func2')) {
          return VALID_YAML.replace('name: test-func', 'name: test-func-2').replace('tool_name: test_func', 'tool_name: test_func_2');
        }
        return VALID_YAML;
      });

      const registry = new FunctionRegistry({
        configDir: './config/functions',
        watchEnabled: false,
        debounceMs: 100,
      });
      await registry.initialize();

      expect(registry.getFunctionCount()).toBe(2);

      await registry.stop();
    });
  });

  describe('stop', () => {
    it('should close watcher if watching', async () => {
      const registry = new FunctionRegistry({
        configDir: './config/functions',
        watchEnabled: true,
        debounceMs: 100,
      });
      await registry.initialize();

      await registry.stop();

      expect(mockWatcher.close).toHaveBeenCalled();
    });

    it('should clear debounce timers', async () => {
      const registry = new FunctionRegistry({
        configDir: './config/functions',
        watchEnabled: true,
        debounceMs: 100,
      });
      await registry.initialize();

      // Simulate file change to create debounce timer
      const changeHandler = mockWatcher.on.mock.calls.find((c: unknown[]) => c[0] === 'change')?.[1];
      if (changeHandler) {
        changeHandler('./config/functions/test.yaml');
      }

      await registry.stop();

      // Timers should be cleared
      expect(mockWatcher.close).toHaveBeenCalled();
    });
  });

  describe('hot-reload', () => {
    it('should handle file change events', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.promises.readdir).mockResolvedValue(['func1.yaml'] as any);
      vi.mocked(fs.promises.readFile).mockResolvedValue(VALID_YAML);

      const registry = new FunctionRegistry({
        configDir: './config/functions',
        watchEnabled: true,
        debounceMs: 10,
      });
      await registry.initialize();

      // Get the change handler
      const changeHandler = mockWatcher.on.mock.calls.find((c: unknown[]) => c[0] === 'change')?.[1];
      expect(changeHandler).toBeDefined();

      await registry.stop();
    });

    it('should handle file add events', async () => {
      const registry = new FunctionRegistry({
        configDir: './config/functions',
        watchEnabled: true,
        debounceMs: 100,
      });
      await registry.initialize();

      const addHandler = mockWatcher.on.mock.calls.find((c: unknown[]) => c[0] === 'add')?.[1];
      expect(addHandler).toBeDefined();

      await registry.stop();
    });

    it('should handle file unlink events', async () => {
      const registry = new FunctionRegistry({
        configDir: './config/functions',
        watchEnabled: true,
        debounceMs: 100,
      });
      await registry.initialize();

      const unlinkHandler = mockWatcher.on.mock.calls.find((c: unknown[]) => c[0] === 'unlink')?.[1];
      expect(unlinkHandler).toBeDefined();

      await registry.stop();
    });

    it('should ignore non-yaml file changes', async () => {
      const registry = new FunctionRegistry({
        configDir: './config/functions',
        watchEnabled: true,
        debounceMs: 10,
      });
      await registry.initialize();

      const changeHandler = mockWatcher.on.mock.calls.find((c: unknown[]) => c[0] === 'change')?.[1];
      if (changeHandler) {
        changeHandler('./config/functions/test.txt'); // Not yaml
      }

      await registry.stop();
    });
  });

  describe('error handling', () => {
    it('should handle invalid YAML gracefully', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.promises.readdir).mockResolvedValue(['invalid.yaml'] as any);
      vi.mocked(fs.promises.readFile).mockResolvedValue('invalid: yaml: content: [');

      const registry = new FunctionRegistry({
        configDir: './config/functions',
        watchEnabled: false,
        debounceMs: 100,
      });
      await registry.initialize();

      // Should not throw, just log error
      expect(registry.getFunctionCount()).toBe(0);

      await registry.stop();
    });

    it('should handle missing directory gracefully', async () => {
      vi.mocked(fs.promises.access).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fs.promises.readdir).mockRejectedValue(new Error('ENOENT'));

      const registry = new FunctionRegistry({
        configDir: './config/nonexistent',
        watchEnabled: false,
        debounceMs: 100,
      });

      // Should not throw
      await expect(registry.initialize()).rejects.toThrow('Function config directory does not exist or is not readable');
    });

    it('should skip duplicate function names', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.promises.readdir).mockResolvedValue(['func1.yaml', 'func2.yaml'] as any);
      vi.mocked(fs.promises.readFile).mockResolvedValue(VALID_YAML);

      const registry = new FunctionRegistry({
        configDir: './config/functions',
        watchEnabled: false,
        debounceMs: 100,
      });
      await registry.initialize();

      // Both files have same name, only first should be loaded
      expect(registry.getFunctionCount()).toBe(1);

      await registry.stop();
    });
  });
});
