import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
  },
  projects: [
    { name: "a11y",  testMatch: "a11y/**/*.spec.ts" },
    { name: "e2e",   testMatch: "e2e/**/*.spec.ts" },
  ],
});
