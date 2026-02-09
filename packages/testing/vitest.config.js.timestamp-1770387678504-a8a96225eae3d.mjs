// packages/testing/vitest.config.js
import { defineConfig } from "file:///sessions/vigilant-vibrant-curie/mnt/lumenize/node_modules/vitest/dist/config.js";
import { defineWorkersProject } from "file:///sessions/vigilant-vibrant-curie/mnt/lumenize/node_modules/@cloudflare/vitest-pool-workers/dist/config/index.cjs";
var vitest_config_default = defineConfig({
  test: {
    projects: [
      // Unit tests - Node environment (Browser, cookie-utils)
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["test/unit/**/*.test.ts"],
          setupFiles: ["./test/unit/setup.ts"]
        }
      },
      // Integration tests - Core testing library functionality
      defineWorkersProject({
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          testTimeout: 2e3,
          globals: true,
          poolOptions: {
            workers: {
              isolatedStorage: false,
              // Must be false for WebSocket support
              wrangler: { configPath: "./test/integration/wrangler.jsonc" }
            }
          }
        }
      }),
      // Alarm simulation pedagogical tests
      defineWorkersProject({
        test: {
          name: "alarm-simulation",
          include: ["test/alarm-simulation/**/*.test.ts"],
          testTimeout: 25e3,
          // 25 seconds for actor-alarms test (needs 20s)
          globals: true,
          poolOptions: {
            workers: {
              isolatedStorage: false,
              wrangler: { configPath: "./test/alarm-simulation/wrangler.jsonc" }
            }
          }
        }
      }),
      // Alarm workarounds pedagogical tests
      defineWorkersProject({
        test: {
          name: "alarm-workarounds",
          include: ["test/alarm-workarounds/**/*.test.ts"],
          testTimeout: 2e3,
          globals: true,
          poolOptions: {
            workers: {
              isolatedStorage: false,
              wrangler: { configPath: "./test/alarm-workarounds/wrangler.jsonc" }
            }
          }
        }
      }),
      // Actor alarms integration tests
      defineWorkersProject({
        test: {
          name: "actor-alarms",
          include: ["test/actor-alarms/**/*.test.ts"],
          testTimeout: 3e4,
          // 30 seconds for Actor Alarms with 1x timescale
          globals: true,
          poolOptions: {
            workers: {
              isolatedStorage: false,
              wrangler: { configPath: "./test/actor-alarms/wrangler.jsonc" }
            }
          }
        }
      })
    ],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "html", "lcov"],
      include: [
        "**/src/**",
        "**/test/integration/test-worker-and-dos.ts"
      ],
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/build/**",
        "**/*.config.*",
        "**/scratch/**",
        "**/test/**/*.test.ts"
      ],
      skipFull: false,
      all: false
    }
  }
});
export {
  vitest_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsicGFja2FnZXMvdGVzdGluZy92aXRlc3QuY29uZmlnLmpzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL3Nlc3Npb25zL3ZpZ2lsYW50LXZpYnJhbnQtY3VyaWUvbW50L2x1bWVuaXplL3BhY2thZ2VzL3Rlc3RpbmdcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9zZXNzaW9ucy92aWdpbGFudC12aWJyYW50LWN1cmllL21udC9sdW1lbml6ZS9wYWNrYWdlcy90ZXN0aW5nL3ZpdGVzdC5jb25maWcuanNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL3Nlc3Npb25zL3ZpZ2lsYW50LXZpYnJhbnQtY3VyaWUvbW50L2x1bWVuaXplL3BhY2thZ2VzL3Rlc3Rpbmcvdml0ZXN0LmNvbmZpZy5qc1wiO2ltcG9ydCB7IGRlZmluZUNvbmZpZyB9IGZyb20gJ3ZpdGVzdC9jb25maWcnO1xuaW1wb3J0IHsgZGVmaW5lV29ya2Vyc1Byb2plY3QgfSBmcm9tIFwiQGNsb3VkZmxhcmUvdml0ZXN0LXBvb2wtd29ya2Vycy9jb25maWdcIjtcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcbiAgdGVzdDoge1xuICAgIHByb2plY3RzOiBbXG4gICAgICAvLyBVbml0IHRlc3RzIC0gTm9kZSBlbnZpcm9ubWVudCAoQnJvd3NlciwgY29va2llLXV0aWxzKVxuICAgICAge1xuICAgICAgICB0ZXN0OiB7XG4gICAgICAgICAgbmFtZTogJ3VuaXQnLFxuICAgICAgICAgIGVudmlyb25tZW50OiAnbm9kZScsXG4gICAgICAgICAgaW5jbHVkZTogWyd0ZXN0L3VuaXQvKiovKi50ZXN0LnRzJ10sXG4gICAgICAgICAgc2V0dXBGaWxlczogWycuL3Rlc3QvdW5pdC9zZXR1cC50cyddLFxuICAgICAgICB9LFxuICAgICAgfSxcblxuICAgICAgLy8gSW50ZWdyYXRpb24gdGVzdHMgLSBDb3JlIHRlc3RpbmcgbGlicmFyeSBmdW5jdGlvbmFsaXR5XG4gICAgICBkZWZpbmVXb3JrZXJzUHJvamVjdCh7XG4gICAgICAgIHRlc3Q6IHtcbiAgICAgICAgICBuYW1lOiAnaW50ZWdyYXRpb24nLFxuICAgICAgICAgIGluY2x1ZGU6IFsndGVzdC9pbnRlZ3JhdGlvbi8qKi8qLnRlc3QudHMnXSxcbiAgICAgICAgICB0ZXN0VGltZW91dDogMjAwMCxcbiAgICAgICAgICBnbG9iYWxzOiB0cnVlLFxuICAgICAgICAgIHBvb2xPcHRpb25zOiB7XG4gICAgICAgICAgICB3b3JrZXJzOiB7XG4gICAgICAgICAgICAgIGlzb2xhdGVkU3RvcmFnZTogZmFsc2UsICAvLyBNdXN0IGJlIGZhbHNlIGZvciBXZWJTb2NrZXQgc3VwcG9ydFxuICAgICAgICAgICAgICB3cmFuZ2xlcjogeyBjb25maWdQYXRoOiAnLi90ZXN0L2ludGVncmF0aW9uL3dyYW5nbGVyLmpzb25jJyB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgICBcbiAgICAgIC8vIEFsYXJtIHNpbXVsYXRpb24gcGVkYWdvZ2ljYWwgdGVzdHNcbiAgICAgIGRlZmluZVdvcmtlcnNQcm9qZWN0KHtcbiAgICAgICAgdGVzdDoge1xuICAgICAgICAgIG5hbWU6ICdhbGFybS1zaW11bGF0aW9uJyxcbiAgICAgICAgICBpbmNsdWRlOiBbJ3Rlc3QvYWxhcm0tc2ltdWxhdGlvbi8qKi8qLnRlc3QudHMnXSxcbiAgICAgICAgICB0ZXN0VGltZW91dDogMjUwMDAsICAvLyAyNSBzZWNvbmRzIGZvciBhY3Rvci1hbGFybXMgdGVzdCAobmVlZHMgMjBzKVxuICAgICAgICAgIGdsb2JhbHM6IHRydWUsXG4gICAgICAgICAgcG9vbE9wdGlvbnM6IHtcbiAgICAgICAgICAgIHdvcmtlcnM6IHtcbiAgICAgICAgICAgICAgaXNvbGF0ZWRTdG9yYWdlOiBmYWxzZSxcbiAgICAgICAgICAgICAgd3JhbmdsZXI6IHsgY29uZmlnUGF0aDogJy4vdGVzdC9hbGFybS1zaW11bGF0aW9uL3dyYW5nbGVyLmpzb25jJyB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgICBcbiAgICAgIC8vIEFsYXJtIHdvcmthcm91bmRzIHBlZGFnb2dpY2FsIHRlc3RzXG4gICAgICBkZWZpbmVXb3JrZXJzUHJvamVjdCh7XG4gICAgICAgIHRlc3Q6IHtcbiAgICAgICAgICBuYW1lOiAnYWxhcm0td29ya2Fyb3VuZHMnLFxuICAgICAgICAgIGluY2x1ZGU6IFsndGVzdC9hbGFybS13b3JrYXJvdW5kcy8qKi8qLnRlc3QudHMnXSxcbiAgICAgICAgICB0ZXN0VGltZW91dDogMjAwMCxcbiAgICAgICAgICBnbG9iYWxzOiB0cnVlLFxuICAgICAgICAgIHBvb2xPcHRpb25zOiB7XG4gICAgICAgICAgICB3b3JrZXJzOiB7XG4gICAgICAgICAgICAgIGlzb2xhdGVkU3RvcmFnZTogZmFsc2UsXG4gICAgICAgICAgICAgIHdyYW5nbGVyOiB7IGNvbmZpZ1BhdGg6ICcuL3Rlc3QvYWxhcm0td29ya2Fyb3VuZHMvd3JhbmdsZXIuanNvbmMnIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICAgIFxuICAgICAgLy8gQWN0b3IgYWxhcm1zIGludGVncmF0aW9uIHRlc3RzXG4gICAgICBkZWZpbmVXb3JrZXJzUHJvamVjdCh7XG4gICAgICAgIHRlc3Q6IHtcbiAgICAgICAgICBuYW1lOiAnYWN0b3ItYWxhcm1zJyxcbiAgICAgICAgICBpbmNsdWRlOiBbJ3Rlc3QvYWN0b3ItYWxhcm1zLyoqLyoudGVzdC50cyddLFxuICAgICAgICAgIHRlc3RUaW1lb3V0OiAzMDAwMCwgIC8vIDMwIHNlY29uZHMgZm9yIEFjdG9yIEFsYXJtcyB3aXRoIDF4IHRpbWVzY2FsZVxuICAgICAgICAgIGdsb2JhbHM6IHRydWUsXG4gICAgICAgICAgcG9vbE9wdGlvbnM6IHtcbiAgICAgICAgICAgIHdvcmtlcnM6IHtcbiAgICAgICAgICAgICAgaXNvbGF0ZWRTdG9yYWdlOiBmYWxzZSxcbiAgICAgICAgICAgICAgd3JhbmdsZXI6IHsgY29uZmlnUGF0aDogJy4vdGVzdC9hY3Rvci1hbGFybXMvd3JhbmdsZXIuanNvbmMnIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICBdLFxuICAgIGNvdmVyYWdlOiB7XG4gICAgICBwcm92aWRlcjogJ2lzdGFuYnVsJyxcbiAgICAgIHJlcG9ydGVyOiBbJ3RleHQnLCAnaHRtbCcsICdsY292J10sXG4gICAgICBpbmNsdWRlOiBbXG4gICAgICAgICcqKi9zcmMvKionLFxuICAgICAgICAnKiovdGVzdC9pbnRlZ3JhdGlvbi90ZXN0LXdvcmtlci1hbmQtZG9zLnRzJ1xuICAgICAgXSxcbiAgICAgIGV4Y2x1ZGU6IFtcbiAgICAgICAgJyoqL25vZGVfbW9kdWxlcy8qKicsXG4gICAgICAgICcqKi9kaXN0LyoqJyxcbiAgICAgICAgJyoqL2J1aWxkLyoqJyxcbiAgICAgICAgJyoqLyouY29uZmlnLionLFxuICAgICAgICAnKiovc2NyYXRjaC8qKicsXG4gICAgICAgICcqKi90ZXN0LyoqLyoudGVzdC50cydcbiAgICAgIF0sXG4gICAgICBza2lwRnVsbDogZmFsc2UsXG4gICAgICBhbGw6IGZhbHNlLFxuICAgIH0sXG4gIH0sXG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBZ1gsU0FBUyxvQkFBb0I7QUFDN1ksU0FBUyw0QkFBNEI7QUFFckMsSUFBTyx3QkFBUSxhQUFhO0FBQUEsRUFDMUIsTUFBTTtBQUFBLElBQ0osVUFBVTtBQUFBO0FBQUEsTUFFUjtBQUFBLFFBQ0UsTUFBTTtBQUFBLFVBQ0osTUFBTTtBQUFBLFVBQ04sYUFBYTtBQUFBLFVBQ2IsU0FBUyxDQUFDLHdCQUF3QjtBQUFBLFVBQ2xDLFlBQVksQ0FBQyxzQkFBc0I7QUFBQSxRQUNyQztBQUFBLE1BQ0Y7QUFBQTtBQUFBLE1BR0EscUJBQXFCO0FBQUEsUUFDbkIsTUFBTTtBQUFBLFVBQ0osTUFBTTtBQUFBLFVBQ04sU0FBUyxDQUFDLCtCQUErQjtBQUFBLFVBQ3pDLGFBQWE7QUFBQSxVQUNiLFNBQVM7QUFBQSxVQUNULGFBQWE7QUFBQSxZQUNYLFNBQVM7QUFBQSxjQUNQLGlCQUFpQjtBQUFBO0FBQUEsY0FDakIsVUFBVSxFQUFFLFlBQVksb0NBQW9DO0FBQUEsWUFDOUQ7QUFBQSxVQUNGO0FBQUEsUUFDRjtBQUFBLE1BQ0YsQ0FBQztBQUFBO0FBQUEsTUFHRCxxQkFBcUI7QUFBQSxRQUNuQixNQUFNO0FBQUEsVUFDSixNQUFNO0FBQUEsVUFDTixTQUFTLENBQUMsb0NBQW9DO0FBQUEsVUFDOUMsYUFBYTtBQUFBO0FBQUEsVUFDYixTQUFTO0FBQUEsVUFDVCxhQUFhO0FBQUEsWUFDWCxTQUFTO0FBQUEsY0FDUCxpQkFBaUI7QUFBQSxjQUNqQixVQUFVLEVBQUUsWUFBWSx5Q0FBeUM7QUFBQSxZQUNuRTtBQUFBLFVBQ0Y7QUFBQSxRQUNGO0FBQUEsTUFDRixDQUFDO0FBQUE7QUFBQSxNQUdELHFCQUFxQjtBQUFBLFFBQ25CLE1BQU07QUFBQSxVQUNKLE1BQU07QUFBQSxVQUNOLFNBQVMsQ0FBQyxxQ0FBcUM7QUFBQSxVQUMvQyxhQUFhO0FBQUEsVUFDYixTQUFTO0FBQUEsVUFDVCxhQUFhO0FBQUEsWUFDWCxTQUFTO0FBQUEsY0FDUCxpQkFBaUI7QUFBQSxjQUNqQixVQUFVLEVBQUUsWUFBWSwwQ0FBMEM7QUFBQSxZQUNwRTtBQUFBLFVBQ0Y7QUFBQSxRQUNGO0FBQUEsTUFDRixDQUFDO0FBQUE7QUFBQSxNQUdELHFCQUFxQjtBQUFBLFFBQ25CLE1BQU07QUFBQSxVQUNKLE1BQU07QUFBQSxVQUNOLFNBQVMsQ0FBQyxnQ0FBZ0M7QUFBQSxVQUMxQyxhQUFhO0FBQUE7QUFBQSxVQUNiLFNBQVM7QUFBQSxVQUNULGFBQWE7QUFBQSxZQUNYLFNBQVM7QUFBQSxjQUNQLGlCQUFpQjtBQUFBLGNBQ2pCLFVBQVUsRUFBRSxZQUFZLHFDQUFxQztBQUFBLFlBQy9EO0FBQUEsVUFDRjtBQUFBLFFBQ0Y7QUFBQSxNQUNGLENBQUM7QUFBQSxJQUNIO0FBQUEsSUFDQSxVQUFVO0FBQUEsTUFDUixVQUFVO0FBQUEsTUFDVixVQUFVLENBQUMsUUFBUSxRQUFRLE1BQU07QUFBQSxNQUNqQyxTQUFTO0FBQUEsUUFDUDtBQUFBLFFBQ0E7QUFBQSxNQUNGO0FBQUEsTUFDQSxTQUFTO0FBQUEsUUFDUDtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsTUFDRjtBQUFBLE1BQ0EsVUFBVTtBQUFBLE1BQ1YsS0FBSztBQUFBLElBQ1A7QUFBQSxFQUNGO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
