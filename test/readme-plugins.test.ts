/**
 * README プラグイン表の登録漏れ検出テスト (phase16.1)。
 *
 * 動機: `test/config-example-plugins.test.ts` は `config.example.toml` と
 * `docs/deploy-examples/summaly-config.example.toml` の 2 ファイルを守っているが、
 * **README.md は対象外** だった。phase15.2 で `kakuyomu` プラグインを追加した際、
 * docs/Plugins.md と config example には反映されたが README.md のプラグイン表には
 * 載らない状態が phase16.1 着手まで続いた。Feedback.md の phase11.4 / 6.1 系で
 * 繰り返し起きている example 同期漏れと同種の構造的見落とし。
 *
 * 本テストは「`src/plugins/*.ts` で `export const name = '...'` されている全プラグイン名」が
 * README.md にバッククォート付きトークン (\`<name>\`) として言及されているかを検証する。
 * プラグイン表は経路列付きで運用されているが、本テストは「言及の有無」のみを保証し、
 * 経路列の値や対象 URL の正確性は人力レビュー / docs/Plugins.md 詳細記述に委ねる。
 */

import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function listBuiltinPluginNames(): string[] {
	const pluginsDir = join(repoRoot, 'src/plugins');
	const entries = readdirSync(pluginsDir).filter(f => f.endsWith('.ts') && f !== 'index.ts');
	const names: string[] = [];
	for (const file of entries) {
		const src = readFileSync(join(pluginsDir, file), 'utf8');
		const m = /export\s+const\s+name\s*=\s*['"]([^'"]+)['"]/.exec(src);
		if (m != null) names.push(m[1]);
	}
	return names.sort();
}

function isMentionedInReadme(pluginName: string, readmeText: string): boolean {
	// `\`<name>\`` というバッククォート付きトークンで言及されているかを判定。
	// README プラグイン表は `| \`<name>\` | ... |` 形式なのでこの判定で確実にマッチする。
	const pattern = new RegExp('`' + pluginName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`');
	return pattern.test(readmeText);
}

describe('README プラグイン表の整合', () => {
	const builtinNames = listBuiltinPluginNames();

	test('組み込みプラグインが 1 件以上検出できる（メタテスト）', () => {
		expect(builtinNames.length).toBeGreaterThan(0);
	});

	test('README.md に全組み込みプラグインが言及されている', () => {
		const text = readFileSync(join(repoRoot, 'README.md'), 'utf8');
		const missing = builtinNames.filter(name => !isMentionedInReadme(name, text));
		expect(
			missing,
			`新規プラグインが README.md の対応サイト表に未反映です。`
			+ `\n  漏れ: ${missing.join(', ')}`
			+ `\n  対応: README.md の「対応サイト（プラグイン一覧）」表に \`${missing[0] ?? '<name>'}\` 行を追加してください`,
		).toEqual([]);
	});
});
