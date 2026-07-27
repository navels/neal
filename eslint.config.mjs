import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Minimal baseline lint: the recommended bases with every rule the current
// tree violates disabled, so `pnpm lint` is clean without reformatting any
// runtime or test source (see CONTRIBUTING.md Verification). Tighten rules
// only alongside the code changes that satisfy them.
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'archive/**',
      'examples/**',
      'scripts/**',
      'tmp/**',
      '.neal/**',
    ],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'test/**/*.mjs'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    linterOptions: {
      // The tree carries pre-existing eslint-disable comments from before
      // this config existed; do not fail or warn on the ones that are
      // redundant under this baseline rule set.
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      // Baseline exclusions: each rule below is violated by the existing
      // tree. Disabling (not editing runtime code) keeps this scope
      // behavior-preserving.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-control-regex': 'off',
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      'require-yield': 'off',
    },
  },
);
