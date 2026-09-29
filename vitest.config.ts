import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests create Git repositories and child processes. Running test
    // files concurrently makes their timing unreliable, especially on Windows.
    fileParallelism: false,
  },
});
