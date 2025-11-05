import { defineConfig } from 'vitest/config';
import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineConfig({
  test: {
    projects: [
      // Integration tests - Core testing library functionality
      defineWorkersProject({
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 2000,
          globals: true,
          poolOptions: {
            workers: {
              isolatedStorage: false,  // Must be false for WebSocket support
              wrangler: { configPath: './test/integration/wrangler.jsonc' },
            },
          },
        },
      }),
      
      // Alarm simulation pedagogical tests
      defineWorkersProject({
        test: {
          name: 'alarm-simulation',
          include: ['test/alarm-simulation/**/*.test.ts'],
          testTimeout: 25000,  // 25 seconds for actor-alarms test (needs 20s)
          globals: true,
          poolOptions: {
            workers: {
              isolatedStorage: false,
              wrangler: { configPath: './test/alarm-simulation/wrangler.jsonc' },
            },
          },
        },
      }),
      
      // Alarm workarounds pedagogical tests
      defineWorkersProject({
        test: {
          name: 'alarm-workarounds',
          include: ['test/alarm-workarounds/**/*.test.ts'],
          testTimeout: 2000,
          globals: true,
          poolOptions: {
            workers: {
              isolatedStorage: false,
              wrangler: { configPath: './test/alarm-workarounds/wrangler.jsonc' },
            },
          },
        },
      }),
      
      // Actor alarms integration tests
      defineWorkersProject({
        test: {
          name: 'actor-alarms',
          include: ['test/actor-alarms/**/*.test.ts'],
          testTimeout: 30000,  // 30 seconds for Actor Alarms with 1x timescale
          globals: true,
          poolOptions: {
            workers: {
              isolatedStorage: false,
              wrangler: { configPath: './test/actor-alarms/wrangler.jsonc' },
            },
          },
        },
      }),
    ],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'html'],
      include: [
        '**/src/**',
        '**/test/integration/test-worker-and-dos.ts'
      ],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/*.config.*',
        '**/scratch/**',
        '**/test/**/*.test.ts'
      ],
      skipFull: false,
      all: false,
    },
  },
});
