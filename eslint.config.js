// -----------------------------------------------------------------------------
//  ESLint flat config (ESLint 9+).
//
//  Goal: catch real mistakes (undefined variables, unused code, unreachable
//  branches) and nothing else. Formatting is the author's business: this project
//  deliberately has no Prettier step.
// -----------------------------------------------------------------------------

import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/', 'data/'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Unused variables are a mistake; allow a leading underscore to mark an
      // argument as intentionally ignored.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
