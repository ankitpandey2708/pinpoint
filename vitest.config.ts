import { defineConfig } from 'vitest/config';

// Default environment is Node. Browser-DOM tests (overlay picker, review flow)
// opt into jsdom per-file with a `// @vitest-environment jsdom` docblock.
// This is the smallest robust equivalent to separate Node/jsdom projects and
// avoids version-specific `projects`/`environmentMatchGlobs` differences.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
