import pluginMisskey from '@misskey-dev/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

//@ts-check
/** @type {import('eslint').Linter.Config[]}  */
export default [ // eslint-disable-line import/no-default-export
	...pluginMisskey.configs['recommended'],
	{
		ignores: [
			'**/node_modules',
			'src/@types/package.json.d.ts',
			'built',
			'vitest.config.ts',
			'tsdown.config.ts',
			'test',
			'worktrees',
			'dev',
			'bin',
			// Cloudflare Workers proxy (phase12.1) — 独立 tsconfig + workers-types を使うため
			// メイン eslint の対象外（Worker 側の lint は将来 wrangler 提供の biome に任せる想定）
			'tools',
		],
	},
	{
		files: ['**/*.ts', '**/*.tsx'],
		languageOptions: {
			parserOptions: {
				parser: tsParser,
				project: ['./tsconfig.json', './test/tsconfig.json'],
				sourceType: 'module',
				tsConfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// 空文字でもフォールバックしたいので無効
			'@typescript-eslint/prefer-nullish-coalescing': 'off',
		},
	},
	{
		files: ['**/*.js', '**/*.cjs'],
		rules: {
			'@typescript-eslint/no-var-requires': 'off',
		},
	},
	{
		// 運用者ローカル one-shot 検証スクリプト (scripts/*.mjs)。secret は env 経由で受け取る。
		// Node 環境の globals (console / process / fetch 等) を有効化。
		files: ['scripts/**/*.mjs'],
		languageOptions: {
			globals: {
				console: 'readonly',
				process: 'readonly',
				fetch: 'readonly',
				URL: 'readonly',
				URLSearchParams: 'readonly',
				AbortController: 'readonly',
				setTimeout: 'readonly',
				clearTimeout: 'readonly',
			},
		},
	},
];
