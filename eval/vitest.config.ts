import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["eval/**/*.eval.ts"],
    environment: "node",
    testTimeout: 0,
    hookTimeout: 60_000,
  },
});
