import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '*.vsix', 'test/fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/core/**/*.ts'],
    rules: {
      // The core layer must stay free of editor APIs so it can be unit-tested
      // and reused by a CLI.
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'vscode', message: 'src/core must not import vscode.' }] },
      ],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
);
