import { defineConfig } from "vitest/config";

// End-to-end tests start podman containers and download Node.js and Paseo, so they run only
// through `npm run test:e2e`, one file at a time.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.test.ts"],
    testTimeout: 15 * 60_000,
    hookTimeout: 5 * 60_000,
    fileParallelism: false,
  },
});
