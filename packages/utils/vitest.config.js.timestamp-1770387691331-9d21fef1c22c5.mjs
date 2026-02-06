// vitest.config.js
import { defineConfig } from "file:///sessions/vigilant-vibrant-curie/mnt/lumenize/node_modules/vitest/dist/config.js";
import { defineWorkersProject } from "file:///sessions/vigilant-vibrant-curie/mnt/lumenize/node_modules/@cloudflare/vitest-pool-workers/dist/config/index.cjs";
var vitest_config_default = defineConfig({
  test: {
    projects: [
      // Unit tests - Node environment
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["test/unit/**/*.test.ts"],
          setupFiles: ["./test/unit/setup.ts"]
        }
      },
      // Integration tests - Workers environment
      defineWorkersProject({
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          testTimeout: 2e3,
          globals: true,
          poolOptions: {
            workers: {
              isolatedStorage: false,
              // Must be false for now to use websockets. Have each test create a new DO instance to avoid state sharing.
              wrangler: { configPath: "./test/integration/wrangler.jsonc" }
            }
          }
        }
      })
    ],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "html", "lcov"],
      include: [
        "**/src/**"
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZXN0LmNvbmZpZy5qcyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9zZXNzaW9ucy92aWdpbGFudC12aWJyYW50LWN1cmllL21udC9sdW1lbml6ZS9wYWNrYWdlcy91dGlsc1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL3Nlc3Npb25zL3ZpZ2lsYW50LXZpYnJhbnQtY3VyaWUvbW50L2x1bWVuaXplL3BhY2thZ2VzL3V0aWxzL3ZpdGVzdC5jb25maWcuanNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL3Nlc3Npb25zL3ZpZ2lsYW50LXZpYnJhbnQtY3VyaWUvbW50L2x1bWVuaXplL3BhY2thZ2VzL3V0aWxzL3ZpdGVzdC5jb25maWcuanNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tICd2aXRlc3QvY29uZmlnJztcbmltcG9ydCB7IGRlZmluZVdvcmtlcnNQcm9qZWN0IH0gZnJvbSBcIkBjbG91ZGZsYXJlL3ZpdGVzdC1wb29sLXdvcmtlcnMvY29uZmlnXCI7XG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyh7XG4gIHRlc3Q6IHtcbiAgICBwcm9qZWN0czogW1xuICAgICAgLy8gVW5pdCB0ZXN0cyAtIE5vZGUgZW52aXJvbm1lbnRcbiAgICAgIHtcbiAgICAgICAgdGVzdDoge1xuICAgICAgICAgIG5hbWU6ICd1bml0JyxcbiAgICAgICAgICBlbnZpcm9ubWVudDogJ25vZGUnLFxuICAgICAgICAgIGluY2x1ZGU6IFsndGVzdC91bml0LyoqLyoudGVzdC50cyddLFxuICAgICAgICAgIHNldHVwRmlsZXM6IFsnLi90ZXN0L3VuaXQvc2V0dXAudHMnXSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICAvLyBJbnRlZ3JhdGlvbiB0ZXN0cyAtIFdvcmtlcnMgZW52aXJvbm1lbnRcbiAgICAgIGRlZmluZVdvcmtlcnNQcm9qZWN0KHtcbiAgICAgICAgdGVzdDoge1xuICAgICAgICAgIG5hbWU6ICdpbnRlZ3JhdGlvbicsXG4gICAgICAgICAgaW5jbHVkZTogWyd0ZXN0L2ludGVncmF0aW9uLyoqLyoudGVzdC50cyddLFxuICAgICAgICAgIHRlc3RUaW1lb3V0OiAyMDAwLFxuICAgICAgICAgIGdsb2JhbHM6IHRydWUsXG4gICAgICAgICAgcG9vbE9wdGlvbnM6IHtcbiAgICAgICAgICAgIHdvcmtlcnM6IHtcbiAgICAgICAgICAgICAgaXNvbGF0ZWRTdG9yYWdlOiBmYWxzZSwgIC8vIE11c3QgYmUgZmFsc2UgZm9yIG5vdyB0byB1c2Ugd2Vic29ja2V0cy4gSGF2ZSBlYWNoIHRlc3QgY3JlYXRlIGEgbmV3IERPIGluc3RhbmNlIHRvIGF2b2lkIHN0YXRlIHNoYXJpbmcuXG4gICAgICAgICAgICAgIHdyYW5nbGVyOiB7IGNvbmZpZ1BhdGg6ICcuL3Rlc3QvaW50ZWdyYXRpb24vd3JhbmdsZXIuanNvbmMnIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICBdLFxuICAgIGNvdmVyYWdlOiB7XG4gICAgICBwcm92aWRlcjogJ2lzdGFuYnVsJyxcbiAgICAgIHJlcG9ydGVyOiBbJ3RleHQnLCAnaHRtbCcsICdsY292J10sXG4gICAgICBpbmNsdWRlOiBbXG4gICAgICAgICcqKi9zcmMvKionLFxuICAgICAgXSxcbiAgICAgIGV4Y2x1ZGU6IFtcbiAgICAgICAgJyoqL25vZGVfbW9kdWxlcy8qKicsIFxuICAgICAgICAnKiovZGlzdC8qKicsIFxuICAgICAgICAnKiovYnVpbGQvKionLCBcbiAgICAgICAgJyoqLyouY29uZmlnLionLFxuICAgICAgICAnKiovc2NyYXRjaC8qKicsXG4gICAgICAgICcqKi90ZXN0LyoqLyoudGVzdC50cydcbiAgICAgIF0sXG4gICAgICBza2lwRnVsbDogZmFsc2UsXG4gICAgICBhbGw6IGZhbHNlLFxuICAgIH0sXG4gIH0sXG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBMFcsU0FBUyxvQkFBb0I7QUFDdlksU0FBUyw0QkFBNEI7QUFFckMsSUFBTyx3QkFBUSxhQUFhO0FBQUEsRUFDMUIsTUFBTTtBQUFBLElBQ0osVUFBVTtBQUFBO0FBQUEsTUFFUjtBQUFBLFFBQ0UsTUFBTTtBQUFBLFVBQ0osTUFBTTtBQUFBLFVBQ04sYUFBYTtBQUFBLFVBQ2IsU0FBUyxDQUFDLHdCQUF3QjtBQUFBLFVBQ2xDLFlBQVksQ0FBQyxzQkFBc0I7QUFBQSxRQUNyQztBQUFBLE1BQ0Y7QUFBQTtBQUFBLE1BRUEscUJBQXFCO0FBQUEsUUFDbkIsTUFBTTtBQUFBLFVBQ0osTUFBTTtBQUFBLFVBQ04sU0FBUyxDQUFDLCtCQUErQjtBQUFBLFVBQ3pDLGFBQWE7QUFBQSxVQUNiLFNBQVM7QUFBQSxVQUNULGFBQWE7QUFBQSxZQUNYLFNBQVM7QUFBQSxjQUNQLGlCQUFpQjtBQUFBO0FBQUEsY0FDakIsVUFBVSxFQUFFLFlBQVksb0NBQW9DO0FBQUEsWUFDOUQ7QUFBQSxVQUNGO0FBQUEsUUFDRjtBQUFBLE1BQ0YsQ0FBQztBQUFBLElBQ0g7QUFBQSxJQUNBLFVBQVU7QUFBQSxNQUNSLFVBQVU7QUFBQSxNQUNWLFVBQVUsQ0FBQyxRQUFRLFFBQVEsTUFBTTtBQUFBLE1BQ2pDLFNBQVM7QUFBQSxRQUNQO0FBQUEsTUFDRjtBQUFBLE1BQ0EsU0FBUztBQUFBLFFBQ1A7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0Y7QUFBQSxNQUNBLFVBQVU7QUFBQSxNQUNWLEtBQUs7QUFBQSxJQUNQO0FBQUEsRUFDRjtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
