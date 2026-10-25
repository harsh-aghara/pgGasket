import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
	{
		ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.tgz']
	},
	{
		languageOptions: {
			globals: {
				...globals.node
			},
			ecmaVersion: 2022,
			sourceType: 'module'
		}
	},
	pluginJs.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['**/*.ts', '**/*.tsx'],
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_'
				}
			],
			'@typescript-eslint/no-explicit-any': 'warn'
		}
	},
	{
		files: ['test/**/*.cjs', 'scripts/**/*.cjs', 'examples/**/*.cjs'],
		languageOptions: {
			sourceType: 'commonjs'
		},
		rules: {
			'@typescript-eslint/no-require-imports': 'off'
		}
	}
];
