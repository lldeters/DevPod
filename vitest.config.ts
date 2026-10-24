import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // `vscode` only exists inside the IDE; tests use a small stand-in.
      vscode: path.resolve(__dirname, 'test/helpers/vscodeMock.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
