import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'coverage'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      thresholds: {
        global: {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
      },
      include: ['src/**/*.{ts,js}'],
      exclude: [
        'src/index.ts',
        'src/cli.ts',
        'src/observability/**',
        'src/k8s/**',
      ],
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    silent: false,
    reporters: ['default'],
    outputFile: {
      junit: './reports/junit.xml',
      json: './reports/test-results.json',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
