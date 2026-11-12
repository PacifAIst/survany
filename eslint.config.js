// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const rawFetchBan = {
  'no-restricted-globals': [
    'error',
    {
      name: 'fetch',
      message:
        'SG-14: raw fetch is banned here. Use guardedFetch (extension) or the injected fetchFn (providers).',
    },
  ],
  'no-restricted-properties': [
    'error',
    { object: 'globalThis', property: 'fetch', message: 'SG-14: use guardedFetch.' },
    { object: 'self', property: 'fetch', message: 'SG-14: use guardedFetch.' },
    { object: 'window', property: 'fetch', message: 'SG-14: use guardedFetch.' },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-e2e/**',
      '**/dist-firefox/**',
      '**/dist-firefox-e2e/**',
      '**/coverage/**',
      'apps/extension/public/**',
      'apps/viewer/public/**',
      'release/**',
      'models/**/*.py',
      'bench/reports/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    // SECURITY-GATE SG-14: lint rule bans raw fetch outside guardedFetch in the extension and providers
    files: ['apps/extension/src/**/*.ts', 'apps/extension/src/**/*.tsx', 'packages/providers/src/**/*.ts'],
    ignores: ['apps/extension/src/sw/guarded-fetch.ts'],
    rules: rawFetchBan,
  },
  {
    files: ['scripts/**/*.ts', 'bench/**/*.ts', 'demo/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.ts', '**/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
);
