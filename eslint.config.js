import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', '.tgcloud/', 'tgcloud/lib/config.js'] },
  js.configs.recommended,
  {
    files: ['tgcloud/**/*.js'],
    languageOptions: {
      // The tgcloud runtime is a V8 isolate: no Node globals, only what the SDK provides.
      globals: { console: 'readonly', setTimeout: 'readonly' },
    },
  },
  {
    files: ['scripts/**/*.mjs', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];
