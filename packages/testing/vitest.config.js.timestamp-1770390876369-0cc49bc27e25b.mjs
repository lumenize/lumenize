// vitest.config.js
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZXN0LmNvbmZpZy5qcyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9zZXNzaW9ucy92aWdpbGFudC12aWJyYW50LWN1cmllL21udC9sdW1lbml6ZS9wYWNrYWdlcy90ZXN0aW5nXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvc2Vzc2lvbnMvdmlnaWxhbnQtdmlicmFudC1jdXJpZS9tbnQvbHVtZW5pemUvcGFja2FnZXMvdGVzdGluZy92aXRlc3QuY29uZmlnLmpzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9zZXNzaW9ucy92aWdpbGFudC12aWJyYW50LWN1cmllL21udC9sdW1lbml6ZS9wYWNrYWdlcy90ZXN0aW5nL3ZpdGVzdC5jb25maWcuanNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tICd2aXRlc3QvY29uZmlnJztcbmltcG9ydCB7IGRlZmluZVdvcmtlcnNQcm9qZWN0IH0gZnJvbSBcIkBjbG91ZGZsYXJlL3ZpdGVzdC1wb29sLXdvcmtlcnMvY29uZmlnXCI7XG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyh7XG4gIHRlc3Q6IHtcbiAgICBwcm9qZWN0czogW1xuICAgICAgLy8gVW5pdCB0ZXN0cyAtIE5vZGUgZW52aXJvbm1lbnQgKEJyb3dzZXIsIGNvb2tpZS11dGlscylcbiAgICAgIHtcbiAgICAgICAgdGVzdDoge1xuICAgICAgICAgIG5hbWU6ICd1bml0JyxcbiAgICAgICAgICBlbnZpcm9ubWVudDogJ25vZGUnLFxuICAgICAgICAgIGluY2x1ZGU6IFsndGVzdC91bml0LyoqLyoudGVzdC50cyddLFxuICAgICAgICAgIHNldHVwRmlsZXM6IFsnLi90ZXN0L3VuaXQvc2V0dXAudHMnXSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG5cbiAgICAgIC8vIEludGVncmF0aW9uIHRlc3RzIC0gQ29yZSB0ZXN0aW5nIGxpYnJhcnkgZnVuY3Rpb25hbGl0eVxuICAgICAgZGVmaW5lV29ya2Vyc1Byb2plY3Qoe1xuICAgICAgICB0ZXN0OiB7XG4gICAgICAgICAgbmFtZTogJ2ludGVncmF0aW9uJyxcbiAgICAgICAgICBpbmNsdWRlOiBbJ3Rlc3QvaW50ZWdyYXRpb24vKiovKi50ZXN0LnRzJ10sXG4gICAgICAgICAgdGVzdFRpbWVvdXQ6IDIwMDAsXG4gICAgICAgICAgZ2xvYmFsczogdHJ1ZSxcbiAgICAgICAgICBwb29sT3B0aW9uczoge1xuICAgICAgICAgICAgd29ya2Vyczoge1xuICAgICAgICAgICAgICBpc29sYXRlZFN0b3JhZ2U6IGZhbHNlLCAgLy8gTXVzdCBiZSBmYWxzZSBmb3IgV2ViU29ja2V0IHN1cHBvcnRcbiAgICAgICAgICAgICAgd3JhbmdsZXI6IHsgY29uZmlnUGF0aDogJy4vdGVzdC9pbnRlZ3JhdGlvbi93cmFuZ2xlci5qc29uYycgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICAgXG4gICAgICAvLyBBbGFybSBzaW11bGF0aW9uIHBlZGFnb2dpY2FsIHRlc3RzXG4gICAgICBkZWZpbmVXb3JrZXJzUHJvamVjdCh7XG4gICAgICAgIHRlc3Q6IHtcbiAgICAgICAgICBuYW1lOiAnYWxhcm0tc2ltdWxhdGlvbicsXG4gICAgICAgICAgaW5jbHVkZTogWyd0ZXN0L2FsYXJtLXNpbXVsYXRpb24vKiovKi50ZXN0LnRzJ10sXG4gICAgICAgICAgdGVzdFRpbWVvdXQ6IDI1MDAwLCAgLy8gMjUgc2Vjb25kcyBmb3IgYWN0b3ItYWxhcm1zIHRlc3QgKG5lZWRzIDIwcylcbiAgICAgICAgICBnbG9iYWxzOiB0cnVlLFxuICAgICAgICAgIHBvb2xPcHRpb25zOiB7XG4gICAgICAgICAgICB3b3JrZXJzOiB7XG4gICAgICAgICAgICAgIGlzb2xhdGVkU3RvcmFnZTogZmFsc2UsXG4gICAgICAgICAgICAgIHdyYW5nbGVyOiB7IGNvbmZpZ1BhdGg6ICcuL3Rlc3QvYWxhcm0tc2ltdWxhdGlvbi93cmFuZ2xlci5qc29uYycgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICAgXG4gICAgICAvLyBBbGFybSB3b3JrYXJvdW5kcyBwZWRhZ29naWNhbCB0ZXN0c1xuICAgICAgZGVmaW5lV29ya2Vyc1Byb2plY3Qoe1xuICAgICAgICB0ZXN0OiB7XG4gICAgICAgICAgbmFtZTogJ2FsYXJtLXdvcmthcm91bmRzJyxcbiAgICAgICAgICBpbmNsdWRlOiBbJ3Rlc3QvYWxhcm0td29ya2Fyb3VuZHMvKiovKi50ZXN0LnRzJ10sXG4gICAgICAgICAgdGVzdFRpbWVvdXQ6IDIwMDAsXG4gICAgICAgICAgZ2xvYmFsczogdHJ1ZSxcbiAgICAgICAgICBwb29sT3B0aW9uczoge1xuICAgICAgICAgICAgd29ya2Vyczoge1xuICAgICAgICAgICAgICBpc29sYXRlZFN0b3JhZ2U6IGZhbHNlLFxuICAgICAgICAgICAgICB3cmFuZ2xlcjogeyBjb25maWdQYXRoOiAnLi90ZXN0L2FsYXJtLXdvcmthcm91bmRzL3dyYW5nbGVyLmpzb25jJyB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgICBcbiAgICAgIC8vIEFjdG9yIGFsYXJtcyBpbnRlZ3JhdGlvbiB0ZXN0c1xuICAgICAgZGVmaW5lV29ya2Vyc1Byb2plY3Qoe1xuICAgICAgICB0ZXN0OiB7XG4gICAgICAgICAgbmFtZTogJ2FjdG9yLWFsYXJtcycsXG4gICAgICAgICAgaW5jbHVkZTogWyd0ZXN0L2FjdG9yLWFsYXJtcy8qKi8qLnRlc3QudHMnXSxcbiAgICAgICAgICB0ZXN0VGltZW91dDogMzAwMDAsICAvLyAzMCBzZWNvbmRzIGZvciBBY3RvciBBbGFybXMgd2l0aCAxeCB0aW1lc2NhbGVcbiAgICAgICAgICBnbG9iYWxzOiB0cnVlLFxuICAgICAgICAgIHBvb2xPcHRpb25zOiB7XG4gICAgICAgICAgICB3b3JrZXJzOiB7XG4gICAgICAgICAgICAgIGlzb2xhdGVkU3RvcmFnZTogZmFsc2UsXG4gICAgICAgICAgICAgIHdyYW5nbGVyOiB7IGNvbmZpZ1BhdGg6ICcuL3Rlc3QvYWN0b3ItYWxhcm1zL3dyYW5nbGVyLmpzb25jJyB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgXSxcbiAgICBjb3ZlcmFnZToge1xuICAgICAgcHJvdmlkZXI6ICdpc3RhbmJ1bCcsXG4gICAgICByZXBvcnRlcjogWyd0ZXh0JywgJ2h0bWwnLCAnbGNvdiddLFxuICAgICAgaW5jbHVkZTogW1xuICAgICAgICAnKiovc3JjLyoqJyxcbiAgICAgICAgJyoqL3Rlc3QvaW50ZWdyYXRpb24vdGVzdC13b3JrZXItYW5kLWRvcy50cydcbiAgICAgIF0sXG4gICAgICBleGNsdWRlOiBbXG4gICAgICAgICcqKi9ub2RlX21vZHVsZXMvKionLFxuICAgICAgICAnKiovZGlzdC8qKicsXG4gICAgICAgICcqKi9idWlsZC8qKicsXG4gICAgICAgICcqKi8qLmNvbmZpZy4qJyxcbiAgICAgICAgJyoqL3NjcmF0Y2gvKionLFxuICAgICAgICAnKiovdGVzdC8qKi8qLnRlc3QudHMnXG4gICAgICBdLFxuICAgICAgc2tpcEZ1bGw6IGZhbHNlLFxuICAgICAgYWxsOiBmYWxzZSxcbiAgICB9LFxuICB9LFxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQWdYLFNBQVMsb0JBQW9CO0FBQzdZLFNBQVMsNEJBQTRCO0FBRXJDLElBQU8sd0JBQVEsYUFBYTtBQUFBLEVBQzFCLE1BQU07QUFBQSxJQUNKLFVBQVU7QUFBQTtBQUFBLE1BRVI7QUFBQSxRQUNFLE1BQU07QUFBQSxVQUNKLE1BQU07QUFBQSxVQUNOLGFBQWE7QUFBQSxVQUNiLFNBQVMsQ0FBQyx3QkFBd0I7QUFBQSxVQUNsQyxZQUFZLENBQUMsc0JBQXNCO0FBQUEsUUFDckM7QUFBQSxNQUNGO0FBQUE7QUFBQSxNQUdBLHFCQUFxQjtBQUFBLFFBQ25CLE1BQU07QUFBQSxVQUNKLE1BQU07QUFBQSxVQUNOLFNBQVMsQ0FBQywrQkFBK0I7QUFBQSxVQUN6QyxhQUFhO0FBQUEsVUFDYixTQUFTO0FBQUEsVUFDVCxhQUFhO0FBQUEsWUFDWCxTQUFTO0FBQUEsY0FDUCxpQkFBaUI7QUFBQTtBQUFBLGNBQ2pCLFVBQVUsRUFBRSxZQUFZLG9DQUFvQztBQUFBLFlBQzlEO0FBQUEsVUFDRjtBQUFBLFFBQ0Y7QUFBQSxNQUNGLENBQUM7QUFBQTtBQUFBLE1BR0QscUJBQXFCO0FBQUEsUUFDbkIsTUFBTTtBQUFBLFVBQ0osTUFBTTtBQUFBLFVBQ04sU0FBUyxDQUFDLG9DQUFvQztBQUFBLFVBQzlDLGFBQWE7QUFBQTtBQUFBLFVBQ2IsU0FBUztBQUFBLFVBQ1QsYUFBYTtBQUFBLFlBQ1gsU0FBUztBQUFBLGNBQ1AsaUJBQWlCO0FBQUEsY0FDakIsVUFBVSxFQUFFLFlBQVkseUNBQXlDO0FBQUEsWUFDbkU7QUFBQSxVQUNGO0FBQUEsUUFDRjtBQUFBLE1BQ0YsQ0FBQztBQUFBO0FBQUEsTUFHRCxxQkFBcUI7QUFBQSxRQUNuQixNQUFNO0FBQUEsVUFDSixNQUFNO0FBQUEsVUFDTixTQUFTLENBQUMscUNBQXFDO0FBQUEsVUFDL0MsYUFBYTtBQUFBLFVBQ2IsU0FBUztBQUFBLFVBQ1QsYUFBYTtBQUFBLFlBQ1gsU0FBUztBQUFBLGNBQ1AsaUJBQWlCO0FBQUEsY0FDakIsVUFBVSxFQUFFLFlBQVksMENBQTBDO0FBQUEsWUFDcEU7QUFBQSxVQUNGO0FBQUEsUUFDRjtBQUFBLE1BQ0YsQ0FBQztBQUFBO0FBQUEsTUFHRCxxQkFBcUI7QUFBQSxRQUNuQixNQUFNO0FBQUEsVUFDSixNQUFNO0FBQUEsVUFDTixTQUFTLENBQUMsZ0NBQWdDO0FBQUEsVUFDMUMsYUFBYTtBQUFBO0FBQUEsVUFDYixTQUFTO0FBQUEsVUFDVCxhQUFhO0FBQUEsWUFDWCxTQUFTO0FBQUEsY0FDUCxpQkFBaUI7QUFBQSxjQUNqQixVQUFVLEVBQUUsWUFBWSxxQ0FBcUM7QUFBQSxZQUMvRDtBQUFBLFVBQ0Y7QUFBQSxRQUNGO0FBQUEsTUFDRixDQUFDO0FBQUEsSUFDSDtBQUFBLElBQ0EsVUFBVTtBQUFBLE1BQ1IsVUFBVTtBQUFBLE1BQ1YsVUFBVSxDQUFDLFFBQVEsUUFBUSxNQUFNO0FBQUEsTUFDakMsU0FBUztBQUFBLFFBQ1A7QUFBQSxRQUNBO0FBQUEsTUFDRjtBQUFBLE1BQ0EsU0FBUztBQUFBLFFBQ1A7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0Y7QUFBQSxNQUNBLFVBQVU7QUFBQSxNQUNWLEtBQUs7QUFBQSxJQUNQO0FBQUEsRUFDRjtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
