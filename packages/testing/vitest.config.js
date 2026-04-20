import { defineConfig } from 'vitest/config';
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  test: {
    dangerouslyIgnoreUnhandledErrors: true,
    projects: [
      // Unit tests - Node environment (Browser, cookie-utils)
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
          setupFiles: ['./test/unit/setup.ts'],
        },
      },

      // Integration tests - Core testing library functionality
      {
        plugins: [cloudflareTest({
          wrangler: { configPath: './test/integration/wrangler.jsonc' },
        })],
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 2000,
          globals: true,
        },
      },
      
      // Alarm simulation pedagogical tests
      {
        plugins: [cloudflareTest({
          wrangler: { configPath: './test/alarm-simulation/wrangler.jsonc' },
        })],
        test: {
          name: 'alarm-simulation',
          include: ['test/alarm-simulation/**/*.test.ts'],
          testTimeout: 25000,  // 25 seconds for actor-alarms test (needs 20s)
          globals: true,
        },
      },
      
      // Alarm workarounds pedagogical tests
      {
        plugins: [cloudflareTest({
          wrangler: { configPath: './test/alarm-workarounds/wrangler.jsonc' },
        })],
        test: {
          name: 'alarm-workarounds',
          include: ['test/alarm-workarounds/**/*.test.ts'],
          testTimeout: 2000,
          globals: true,
        },
      },
      
      // Actor alarms integration tests
      {
        plugins: [cloudflareTest({
          wrangler: { configPath: './test/actor-alarms/wrangler.jsonc' },
        })],
        test: {
          name: 'actor-alarms',
          include: ['test/actor-alarms/**/*.test.ts'],
          testTimeout: 30000,  // 30 seconds for Actor Alarms with 1x timescale
          globals: true,
        },
      },
    ],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
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
