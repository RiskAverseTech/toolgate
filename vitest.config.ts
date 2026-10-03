import { defineConfig } from 'vitest/config';

// The mod's tests (plugin/tests) run against Claude Code's own engine: `npm run test:mod`.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
