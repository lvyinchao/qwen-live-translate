import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.output/', '.wxt/', 'outputs/', 'work/', 'vendor/', 'public/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Empty catches mark deliberate best-effort cleanup throughout the code.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Control characters appear on purpose in filename/path sanitizers.
      'no-control-regex': 'off',
      // Closures may read a timer handle that is assigned once, later.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
    rules: {
      // TypeScript resolves globals, including WXT's auto-imported define* helpers.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    files: ['entrypoints/sidepanel/**/*.tsx', 'entrypoints/sidepanel/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Fixtures model loosely typed browser and provider payloads.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', '*.config.{js,ts}'],
    // Gate scripts also pass functions into Playwright pages and extension contexts.
    languageOptions: { globals: { ...globals.node, ...globals.browser, ...globals.webextensions } },
  },
  prettier,
);
