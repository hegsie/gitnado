import globals from 'globals';
import tseslint from 'typescript-eslint';
import overlayStackMembership from './eslint-rules/overlay-stack-membership.mjs';

export default tseslint.config(
  {
    ignores: ['node_modules/', 'dist/', 'src-tauri/'],
  },
  {
    files: ['src/**/*.ts'],
    extends: [
      ...tseslint.configs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2022,
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      'no-console': 'off',
    },
  },
  {
    // Enforced rather than remembered: the overlay stack's membership was a
    // hand-written list once, and it went stale in the same round it was
    // written. See eslint-rules/overlay-stack-membership.mjs.
    // Every component, not just dialogs: lv-toolbar owns a document capture
    // Escape handler that stopPropagation()s, and sat outside the old glob.
    files: ['src/components/**/*.ts'],
    plugins: { gitnado: { rules: { 'overlay-stack-membership': overlayStackMembership } } },
    rules: {
      'gitnado/overlay-stack-membership': 'error',
    },
  },
  {
    // e2e specs, fixtures and page objects. Same base rules; these are test
    // code, so the assertion-style and any-typing rules are relaxed the same
    // way they are for unit tests.
    files: ['e2e/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.es2022, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['src/**/__tests__/**/*.ts', 'src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
);
