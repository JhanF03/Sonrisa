// Análisis estático: buenas prácticas de TypeScript + reglas de seguridad.
import js from '@eslint/js';
import security from 'eslint-plugin-security';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'public/assets/**', '.wrangler/**', 'data/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  security.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { parserOptions: { ecmaVersion: 2023, sourceType: 'module' } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      eqeqeq: ['error', 'always'],
      // Los índices vienen de arreglos propios, no de entrada del usuario.
      'security/detect-object-injection': 'off',
    },
  },
  {
    // Rutas de archivos que vienen de la configuración del servidor (nunca del usuario).
    files: ['src/node/**/*.ts', 'src/db/nodeSqliteDatabase.ts'],
    rules: { 'security/detect-non-literal-fs-filename': 'off' },
  },
  {
    // Las pruebas usan respuestas JSON dinámicas.
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', 'security/detect-non-literal-regexp': 'off' },
  },
  {
    files: ['scripts/**/*.mjs', 'public/*.js'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', window: 'readonly', document: 'readonly', localStorage: 'readonly', URL: 'readonly', fetch: 'readonly' } },
  },
);
