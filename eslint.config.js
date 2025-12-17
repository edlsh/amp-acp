import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', 'logs/**', 'docs/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setImmediate: 'readonly',
        AbortController: 'readonly',
        Map: 'readonly',
        Set: 'readonly',
        Promise: 'readonly',
        Date: 'readonly',
        JSON: 'readonly',
        Math: 'readonly',
        Error: 'readonly',
        Number: 'readonly',
        Array: 'readonly',
        Object: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      // Naming conventions
      camelcase: ['error', { properties: 'never', ignoreDestructuring: true }],
      // Complexity analysis
      complexity: ['warn', { max: 15 }],
      'max-depth': ['warn', 4],
      'max-nested-callbacks': ['warn', 3],
    },
  },
  prettier,
];
