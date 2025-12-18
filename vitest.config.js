import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        statements: 45,
        branches: 40,
        functions: 50,
        lines: 45,
      },
    },
  },
});
