import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/** Unit tests: pure logic, no database required. */
export default defineConfig({
  plugins: [swc.vite({ jsc: { target: 'es2022', parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } } })],
  test: {
    globals: true,
    include: ['test/unit/**/*.spec.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 15000,
    coverage: { provider: 'v8', reporter: ['text', 'html'], include: ['src/**/*.ts'], exclude: ['src/main.ts', 'src/**/*.module.ts'] },
  },
});
