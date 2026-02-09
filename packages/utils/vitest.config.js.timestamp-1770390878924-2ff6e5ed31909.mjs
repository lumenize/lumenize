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
          include: ["test/unit/**/*.test.ts"]
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZXN0LmNvbmZpZy5qcyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9zZXNzaW9ucy92aWdpbGFudC12aWJyYW50LWN1cmllL21udC9sdW1lbml6ZS9wYWNrYWdlcy91dGlsc1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL3Nlc3Npb25zL3ZpZ2lsYW50LXZpYnJhbnQtY3VyaWUvbW50L2x1bWVuaXplL3BhY2thZ2VzL3V0aWxzL3ZpdGVzdC5jb25maWcuanNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL3Nlc3Npb25zL3ZpZ2lsYW50LXZpYnJhbnQtY3VyaWUvbW50L2x1bWVuaXplL3BhY2thZ2VzL3V0aWxzL3ZpdGVzdC5jb25maWcuanNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tICd2aXRlc3QvY29uZmlnJztcbmltcG9ydCB7IGRlZmluZVdvcmtlcnNQcm9qZWN0IH0gZnJvbSBcIkBjbG91ZGZsYXJlL3ZpdGVzdC1wb29sLXdvcmtlcnMvY29uZmlnXCI7XG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyh7XG4gIHRlc3Q6IHtcbiAgICBwcm9qZWN0czogW1xuICAgICAgLy8gVW5pdCB0ZXN0cyAtIE5vZGUgZW52aXJvbm1lbnRcbiAgICAgIHtcbiAgICAgICAgdGVzdDoge1xuICAgICAgICAgIG5hbWU6ICd1bml0JyxcbiAgICAgICAgICBlbnZpcm9ubWVudDogJ25vZGUnLFxuICAgICAgICAgIGluY2x1ZGU6IFsndGVzdC91bml0LyoqLyoudGVzdC50cyddLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIC8vIEludGVncmF0aW9uIHRlc3RzIC0gV29ya2VycyBlbnZpcm9ubWVudFxuICAgICAgZGVmaW5lV29ya2Vyc1Byb2plY3Qoe1xuICAgICAgICB0ZXN0OiB7XG4gICAgICAgICAgbmFtZTogJ2ludGVncmF0aW9uJyxcbiAgICAgICAgICBpbmNsdWRlOiBbJ3Rlc3QvaW50ZWdyYXRpb24vKiovKi50ZXN0LnRzJ10sXG4gICAgICAgICAgdGVzdFRpbWVvdXQ6IDIwMDAsXG4gICAgICAgICAgZ2xvYmFsczogdHJ1ZSxcbiAgICAgICAgICBwb29sT3B0aW9uczoge1xuICAgICAgICAgICAgd29ya2Vyczoge1xuICAgICAgICAgICAgICBpc29sYXRlZFN0b3JhZ2U6IGZhbHNlLCAgLy8gTXVzdCBiZSBmYWxzZSBmb3Igbm93IHRvIHVzZSB3ZWJzb2NrZXRzLiBIYXZlIGVhY2ggdGVzdCBjcmVhdGUgYSBuZXcgRE8gaW5zdGFuY2UgdG8gYXZvaWQgc3RhdGUgc2hhcmluZy5cbiAgICAgICAgICAgICAgd3JhbmdsZXI6IHsgY29uZmlnUGF0aDogJy4vdGVzdC9pbnRlZ3JhdGlvbi93cmFuZ2xlci5qc29uYycgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgIF0sXG4gICAgY292ZXJhZ2U6IHtcbiAgICAgIHByb3ZpZGVyOiAnaXN0YW5idWwnLFxuICAgICAgcmVwb3J0ZXI6IFsndGV4dCcsICdodG1sJywgJ2xjb3YnXSxcbiAgICAgIGluY2x1ZGU6IFtcbiAgICAgICAgJyoqL3NyYy8qKicsXG4gICAgICBdLFxuICAgICAgZXhjbHVkZTogW1xuICAgICAgICAnKiovbm9kZV9tb2R1bGVzLyoqJywgXG4gICAgICAgICcqKi9kaXN0LyoqJywgXG4gICAgICAgICcqKi9idWlsZC8qKicsIFxuICAgICAgICAnKiovKi5jb25maWcuKicsXG4gICAgICAgICcqKi9zY3JhdGNoLyoqJyxcbiAgICAgICAgJyoqL3Rlc3QvKiovKi50ZXN0LnRzJ1xuICAgICAgXSxcbiAgICAgIHNraXBGdWxsOiBmYWxzZSxcbiAgICAgIGFsbDogZmFsc2UsXG4gICAgfSxcbiAgfSxcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUEwVyxTQUFTLG9CQUFvQjtBQUN2WSxTQUFTLDRCQUE0QjtBQUVyQyxJQUFPLHdCQUFRLGFBQWE7QUFBQSxFQUMxQixNQUFNO0FBQUEsSUFDSixVQUFVO0FBQUE7QUFBQSxNQUVSO0FBQUEsUUFDRSxNQUFNO0FBQUEsVUFDSixNQUFNO0FBQUEsVUFDTixhQUFhO0FBQUEsVUFDYixTQUFTLENBQUMsd0JBQXdCO0FBQUEsUUFDcEM7QUFBQSxNQUNGO0FBQUE7QUFBQSxNQUVBLHFCQUFxQjtBQUFBLFFBQ25CLE1BQU07QUFBQSxVQUNKLE1BQU07QUFBQSxVQUNOLFNBQVMsQ0FBQywrQkFBK0I7QUFBQSxVQUN6QyxhQUFhO0FBQUEsVUFDYixTQUFTO0FBQUEsVUFDVCxhQUFhO0FBQUEsWUFDWCxTQUFTO0FBQUEsY0FDUCxpQkFBaUI7QUFBQTtBQUFBLGNBQ2pCLFVBQVUsRUFBRSxZQUFZLG9DQUFvQztBQUFBLFlBQzlEO0FBQUEsVUFDRjtBQUFBLFFBQ0Y7QUFBQSxNQUNGLENBQUM7QUFBQSxJQUNIO0FBQUEsSUFDQSxVQUFVO0FBQUEsTUFDUixVQUFVO0FBQUEsTUFDVixVQUFVLENBQUMsUUFBUSxRQUFRLE1BQU07QUFBQSxNQUNqQyxTQUFTO0FBQUEsUUFDUDtBQUFBLE1BQ0Y7QUFBQSxNQUNBLFNBQVM7QUFBQSxRQUNQO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxNQUNGO0FBQUEsTUFDQSxVQUFVO0FBQUEsTUFDVixLQUFLO0FBQUEsSUFDUDtBQUFBLEVBQ0Y7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
