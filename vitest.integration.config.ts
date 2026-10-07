import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/** Integration tests run against a real, ephemeral PostgreSQL (see test/global-setup.ts). */
export default defineConfig({
  plugins: [swc.vite({ jsc: { target: 'es2022', parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } } })],
  test: {
    globals: true,
    include: ['test/integration/**/*.spec.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 60000,
    hookTimeout: 90000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: false, maxForks: 3 } },
  },
});
