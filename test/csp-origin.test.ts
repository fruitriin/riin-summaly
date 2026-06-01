/**
 * CSP origin 検証 (`src/utils/csp-origin.ts`) の単体テスト (PR #2 review #5)。
 *
 * embed エンドポイントが `EmbedRenderResult.cspDirectives` を CSP に反映する際の
 * **ヘッダインジェクション防御**を直接担保する (origin-only / `;` 混入 / path 混入を弾く)。
 */

import { describe, expect, test } from 'vitest';
import { filterCspOrigins, buildCspDirectiveParts } from '@/utils/csp-origin.js';

describe('filterCspOrigins', () => {
	test('origin-only の https: は通す', () => {
		expect(filterCspOrigins(['https://drive.google.com'])).toEqual(['https://drive.google.com']);
		expect(filterCspOrigins(['https://a.example', 'https://b.example:8443'])).toEqual(['https://a.example', 'https://b.example:8443']);
	});

	test('CSP ヘッダインジェクション (`;` 混入 / path / query / hash) を弾く', () => {
		expect(filterCspOrigins(['https://x.com; script-src *'])).toEqual([]);   // `;` 注入
		expect(filterCspOrigins(['https://x.com/path'])).toEqual([]);            // path
		expect(filterCspOrigins(['https://x.com/'])).toEqual([]);               // 末尾 / (origin と不一致)
		expect(filterCspOrigins(['https://x.com?q=1'])).toEqual([]);            // query
		expect(filterCspOrigins(['https://x.com#h'])).toEqual([]);              // hash
		expect(filterCspOrigins(['https://user@x.com'])).toEqual([]);          // userinfo (origin と不一致)
	});

	test('http: / 不正 URL / 空配列は弾く', () => {
		expect(filterCspOrigins(['http://x.com'])).toEqual([]);
		expect(filterCspOrigins(['not a url'])).toEqual([]);
		expect(filterCspOrigins([])).toEqual([]);
		expect(filterCspOrigins(undefined)).toEqual([]);
	});

	test('混在配列から安全な origin だけ残す', () => {
		expect(filterCspOrigins(['https://ok.example', 'https://x.com; bad', 'http://no.example']))
			.toEqual(['https://ok.example']);
	});
});

describe('buildCspDirectiveParts', () => {
	test('許可ディレクティブ + 安全な origin を CSP 文字列に変換', () => {
		expect(buildCspDirectiveParts({ 'frame-src': ['https://drive.google.com'] }))
			.toEqual(['frame-src https://drive.google.com']);
		expect(buildCspDirectiveParts({ 'media-src': ['https://a.example', 'https://b.example'] }))
			.toEqual(['media-src https://a.example https://b.example']);
	});

	test('許可外ディレクティブ名は無視する (任意ディレクティブ注入防止)', () => {
		expect(buildCspDirectiveParts({ 'script-src': ['https://evil.example'] })).toEqual([]);
		expect(buildCspDirectiveParts({ 'default-src': ['https://evil.example'] })).toEqual([]);
	});

	test('不正な origin を含むディレクティブは安全分だけ、空なら出力しない (fail-close)', () => {
		expect(buildCspDirectiveParts({ 'frame-src': ['https://x.com; script-src *'] })).toEqual([]);
		expect(buildCspDirectiveParts({ 'frame-src': ['https://ok.example', 'https://x.com/path'] }))
			.toEqual(['frame-src https://ok.example']);
	});

	test('undefined / 空マップは空配列', () => {
		expect(buildCspDirectiveParts(undefined)).toEqual([]);
		expect(buildCspDirectiveParts({})).toEqual([]);
	});
});
