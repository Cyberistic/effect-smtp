import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
    hookTimeout: 240_000,
  },
  resolve: {
    extensions: [".ts", ".js", ".mts", ".mjs"],
  },
});
