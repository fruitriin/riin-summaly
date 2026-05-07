/**
 * 小説家になろうプラグインの単体テスト (phase13.1 Step 3)。
 *
 * pure 関数 (extractNcodeAndR18 / buildApiUrl / composeDescription / composeEmbedHtml /
 * buildSummaryFromApi) を中心にネットワーク非依存でカバーする。
 * `summarize()` / `renderEmbed()` のフルフロー (実 API 経由) は
 * `test/index.test.ts` の network test や dev サーバ手動確認に委ねる。
 */

import { describe, expect, test } from 'vitest';
import {
	test as syosetuTest,
	extractNcodeAndR18,
	buildApiUrl,
	composeDescription,
	composeEmbedHtml,
	buildSummaryFromApi,
	type SyosetuNovelData,
} from '@/plugins/syosetu.js';

const SAMPLE_NOVEL: SyosetuNovelData = {
	title: 'サンプル長編タイトル',
	writer: '山田太郎',
	story: '異世界に転生した主人公が、運命の少女と出会い世界を救うまでの物語。\n章ごとに視点が変わる構成。',
	biggenre: 2, // ファンタジー
	genre: 201, // ハイファンタジー
	novel_type: 1, // 連載
	end: 0, // 連載中
	isr15: 0,
	iszankoku: 1, // 残酷描写あり
	isbl: 0,
	isgl: 0,
	keyword: '異世界転生 ハイファンタジー チート 主人公最強 ハッピーエンド 残酷',
};

describe('syosetu test() (URL マッチ)', () => {
	test('ncode.syosetu.com の作品 URL にマッチ', () => {
		expect(syosetuTest(new URL('https://ncode.syosetu.com/n7587fe/'))).toBe(true);
		expect(syosetuTest(new URL('https://ncode.syosetu.com/n7587fe/2/'))).toBe(true); // chapter URL
		expect(syosetuTest(new URL('https://ncode.syosetu.com/n1234ab/123/'))).toBe(true);
	});

	test('novel18.syosetu.com (R-18) にマッチ', () => {
		expect(syosetuTest(new URL('https://novel18.syosetu.com/n9999zz/'))).toBe(true);
	});

	test('別ホスト / 別パスはマッチしない', () => {
		expect(syosetuTest(new URL('https://syosetu.com/'))).toBe(false);
		expect(syosetuTest(new URL('https://www.syosetu.com/n7587fe/'))).toBe(false);
		expect(syosetuTest(new URL('https://example.com/n7587fe/'))).toBe(false);
		// ncode 形式でないパス
		expect(syosetuTest(new URL('https://ncode.syosetu.com/about/'))).toBe(false);
		expect(syosetuTest(new URL('https://ncode.syosetu.com/'))).toBe(false);
	});

	test('ncode に似た他パスは弾く (W-1 review feedback)', () => {
		// `n` + 英字続きのパス (ncode は数字を含む必要あり)
		expect(syosetuTest(new URL('https://ncode.syosetu.com/novelview/'))).toBe(false);
		expect(syosetuTest(new URL('https://ncode.syosetu.com/ncode/'))).toBe(false);
		expect(syosetuTest(new URL('https://ncode.syosetu.com/novels/'))).toBe(false);
		// `n` + 数字のみ (英字が無い、ncode 形式でない)
		expect(syosetuTest(new URL('https://ncode.syosetu.com/n12345/'))).toBe(false);
	});
});

describe('extractNcodeAndR18', () => {
	test('通常作品 URL', () => {
		const r = extractNcodeAndR18(new URL('https://ncode.syosetu.com/n7587fe/'));
		expect(r).toEqual({ ncode: 'n7587fe', isR18: false });
	});

	test('chapter URL → 作品 ncode に正規化', () => {
		const r = extractNcodeAndR18(new URL('https://ncode.syosetu.com/n7587fe/2/'));
		expect(r).toEqual({ ncode: 'n7587fe', isR18: false });
	});

	test('R-18 ドメインで isR18 = true', () => {
		const r = extractNcodeAndR18(new URL('https://novel18.syosetu.com/n9999zz/'));
		expect(r).toEqual({ ncode: 'n9999zz', isR18: true });
	});

	test('大文字 ncode は小文字に正規化', () => {
		const r = extractNcodeAndR18(new URL('https://ncode.syosetu.com/N7587FE/'));
		expect(r).toEqual({ ncode: 'n7587fe', isR18: false });
	});
});

describe('buildApiUrl', () => {
	test('通常 API', () => {
		const url = buildApiUrl('n7587fe', false);
		expect(url).toBe('https://api.syosetu.com/novelapi/api/?ncode=n7587fe&out=json&of=t-w-s-bg-g-nt-e-ir15-izk-ibl-igl-k');
	});

	test('R-18 API', () => {
		const url = buildApiUrl('n9999zz', true);
		expect(url).toBe('https://api.syosetu.com/novel18api/api/?ncode=n9999zz&out=json&of=t-w-s-bg-g-nt-e-ir15-izk-ibl-igl-k');
	});
});

describe('composeDescription', () => {
	test('連載中 + 残酷描写 + あらすじ抜粋', () => {
		const desc = composeDescription(SAMPLE_NOVEL);
		expect(desc).toContain('作者: 山田太郎');
		expect(desc).toContain('ハイファンタジー〔ファンタジー〕');
		expect(desc).toContain('連載中');
		expect(desc).toContain('[残酷描写]');
		expect(desc).toContain('あらすじ:');
		// あらすじが clip 80 で切れる
		expect(desc.length).toBeLessThan(300);
	});

	test('完結作品', () => {
		const desc = composeDescription({ ...SAMPLE_NOVEL, end: 1 });
		expect(desc).toContain('完結');
		expect(desc).not.toContain('連載中');
	});

	test('短編 (novel_type = 2)', () => {
		const desc = composeDescription({ ...SAMPLE_NOVEL, novel_type: 2 });
		expect(desc).toContain('短編');
		expect(desc).not.toContain('連載中');
	});

	test('R-15 + BL マーカー', () => {
		const desc = composeDescription({ ...SAMPLE_NOVEL, isr15: 1, isbl: 1, iszankoku: 0 });
		expect(desc).toContain('[R-15]');
		expect(desc).toContain('[BL]');
		expect(desc).not.toContain('[残酷描写]');
	});

	test('writer なし', () => {
		const desc = composeDescription({ ...SAMPLE_NOVEL, writer: undefined });
		expect(desc).not.toContain('作者:');
	});

	test('未知ジャンル ID は "その他" にフォールバック', () => {
		const desc = composeDescription({ ...SAMPLE_NOVEL, genre: 99999 });
		expect(desc).toContain('その他');
	});
});

describe('buildSummaryFromApi', () => {
	const url = new URL('https://ncode.syosetu.com/n7587fe/');

	test('通常作品 (R-18 でない)', () => {
		const s = buildSummaryFromApi(SAMPLE_NOVEL, url, false, undefined);
		expect(s.title).toBe('サンプル長編タイトル');
		expect(s.sitename).toBe('小説家になろう');
		expect(s.sensitive).toBe(false);
		expect(s.player.url).toBeNull();
	});

	test('R-18 作品で sensitive: true + sitename 切替', () => {
		const r18Url = new URL('https://novel18.syosetu.com/n9999zz/');
		const s = buildSummaryFromApi(SAMPLE_NOVEL, r18Url, true, undefined);
		expect(s.sensitive).toBe(true);
		expect(s.sitename).toBe('ノクターンノベルズ / ムーンライトノベルズ');
	});

	test('embedBaseUrl 指定で player.url が組み立てられる (3:2 アスペクト)', () => {
		const s = buildSummaryFromApi(SAMPLE_NOVEL, url, false, 'https://summaly.example.com');
		expect(s.player.url).toBe('https://summaly.example.com/embed?url=https%3A%2F%2Fncode.syosetu.com%2Fn7587fe%2F');
		expect(s.player.width).toBe(3);
		expect(s.player.height).toBe(2);
	});

	test('embedBaseUrl 末尾スラッシュは除去される', () => {
		const s = buildSummaryFromApi(SAMPLE_NOVEL, url, false, 'https://summaly.example.com/');
		expect(s.player.url).toBe('https://summaly.example.com/embed?url=https%3A%2F%2Fncode.syosetu.com%2Fn7587fe%2F');
	});

	test('thumbnail / icon は固定値', () => {
		const s = buildSummaryFromApi(SAMPLE_NOVEL, url, false, undefined);
		expect(s.thumbnail).toBe('https://syosetu.com/img/syosetu_logo.png');
		expect(s.icon).toBe('https://syosetu.com/favicon.ico');
	});
});

describe('composeEmbedHtml', () => {
	test('完全な HTML5 ドキュメント (`<!DOCTYPE html>` / `<html>` / `<head>` / `<body>`)', () => {
		const html = composeEmbedHtml(SAMPLE_NOVEL, false);
		expect(html).toMatch(/^<!DOCTYPE html>/);
		expect(html).toContain('<html lang="ja">');
		expect(html).toContain('<head>');
		expect(html).toContain('<body>');
		expect(html).toContain('</html>');
	});

	test('CSP 対応: <script> を含まない', () => {
		const html = composeEmbedHtml(SAMPLE_NOVEL, false);
		expect(html).not.toMatch(/<script[\s>]/i);
	});

	test('title / writer / 作品情報が含まれる', () => {
		const html = composeEmbedHtml(SAMPLE_NOVEL, false);
		expect(html).toContain('サンプル長編タイトル');
		expect(html).toContain('山田太郎');
		expect(html).toContain('ハイファンタジー〔ファンタジー〕');
		expect(html).toContain('連載中');
		expect(html).toContain('[残酷描写]');
	});

	test('keyword は上位 5 件のカンマ区切り', () => {
		const html = composeEmbedHtml(SAMPLE_NOVEL, false);
		// 6 個のキーワード入力 → 上位 5 件のみ
		expect(html).toContain('異世界転生, ハイファンタジー, チート, 主人公最強, ハッピーエンド');
		// 6 個目の 残酷 は含まれない
		expect(html).toMatch(/タグ: 異世界転生, ハイファンタジー, チート, 主人公最強, ハッピーエンド[<\s]/);
	});

	test('R-18 で sitename が切り替わる', () => {
		const html = composeEmbedHtml(SAMPLE_NOVEL, true);
		expect(html).toContain('ノクターンノベルズ / ムーンライトノベルズ');
		expect(html).not.toContain('小説家になろう</div>'); // sitename フィールドの完全一致でないことを確認
	});

	test('XSS: title に <script> を含めても escape される', () => {
		const malicious: SyosetuNovelData = {
			...SAMPLE_NOVEL,
			title: '<script>alert("XSS")</script>',
		};
		const html = composeEmbedHtml(malicious, false);
		expect(html).not.toContain('<script>alert');
		expect(html).toContain('&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;');
	});

	test('XSS: writer に属性破壊攻撃を含めても escape される', () => {
		const malicious: SyosetuNovelData = {
			...SAMPLE_NOVEL,
			writer: '" onerror="alert(1)',
		};
		const html = composeEmbedHtml(malicious, false);
		expect(html).not.toContain('onerror="alert');
		expect(html).toContain('&quot; onerror=&quot;alert(1)');
	});

	test('XSS: story に CSS expression インジェクション試行も escape される', () => {
		// `<style>` ブロックは固定 (動的に挿入される値ではない) ので CSS injection はそもそも経路が無いが、
		// テキストコンテントとしての escape は必須
		const malicious: SyosetuNovelData = {
			...SAMPLE_NOVEL,
			story: 'expression(alert(1)) <img src=x onerror=alert(1)>',
		};
		const html = composeEmbedHtml(malicious, false);
		expect(html).not.toContain('<img src=x');
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
	});

	test('story が長い場合は 300 文字で clip', () => {
		const longStory = 'あ'.repeat(500);
		const malicious: SyosetuNovelData = { ...SAMPLE_NOVEL, story: longStory };
		const html = composeEmbedHtml(malicious, false);
		// 全 500 文字は含まれない (clip で切られる)
		expect(html).not.toContain('あ'.repeat(500));
	});

	test('未知ジャンル ID でも壊れない (フォールバック)', () => {
		const html = composeEmbedHtml({ ...SAMPLE_NOVEL, genre: 99999 }, false);
		expect(html).toContain('その他');
	});

	test('writer / title が空でも壊れない (フォールバック)', () => {
		const html = composeEmbedHtml({ ...SAMPLE_NOVEL, title: undefined, writer: undefined }, false);
		expect(html).toContain('(タイトル不明)');
		expect(html).toContain('(作者不明)');
	});
});
