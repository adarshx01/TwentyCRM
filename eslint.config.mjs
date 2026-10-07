import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'migrations/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-require-imports': 'error',
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
  { files: ['test/**', 'scripts/**', 'src/main.ts', 'src/database/migrate.ts'], rules: { 'no-console': 'off', '@typescript-eslint/no-unused-expressions': 'off' } },
);
