import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'drizzle/**',
      'coverage/**',
      '.test-dist/**',
      '.test-dist*/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Seed scripts are CommonJS on purpose: they run inside the API container
    // via `node -` and are not part of the TypeScript build.
    files: ['scripts/seed/**/*.cjs'],
    languageOptions: {
      globals: { Buffer: 'readonly', __dirname: 'readonly' },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
      },
    },
  },
);
