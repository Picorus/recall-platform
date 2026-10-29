import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/',
      // Helpers' separate working copies (Claude Code worktrees), never part of the repo.
      '.claude/',
      '**/dist/',
      '**/dist-e2e/',
      '**/dist-demo/',
      '**/.expo/',
      '**/build/',
      '**/.turbo/',
      '**/.next/',
      '**/coverage/',
      // Copied from MapLibre at build (apps/admin and apps/brand: scripts/copy-map-worker.mjs).
      'apps/admin/public/maplibre-gl-worker.mjs',
      'apps/brand/public/maplibre-gl-worker.mjs',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strict,
  {
    // Expo's bundler reads this CommonJS file itself (P4.1).
    files: ['apps/rider/metro.config.js'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    languageOptions: { globals: globals.node },
    rules: {
      // Hard rule 2: no floats for money. Catch the usual slips early.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message:
            'parseFloat is not allowed. Money is whole paise; parse with the domain money helpers.',
        },
      ],
    },
  },
);
