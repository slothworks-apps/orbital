import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier/flat'
import globals from 'globals'

/**
 * One flat config for the whole monorepo. The workspaces differ only in
 * their globals and their React rules, so they are blocks here rather than
 * three configs that would drift apart.
 *
 * Type-aware rules are on (`recommendedTypeChecked`), which is what makes
 * floating promises and bad awaits visible. The `no-unsafe-*` family and
 * `no-explicit-any` are off: this codebase reads the CLI's undocumented
 * transcript JSON, where `any` at the boundary is the honest type.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/',
      '**/node_modules/',
      '**/coverage/',
      'server/drizzle/',
      'desktop/release/',
      'design/',
      // Worktrees hold a second copy of the repo; linting it doubles everything.
      '.worktrees/',
      '.claude/',
      '.superpowers/',
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Config files that no tsconfig includes.
          allowDefaultProject: [
            'web/vitest.config.ts',
            'server/vitest.config.ts',
            'server/drizzle.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Interpolating a number or boolean into a template is fine.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],
      // A leading underscore is how this codebase marks a deliberate discard.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // An `async function*` that never yields is how the model-catalog probe
      // parks the CLI on stdin without billing a turn.
      'require-yield': 'off',
    },
  },

  {
    files: ['server/**/*.ts', 'desktop/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: { globals: globals.node },
  },

  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    extends: [reactHooks.configs.flat['recommended-latest'], reactRefresh.configs.vite],
    rules: {
      // The React Compiler rules this plugin now ships assume a pure-render
      // codebase. The map is not one: it initialises refs lazily during render,
      // holds the outgoing target while a panel animates out, and mutates
      // three.js objects from a frame loop on purpose. `rules-of-hooks`,
      // `exhaustive-deps` and `set-state-in-render` stay on — those catch bugs.
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/set-state-in-effect': 'off',
      // A store action read through a selector (`useOrbital((s) => s.load)`)
      // is not a method that needs its `this` — no store method uses one.
      '@typescript-eslint/unbound-method': 'off',
      // Losing fast refresh in one file is a papercut, not a defect.
      'react-refresh/only-export-components': 'warn',
    },
  },
  {
    // The entry point renders the tree; it is not a fast-refresh boundary.
    files: ['web/src/main.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    files: ['web/vite.config.ts', 'web/vitest.config.ts', 'server/*.config.ts'],
    languageOptions: { globals: globals.node },
  },

  {
    files: ['**/test/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    rules: {
      // Tests reach into internals and stub things out on purpose.
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
    },
  },

  // This file, and anything else plain JS: no type information to lint with.
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  prettier,
)
