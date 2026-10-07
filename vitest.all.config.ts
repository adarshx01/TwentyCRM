import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  plugins: [swc.vite({ jsc: { target: 'es2022', parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } } })],
  test: {
    globals: true,
    include: ['test/unit/**/*.spec.ts', 'test/integration/**/*.spec.ts', 'test/e2e/**/*.e2e.spec.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 90000,
    hookTimeout: 120000,
    pool: 'forks',
    poolOptions: { forks: { maxForks: 3 } },
  },
});
