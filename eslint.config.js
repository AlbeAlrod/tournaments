// Minimal ESLint flat config: catch real bugs only, no style rules.
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'functions/node_modules/**', 'ops/**/*.html', '.netlify/**'],
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'warn',
      'no-redeclare': 'error',
    },
  },
  {
    files: ['ops/**/*.mjs', 'tests/**/*.mjs', 'functions/**/*.js', 'functions/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
