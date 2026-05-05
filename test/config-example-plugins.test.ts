/**
 * 組み込みプラグインの登録漏れを example で検出する整合テスト。
 *
 * 動機: `[plugins.allowed]` がオプトイン許可リスト方式（fail-close）のため、
 * `src/plugins/index.ts` に新規プラグインを追加しても、運用者が config.toml の
 * 許可リストに追記しないと自動で有効にならない。phase11.4 (npmjs) と
 * phase6.1 (twitter) の追加時に両 example の `[plugins.allowed]` 反映が漏れ、
 * 本番で「`/package/<pkg>` が `general()` 経由で Cloudflare 直叩き → 403」が露呈した。
 *
 * このテストは「`src/plugins/*.ts` で `export const name = '...'` されている全プラグイン名」が
 * 両 example （ルート `config.example.toml` と `docs/deploy-examples/summaly-config.example.toml`）に
 * **テキストとしてでも言及されている** ことを保証する。コメントアウト行 (`# "dlsite",`) も
 * 「運用者が判断して活性化できる」のでパス扱い。完全に漏れている (NSFW 系のような明示的除外でもない)
 * ものだけを検出する。
 */

import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const EXAMPLE_FILES = [
	'config.example.toml',
	'docs/deploy-examples/summaly-config.example.toml',
];

function listBuiltinPluginNames(): string[] {
	const pluginsDir = join(repoRoot, 'src/plugins');
	const entries = readdirSync(pluginsDir).filter(f => f.endsWith('.ts') && f !== 'index.ts');
	const names: string[] = [];
	for (const file of entries) {
		const src = readFileSync(join(pluginsDir, file), 'utf8');
		// `export const name = 'foo';` を抽出（'…' / "…" 両対応）
		const m = /export\s+const\s+name\s*=\s*['"]([^'"]+)['"]/.exec(src);
		if (m != null) names.push(m[1]);
	}
	return names.sort();
}

function isMentionedInExample(pluginName: string, exampleText: string): boolean {
	// `"<name>"` という quoted 文字列が出現すれば「言及されている」と判定。
	// コメント行 (`# "dlsite"`) もマッチする（運用者が判断で活性化できるため）。
	const pattern = new RegExp(`["']${pluginName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`);
	return pattern.test(exampleText);
}

describe('config example の [plugins.allowed] 整合', () => {
	const builtinNames = listBuiltinPluginNames();

	test('組み込みプラグインが 1 件以上検出できる（メタテスト）', () => {
		expect(builtinNames.length).toBeGreaterThan(0);
	});

	for (const exampleFile of EXAMPLE_FILES) {
		test(`${exampleFile} に全組み込みプラグインが言及されている`, () => {
			const text = readFileSync(join(repoRoot, exampleFile), 'utf8');
			const missing = builtinNames.filter(name => !isMentionedInExample(name, text));
			expect(
				missing,
				`新規プラグインが ${exampleFile} の [plugins.allowed] に未反映です。`
				+ `\n  漏れ: ${missing.join(', ')}`
				+ `\n  対応: 該当ファイルの allowed 配列に "${missing[0] ?? '<name>'}" を追記してください`
				+ `（NSFW 系のようにデフォルト除外したい場合はコメントアウト行 \`# "${missing[0] ?? '<name>'}",\` でも OK）`,
			).toEqual([]);
		});
	}
});
