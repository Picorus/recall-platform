import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/build/',
      '**/.turbo/',
      '**/.next/',
      '**/coverage/',
      // Copied from MapLibre at build (apps/admin/scripts/copy-map-worker.mjs).
      'apps/admin/public/maplibre-gl-worker.mjs',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strict,
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
