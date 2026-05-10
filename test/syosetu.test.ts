/**
 * 小説家になろうプラグインの単体テスト (phase13.1 Step 3)。
 *
 * pure 関数 (extractNcodeAndR18 / buildApiUrl / composeDescription / composeEmbedHtml /
 * buildSummaryFromApi) を中心にネットワーク非依存でカバーする。
 * `summarize()` / `renderEmbed()` のフルフロー (実 API 経由) は
 * `test/index.test.ts` の network test や dev サーバ手動確認に委ねる。
 */

import { describe, expect, test } from 'vitest';
import * as cheerio from 'cheerio';
import {
	test as syosetuTest,
	extractNcodeAndR18,
	buildApiUrl,
	composeDescription,
	composeEmbedHtml,
	buildSummaryFromApi,
	extractNovelDataFromHtml,
	extractChapterTitle,
	extractEpisodeBody,
	type SyosetuNovelData,
} from '@/plugins/syosetu.js';

const SAMPLE_NOVEL: SyosetuNovelData = {
	title: 'サンプル長編タイトル',
	writer: '山田太郎',
	story: '異世界に転生した主人公が、運命の少女と出会い世界を救うまでの物語。\n章ごとに視点が変わる構成。',
	biggenre: 2, // ファンタジー
	genre: 201, // ハイファンタジー
	noveltype: 1, // 連載
	end: 1, // 連載中 (なろう公式 API: 短編/完結済=0、連載中=1)
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

	test('年齢確認ゲート URL (nl.syosetu.com/redirect/ageauth/) にも内側 URL がマッチすれば true', () => {
		// novel18 への通常 GET が 302 で返す redirect 先。何らかの経路で summaly に到達した場合の救援
		const ageAuthUrl = new URL('https://nl.syosetu.com/redirect/ageauth/?url=https%3A%2F%2Fnovel18.syosetu.com%2Fn8344gr%2F&hash=6b23ac96');
		expect(syosetuTest(ageAuthUrl)).toBe(true);
	});

	test('ageauth URL の inner が ncode 形式でないなら false', () => {
		const ageAuthUrl = new URL('https://nl.syosetu.com/redirect/ageauth/?url=https%3A%2F%2Fexample.com%2F&hash=xxx');
		expect(syosetuTest(ageAuthUrl)).toBe(false);
	});

	test('ageauth URL に ?url= が無ければ false', () => {
		const ageAuthUrl = new URL('https://nl.syosetu.com/redirect/ageauth/');
		expect(syosetuTest(ageAuthUrl)).toBe(false);
	});
});

describe('extractNcodeAndR18', () => {
	test('通常作品 URL', () => {
		const r = extractNcodeAndR18(new URL('https://ncode.syosetu.com/n7587fe/'));
		expect(r).toEqual({ ncode: 'n7587fe', isR18: false, chapter: null });
	});

	test('chapter URL → 作品 ncode + chapter 番号', () => {
		const r = extractNcodeAndR18(new URL('https://ncode.syosetu.com/n7587fe/2/'));
		expect(r).toEqual({ ncode: 'n7587fe', isR18: false, chapter: '2' });
	});

	test('chapter URL (末尾スラッシュ無し)', () => {
		const r = extractNcodeAndR18(new URL('https://ncode.syosetu.com/n7587fe/123'));
		expect(r).toEqual({ ncode: 'n7587fe', isR18: false, chapter: '123' });
	});

	test('R-18 ドメインで isR18 = true', () => {
		const r = extractNcodeAndR18(new URL('https://novel18.syosetu.com/n9999zz/'));
		expect(r).toEqual({ ncode: 'n9999zz', isR18: true, chapter: null });
	});

	test('大文字 ncode は小文字に正規化', () => {
		const r = extractNcodeAndR18(new URL('https://ncode.syosetu.com/N7587FE/'));
		expect(r).toEqual({ ncode: 'n7587fe', isR18: false, chapter: null });
	});

	test('ageauth URL から R-18 元 URL を unwrap', () => {
		const r = extractNcodeAndR18(new URL('https://nl.syosetu.com/redirect/ageauth/?url=https%3A%2F%2Fnovel18.syosetu.com%2Fn8344gr%2F&hash=xxx'));
		expect(r).toEqual({ ncode: 'n8344gr', isR18: true, chapter: null });
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
	// **設計**: card description は **あらすじだけ** を返す方針 (作者 / ジャンル /
	// 連載ステータス / マーカーは embed iframe に集約。Misskey カード幅であらすじが
	// 見切れないようにするため)。

	test('あらすじだけが返る (作者・ジャンル・連載ステータス・マーカーは含めない)', () => {
		const desc = composeDescription(SAMPLE_NOVEL);
		expect(desc).toMatch(/^あらすじ: /);
		expect(desc).toContain('異世界に転生した主人公');
		expect(desc).not.toContain('作者:');
		expect(desc).not.toContain('連載中');
		expect(desc).not.toContain('ハイファンタジー');
		expect(desc).not.toContain('[残酷描写]');
	});

	test('あらすじが clip 80 文字で切れる', () => {
		const desc = composeDescription({ ...SAMPLE_NOVEL, story: 'あ'.repeat(500) });
		// 「あらすじ: 」 prefix + clip 結果 (最大 80 文字 + … 等)
		expect(desc.length).toBeLessThan(150);
	});

	test('story が undefined なら空文字を返す', () => {
		const desc = composeDescription({ ...SAMPLE_NOVEL, story: undefined });
		expect(desc).toBe('');
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

	test('title / writer / 作品情報 / マーカーが meta 行に含まれる', () => {
		const html = composeEmbedHtml(SAMPLE_NOVEL, false);
		expect(html).toContain('サンプル長編タイトル');
		expect(html).toContain('山田太郎');
		expect(html).toContain('ハイファンタジー〔ファンタジー〕');
		expect(html).toContain('連載中');
		// マーカーは独立 div ではなく meta 行末尾に <span class="markers"> で統合 (赤文字強調)
		expect(html).toContain('[残酷描写]');
		expect(html).not.toContain('<div class="markers"');
		expect(html).toContain('<span class="markers">[残酷描写]</span>');
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

	test('meta 行は「作者 / 連載ステータス / ジャンル / 警告」の順序で 1 行統合 (警告は赤文字 span)', () => {
		const html = composeEmbedHtml(SAMPLE_NOVEL, false);
		// SAMPLE_NOVEL: noveltype=1 / end=1 (連載中) / genre=201 (ハイファンタジー) / iszankoku=1 (残酷描写)
		// → `作者: 山田太郎 / 連載中 / ハイファンタジー〔ファンタジー〕 / <span class="markers">[残酷描写]</span>`
		expect(html).toMatch(/<div class="meta">作者: 山田太郎 \/ 連載中 \/ ハイファンタジー〔ファンタジー〕 \/ <span class="markers">\[残酷描写\]<\/span><\/div>/);
		// markers は独立 div ではなく meta 行内の span で統合
		expect(html).not.toContain('<div class="markers"');
		// CSS で赤文字定義が存在する
		expect(html).toContain('.markers { color: #b22; }');
	});

	test('マーカー無しの作品は meta 行末尾の警告 span が省略される', () => {
		const clean: SyosetuNovelData = {
			...SAMPLE_NOVEL,
			isr15: 0, iszankoku: 0, isbl: 0, isgl: 0,
		};
		const html = composeEmbedHtml(clean, false);
		expect(html).toMatch(/<div class="meta">作者: 山田太郎 \/ 連載中 \/ ハイファンタジー〔ファンタジー〕<\/div>/);
		expect(html).not.toContain('<span class="markers">');
		expect(html).not.toContain('[残酷描写]');
	});

	test('ジャンル取得不可 (R-18 等) のとき meta 行からジャンルを省略', () => {
		// novel18api はジャンルフィールドを返さない仕様。biggenre/genre が undefined のとき
		// 「作者: ... / 連載中 / <span class="markers">[残酷描写]</span>」の 3 要素になる。
		const r18Sample: SyosetuNovelData = {
			...SAMPLE_NOVEL,
			biggenre: undefined,
			genre: undefined,
		};
		const html = composeEmbedHtml(r18Sample, true);
		expect(html).toMatch(/<div class="meta">作者: 山田太郎 \/ 連載中 \/ <span class="markers">\[残酷描写\]<\/span><\/div>/);
	});

	test('複数マーカー (R-15 + BL + 残酷描写) は meta 行末尾の span 内にスペース区切りで連結', () => {
		const html = composeEmbedHtml({ ...SAMPLE_NOVEL, isr15: 1, isbl: 1 }, false);
		expect(html).toMatch(/\/ <span class="markers">\[R-15\] \[残酷描写\] \[BL\]<\/span><\/div>/);
	});

	test('完結作品で「完結済」表記', () => {
		// なろう公式 API: end = 0 が完結済 (短編も 0、連載中は 1)
		const html = composeEmbedHtml({ ...SAMPLE_NOVEL, end: 0 }, false);
		expect(html).toContain('完結済');
		expect(html).not.toMatch(/\/ 連載中</);
	});

	test('短編 (noveltype = 2) で「短編」表記', () => {
		const html = composeEmbedHtml({ ...SAMPLE_NOVEL, noveltype: 2 }, false);
		expect(html).toContain('短編');
		expect(html).not.toMatch(/\/ 連載中</);
	});

	test('「あらすじ」見出しなし、タグはあらすじの後ろ', () => {
		const html = composeEmbedHtml(SAMPLE_NOVEL, false);
		// あらすじラベル div は撤廃 (story 本文だけ表示)
		expect(html).not.toContain('class="story-label"');
		expect(html).not.toMatch(/>あらすじ</);
		// タグはあらすじより後ろに配置 (重要要素を上に寄せる Mi プレイヤー対策)
		const storyIdx = html.indexOf('class="story"');
		const tagsIdx = html.indexOf('class="keywords"');
		expect(storyIdx).toBeGreaterThan(0);
		expect(tagsIdx).toBeGreaterThan(storyIdx);
	});

	test('chapter URL: episode-title 行が title 直下に「」付きで表示', () => {
		const html = composeEmbedHtml(SAMPLE_NOVEL, false, '第一話 始まり');
		expect(html).toContain('<div class="episode-title">「第一話 始まり」</div>');
		const titleIdx = html.indexOf('<div class="title">');
		const epIdx = html.indexOf('<div class="episode-title">');
		const metaIdx = html.indexOf('<div class="meta">');
		expect(titleIdx).toBeGreaterThan(0);
		expect(epIdx).toBeGreaterThan(titleIdx);
		expect(metaIdx).toBeGreaterThan(epIdx);
	});

	test('chapter URL: episodeBody が指定されたら story 部分を本文に置換 (story を使わない)', () => {
		const body = 'ダンッ！ダンッ！と何かを床や台に叩きつけているような音と共に、わたしが寝ている場所がぐらんぐらんと揺れた。';
		const html = composeEmbedHtml(SAMPLE_NOVEL, false, '第一話', body);
		expect(html).toContain('ダンッ！ダンッ！');
		// 作品 story (introduction) は使われない
		expect(html).not.toContain('異世界に転生した主人公');
	});

	test('episodeBody 不在なら従来どおり story (作品あらすじ) を表示', () => {
		const html = composeEmbedHtml(SAMPLE_NOVEL, false, '第一話', null);
		expect(html).toContain('異世界に転生した主人公');
	});

	test('work URL (chapter なし) では episode-title 行を出さない', () => {
		const html = composeEmbedHtml(SAMPLE_NOVEL, false);
		expect(html).not.toContain('class="episode-title"');
	});

	test('XSS: episodeTitle に <script> を含めても escape される', () => {
		const html = composeEmbedHtml(SAMPLE_NOVEL, false, '<script>alert(1)</script>');
		expect(html).not.toMatch(/<script>alert/);
		expect(html).toContain('&lt;script&gt;');
	});

	test('XSS: episodeBody に <script> を含めても escape される', () => {
		const html = composeEmbedHtml(SAMPLE_NOVEL, false, '第一話', '<script>alert(1)</script>本文だ');
		expect(html).not.toMatch(/<script>alert/);
		expect(html).toContain('&lt;script&gt;');
	});
});

describe('extractChapterTitle', () => {
	test('h1.p-novel__title から各話タイトル抽出', () => {
		const $ = cheerio.load('<h1 class="p-novel__title p-novel__title--rensai">第一話 始まり</h1>');
		expect(extractChapterTitle($)).toBe('第一話 始まり');
	});

	test('h1 不在なら og:title から fallback', () => {
		const $ = cheerio.load('<meta property="og:title" content="作品名 - 第一話 始まり">');
		expect(extractChapterTitle($)).toBe('第一話 始まり');
	});

	test('両方不在なら null', () => {
		const $ = cheerio.load('<div></div>');
		expect(extractChapterTitle($)).toBeNull();
	});
});

describe('extractEpisodeBody', () => {
	test('p-novel__text 内の <p> を改行結合', () => {
		const html = `<div class="p-novel__body">
<div class="js-novel-text p-novel__text">
<p id="L1">ダンッ！ダンッ！と何かを床や台に叩きつけているような音。</p>
<p id="L2">わたしが寝ている場所がぐらんぐらんと揺れた。</p>
</div>
</div>`;
		const $ = cheerio.load(html);
		expect(extractEpisodeBody($)).toBe(
			'ダンッ！ダンッ！と何かを床や台に叩きつけているような音。\nわたしが寝ている場所がぐらんぐらんと揺れた。',
		);
	});

	test('前書き (foreword) と後書き (afterword) は除外', () => {
		const html = `<div class="p-novel__body">
<div class="js-novel-text p-novel__text p-novel__text--foreword">
<p>前書きです。</p>
</div>
<div class="js-novel-text p-novel__text">
<p>本文1段落目。</p>
<p>本文2段落目。</p>
</div>
<div class="js-novel-text p-novel__text p-novel__text--afterword">
<p>後書きです。</p>
</div>
</div>`;
		const $ = cheerio.load(html);
		const body = extractEpisodeBody($);
		expect(body).toBe('本文1段落目。\n本文2段落目。');
		expect(body).not.toContain('前書き');
		expect(body).not.toContain('後書き');
	});

	test('全角空白だけの段落 / <br> だけの段落はスキップ', () => {
		const html = `<div class="p-novel__text">
<p id="L1">　</p>
<p id="L2">本文1。</p>
<p id="L3"><br /></p>
<p id="L4">本文2。</p>
</div>`;
		const $ = cheerio.load(html);
		expect(extractEpisodeBody($)).toBe('本文1。\n本文2。');
	});

	test('構造が無ければ null', () => {
		const $ = cheerio.load('<div>無関係</div>');
		expect(extractEpisodeBody($)).toBeNull();
	});

	test('段落が無ければ null', () => {
		const $ = cheerio.load('<div class="p-novel__text"><span>no p</span></div>');
		expect(extractEpisodeBody($)).toBeNull();
	});
});

describe('composeDescription chapter URL 上書き挙動 (summarize 経由)', () => {
	// composeDescription 自体は work 用なので、ここでは「summary.description が
	// `「<title>」 / <body>` 形式に置き換わるロジック」を呼出側コードと整合性をもって担保する。
	// 詳細な挙動は extractEpisodeBody / extractChapterTitle の単体テストに分離。

	test('composeDescription はあらすじだけを返す (chapter URL 関係なく不変)', () => {
		const desc = composeDescription(SAMPLE_NOVEL);
		expect(desc).toMatch(/^あらすじ: /);
	});
});

describe('extractNovelDataFromHtml (API allcount=0 fallback)', () => {
	// なろう作品トップ HTML の最小再現 fixture (実 HTML の n3862be 構造を簡略化)
	const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta property="og:title" content="俺たちの魔王はこれからだ。">
<meta property="og:description" content="残酷な描写あり 異世界転生 異世界転移 オリジナル戦記 ラブコメ 魔王 勇者">
<meta property="og:image" content="https://sbo.syosetu.com/n3862be/twitter.png">
</head>
<body>
<h1 class="p-novel__title">俺たちの魔王はこれからだ。</h1>
<div class="p-novel__author">作者：<a href="https://mypage.syosetu.com/183373/">かっぱ</a></div>
<div id="novel_ex" class="p-novel__summary">高校生の透、真紀子、静は、前世にて異世界の三大魔王として君臨していた記憶を持っています。<br />詳細省略。</div>
<p>この作品には<br>〔残酷描写〕が含まれています。</p>
</body>
</html>`;

	test('title / writer / story が抽出される', () => {
		const $ = cheerio.load(SAMPLE_HTML);
		const data = extractNovelDataFromHtml($);
		expect(data).not.toBeNull();
		expect(data?.title).toBe('俺たちの魔王はこれからだ。');
		expect(data?.writer).toBe('かっぱ');
		expect(data?.story).toContain('高校生の透、真紀子、静');
	});

	test('〔残酷描写〕テキストパターンで iszankoku が立つ', () => {
		const $ = cheerio.load(SAMPLE_HTML);
		const data = extractNovelDataFromHtml($);
		expect(data?.iszankoku).toBe(1);
		expect(data?.isr15).toBe(0);
		expect(data?.isbl).toBe(0);
		expect(data?.isgl).toBe(0);
	});

	test('og:description から keyword 抽出 (先頭マーカー prefix を除去)', () => {
		const $ = cheerio.load(SAMPLE_HTML);
		const data = extractNovelDataFromHtml($);
		// `残酷な描写あり` prefix が除外されて、キーワードだけ残る
		expect(data?.keyword).toBe('異世界転生 異世界転移 オリジナル戦記 ラブコメ 魔王 勇者');
		expect(data?.keyword).not.toContain('残酷な描写あり');
	});

	test('HTML 由来データで取れないフィールドは undefined (embed の meta 行から省略される)', () => {
		const $ = cheerio.load(SAMPLE_HTML);
		const data = extractNovelDataFromHtml($);
		expect(data?.biggenre).toBeUndefined();
		expect(data?.genre).toBeUndefined();
		expect(data?.noveltype).toBeUndefined();
		// HTML 経路では連載状態 (end) を取らない (連載中作品でも「最終エピソード掲載日」が
		// 表示されるためラベル差で連載/完結を区別できない)
		expect(data?.end).toBeUndefined();
		// composeDescription はあらすじだけ返す (新仕様)。作者/連載状態/警告は embed 側に集約
		const desc = composeDescription(data!);
		expect(desc).toMatch(/^あらすじ: /);
		expect(desc).not.toContain('作者:');
		expect(desc).not.toContain('連載中');
		expect(desc).not.toContain('完結済');
	});

	test('buildSummaryFromApi に流して Summary が組み立てられる', () => {
		const $ = cheerio.load(SAMPLE_HTML);
		const data = extractNovelDataFromHtml($);
		const url = new URL('https://ncode.syosetu.com/n3862be/');
		const summary = buildSummaryFromApi(data!, url, false, undefined);
		expect(summary.title).toBe('俺たちの魔王はこれからだ。');
		expect(summary.sitename).toBe('小説家になろう');
		expect(summary.sensitive).toBe(false);
		// 新仕様: description はあらすじのみ
		expect(summary.description).toMatch(/^あらすじ: /);
		expect(summary.description).toContain('高校生の透');
	});

	test('複数マーカー prefix (R15 + ボーイズラブ) を除去する', () => {
		const html = `<html><head>
<meta property="og:description" content="R15 ボーイズラブ 残酷な描写あり 異世界転生 学園 BL">
</head><body>
<h1 class="p-novel__title">test</h1>
<div class="p-novel__author">作者：x</div>
</body></html>`;
		const $ = cheerio.load(html);
		const data = extractNovelDataFromHtml($);
		expect(data?.keyword).toBe('異世界転生 学園 BL');
	});

	test('writer の <a> が無くても「作者：xxx」テキストから抽出 (fallback)', () => {
		const html = `<html><head></head><body>
<h1 class="p-novel__title">test</h1>
<div class="p-novel__author">作者：佐藤花子</div>
</body></html>`;
		const $ = cheerio.load(html);
		const data = extractNovelDataFromHtml($);
		expect(data?.writer).toBe('佐藤花子');
	});

	test('title も writer も無ければ null (構造変更で完全に壊れたケース)', () => {
		const html = `<html><head></head><body><p>削除されました</p></body></html>`;
		const $ = cheerio.load(html);
		const data = extractNovelDataFromHtml($);
		expect(data).toBeNull();
	});

	test('og:title から title フォールバック (h1 タグが無い場合)', () => {
		const html = `<html><head><meta property="og:title" content="og titleのみ"></head><body>
<div class="p-novel__author">作者：x</div>
</body></html>`;
		const $ = cheerio.load(html);
		const data = extractNovelDataFromHtml($);
		expect(data?.title).toBe('og titleのみ');
	});
});
