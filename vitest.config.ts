import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package to its TypeScript source so tests run
      // without a build step.
      '@task-system/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/web/src/**/*.test.tsx'],
    environment: 'node',
  },
});
