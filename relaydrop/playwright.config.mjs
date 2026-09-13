import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "**/ui.spec.mjs",
  use: { channel: process.env.PLAYWRIGHT_CHANNEL || undefined },
});
