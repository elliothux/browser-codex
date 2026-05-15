import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/wasm",
  timeout: 120000,
  workers: 1,
});
