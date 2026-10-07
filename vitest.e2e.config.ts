import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/** End-to-end tests: real HTTP app, real workers/queue, real PostgreSQL, fake Twenty/providers. */
export default defineConfig({
  plugins: [swc.vite({ jsc: { target: 'es2022', parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } } })],
  test: {
    globals: true,
    include: ['test/e2e/**/*.e2e.spec.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 90000,
    hookTimeout: 120000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: false, maxForks: 2 } },
  },
});
