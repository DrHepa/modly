import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const commonTypeScriptRules = {
  '@typescript-eslint/no-explicit-any': 'off',
  '@typescript-eslint/no-require-imports': 'off',
  '@typescript-eslint/no-unused-vars': [
    'warn',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_'
    }
  ],
  'no-empty': 'off'
}

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/node_modules/**',
      'docs/worlds-engine-evidence/**',
      '**/*.d.ts',
      '**/*.js',
      '**/*.tsbuildinfo'
    ]
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser
    },
    rules: commonTypeScriptRules
  },
  {
    files: [
      'electron/**/*.ts',
      'electron.vite.config.ts',
      'scripts/verify-world-ffmpeg-package.ts',
      'scripts/world-ffmpeg-native-e2e.ts'
    ],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node
    },
    rules: commonTypeScriptRules
  }
)
