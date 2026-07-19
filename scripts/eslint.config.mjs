// ESLint 9 flat config — Airbnb-inspired style guide for Node.js
import js from '@eslint/js';

export default [
  // Base recommended rules
  js.configs.recommended,

  // Global ignores
  {
    ignores: [
      'node_modules/**',
      'cards/**',
      '*.json',
      '*.lock',
    ],
  },

  // Project-wide rules (Airbnb-inspired)
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        JSON: 'readonly',
        Math: 'readonly',
        Date: 'readonly',
        Promise: 'readonly',
        Error: 'readonly',
      },
    },
    rules: {
      // Airbnb core rules
      indent: ['error', 2, { SwitchCase: 1 }],
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      'eqeqeq': ['error', 'always'],
      'no-eval': 'error',
      'no-multi-spaces': 'error',
      'no-trailing-spaces': 'error',
      'comma-dangle': ['error', 'always-multiline'],
      'arrow-spacing': 'error',
      'keyword-spacing': ['error', { before: true, after: true }],
      'space-before-blocks': 'error',
      'space-infix-ops': 'error',
      'object-curly-spacing': ['error', 'always'],
      'array-bracket-spacing': ['error', 'never'],
      'no-multiple-empty-lines': ['error', { max: 1, maxEOF: 0 }],
      'eol-last': ['error', 'always'],
      'camelcase': ['error', { properties: 'never' }],
      'max-len': ['warn', { code: 120, ignoreComments: true, ignoreStrings: true, ignoreTemplateLiterals: true }],
      'prefer-arrow-callback': 'warn',
      'no-else-return': 'warn',
      'no-lonely-if': 'warn',
      'prefer-template': 'warn',
      'no-useless-return': 'warn',

      // Node-specific
      'no-path-concat': 'error',
      'no-buffer-constructor': 'error',
      'no-new-require': 'error',
    },
  },
];
