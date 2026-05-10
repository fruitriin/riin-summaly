/**
 * カクヨムプラグインの単体テスト (phase15.2)。
 *
 * pure 関数 (extractWorkAndEpisode / extractApolloState / findWorkInApolloState /
 * lookupAuthorName / composeDescription / composeEmbedHtml / buildSummaryFromWork) を中心に
 * ネットワーク非依存でカバーする。`summarize()` / `renderEmbed()` のフルフロー (実 HTML 経由) は
 * dev サーバ手動確認 / 本番運用ログに委ねる。
 */

import { describe, expect, test } from 'vitest';
import * as cheerio from 'cheerio';
import {
	test as kakuyomuTest,
	extractWorkAndEpisode,
	extractApolloState,
	findWorkInApolloState,
	lookupAuthorName,
	composeDescription,
	composeEmbedHtml,
	buildSummaryFromWork,
	extractEpisodeTitleFromOg,
	extractEpisodeBody,
	type KakuyomuWork,
} from '@/plugins/kakuyomu.js';

const SAMPLE_WORK: KakuyomuWork = {
	__typename: 'Work',
	id: '1177354054894377419',
	title: 'サンプル作品タイトル',
	catchphrase: '【己的に恐ろしいPV数…感謝…】結婚生活８年目、見知らぬ旦那様へ―――',
	introduction: 'これはあらすじです。\n改行も含む長めのあらすじを想定したテキスト。',
	genre: 'LOVE_STORY',
	serialStatus: 'RUNNING',
	publicEpisodeCount: 169,
	totalCharacterCount: 282850,
	publishedAt: '2020-04-12T09:37:12Z',
	lastEpisodePublishedAt: '2026-03-25T20:01:08Z',
	hasPublication: true,
	ogImageUrl: 'https://cdn-static.kakuyomu.jp/works/1177354054894377419/ogimage.png',
	isCruel: true,
	isSexual: false,
	isViolent: false,
	tagLabels: ['恋愛', '異世界', '戦争', '中佐', 'じゃじゃ馬'],
	author: { __ref: 'UserAccount:1177354054891896905' },
};

describe('kakuyomu test() (URL マッチ)', () => {
	test('作品トップ URL にマッチ', () => {
		expect(kakuyomuTest(new URL('https://kakuyomu.jp/works/1177354054894377419'))).toBe(true);
		expect(kakuyomuTest(new URL('https://kakuyomu.jp/works/1177354054894377419/'))).toBe(true);
	});

	test('episode (各話) URL にマッチ', () => {
		expect(kakuyomuTest(new URL('https://kakuyomu.jp/works/1177354054894377419/episodes/1177354054896025002'))).toBe(true);
	});

	test('別ホスト / 別パスはマッチしない', () => {
		expect(kakuyomuTest(new URL('https://kakuyomu.jp/'))).toBe(false);
		expect(kakuyomuTest(new URL('https://kakuyomu.jp/users/markoh'))).toBe(false);
		expect(kakuyomuTest(new URL('https://example.com/works/123'))).toBe(false);
		// works 配下だが ID が数字でない
		expect(kakuyomuTest(new URL('https://kakuyomu.jp/works/'))).toBe(false);
		expect(kakuyomuTest(new URL('https://kakuyomu.jp/works/abc'))).toBe(false);
	});
});

describe('extractWorkAndEpisode', () => {
	test('作品トップ URL', () => {
		const r = extractWorkAndEpisode(new URL('https://kakuyomu.jp/works/1177354054894377419'));
		expect(r).toEqual({ workId: '1177354054894377419', episodeId: null });
	});

	test('episode URL', () => {
		const r = extractWorkAndEpisode(new URL('https://kakuyomu.jp/works/1177354054894377419/episodes/1177354054896025002'));
		expect(r).toEqual({ workId: '1177354054894377419', episodeId: '1177354054896025002' });
	});
});

describe('extractApolloState + findWorkInApolloState', () => {
	const workId = '1177354054894377419';
	const userId = 'UserAccount:abc';

	const SAMPLE_HTML = `<!DOCTYPE html><html><head></head><body>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
	props: {
		pageProps: {
			__APOLLO_STATE__: {
				[`Work:${workId}`]: {
					__typename: 'Work',
					id: workId,
					title: 'テスト作品',
					genre: 'LOVE_STORY',
					introduction: 'あらすじ',
					serialStatus: 'RUNNING',
					publicEpisodeCount: 10,
					isSexual: false,
					isCruel: true,
					isViolent: false,
					tagLabels: ['tag1', 'tag2'],
					author: { __ref: userId },
				},
				[userId]: {
					__typename: 'UserAccount',
					id: 'abc',
					name: 'テスト作者',
				},
			},
		},
	},
})}</script>
</body></html>`;

	test('__NEXT_DATA__ から Apollo state が取れる', () => {
		const $ = cheerio.load(SAMPLE_HTML);
		const state = extractApolloState($);
		expect(state).not.toBeNull();
	});

	test('Work エンティティが見つかる', () => {
		const $ = cheerio.load(SAMPLE_HTML);
		const state = extractApolloState($);
		const found = findWorkInApolloState(state, workId);
		expect(found).not.toBeNull();
		expect(found?.work.title).toBe('テスト作品');
		expect(found?.work.genre).toBe('LOVE_STORY');
	});

	test('UserAccount lookup で作者名が取れる', () => {
		const $ = cheerio.load(SAMPLE_HTML);
		const state = extractApolloState($);
		expect(lookupAuthorName(state, userId)).toBe('テスト作者');
	});

	test('該当 Work が無ければ null', () => {
		const $ = cheerio.load(SAMPLE_HTML);
		const state = extractApolloState($);
		expect(findWorkInApolloState(state, '99999')).toBeNull();
	});

	test('script タグが無い HTML では state = null', () => {
		const $ = cheerio.load('<html><head></head><body>x</body></html>');
		expect(extractApolloState($)).toBeNull();
	});

	test('壊れた JSON でも throw せず null を返す', () => {
		const $ = cheerio.load('<html><body><script id="__NEXT_DATA__">{not json}</script></body></html>');
		expect(extractApolloState($)).toBeNull();
	});
});

describe('composeDescription', () => {
	// **設計**: card description は **あらすじだけ** を返す方針 (Misskey カード幅で
	// description が複数要素入るとあらすじが見切れるため、メタ情報は embed iframe に集約。
	// syosetu プラグインと同じ設計)。

	test('あらすじだけが返る (作者・ジャンル・連載ステータス・マーカーは含めない)', () => {
		const desc = composeDescription(SAMPLE_WORK);
		expect(desc).toMatch(/^あらすじ: /);
		expect(desc).toContain('結婚生活'); // catchphrase の冒頭
		expect(desc).not.toContain('作者:');
		expect(desc).not.toContain('連載中');
		expect(desc).not.toContain('恋愛');
		expect(desc).not.toContain('[残酷描写]');
	});

	test('catchphrase が無ければ introduction が使われる', () => {
		const desc = composeDescription({ ...SAMPLE_WORK, catchphrase: null });
		expect(desc).toMatch(/^あらすじ: /);
		expect(desc).toContain('これはあらすじです');
	});

	test('catchphrase / introduction 両方無ければ空文字', () => {
		const desc = composeDescription({ ...SAMPLE_WORK, catchphrase: null, introduction: null });
		expect(desc).toBe('');
	});

	test('あらすじが clip 80 文字で切れる', () => {
		const desc = composeDescription({ ...SAMPLE_WORK, catchphrase: 'あ'.repeat(500), introduction: null });
		expect(desc.length).toBeLessThan(150);
	});

	test('episode URL なら各話タイトルを「」付きで prefix に置く', () => {
		// 旧実装は末尾に `/ 序章` で付与していたが、新仕様 (あらすじだけ) と組み合わせると
		// あらすじの一部に見えるため、prefix `「序章」 / あらすじ: ...` で識別性を確保
		const desc = composeDescription(SAMPLE_WORK, '序章');
		expect(desc).toMatch(/^「序章」 \/ あらすじ: /);
		expect(desc).toContain('結婚生活');
	});

	test('episode URL であらすじが無い場合は各話タイトルだけ返る', () => {
		const desc = composeDescription({ ...SAMPLE_WORK, catchphrase: null, introduction: null }, '序章');
		expect(desc).toBe('「序章」');
	});

	test('episodeTitle が空文字なら付与しない (work URL 扱い)', () => {
		const desc = composeDescription(SAMPLE_WORK, '');
		expect(desc).toMatch(/^あらすじ: /);
		expect(desc).not.toContain('「」');
	});

	test('episode URL で episodeBody が取れたら本文先頭をあらすじ代わりに使う', () => {
		// 各話の本文 1 行目以降を「あらすじ:」ラベル無しで表示 (本文先頭は「あらすじ」ではないため)
		const body = '後宮の下っ端宮女の雨妹は、今日も元気に掃除に勤しんでいる。\n「綺麗になるって気持ちいい～♪」';
		const desc = composeDescription(SAMPLE_WORK, '序章', body);
		expect(desc).toMatch(/^「序章」 \/ /);
		expect(desc).toContain('後宮の下っ端宮女の雨妹');
		expect(desc).not.toContain('あらすじ:'); // 本文なのでラベル無し
		expect(desc).not.toContain('結婚生活'); // catchphrase は使われない (episodeBody 優先)
	});

	test('episode URL で episodeBody 不在なら作品 catchphrase に fallback', () => {
		const desc = composeDescription(SAMPLE_WORK, '序章', null);
		expect(desc).toMatch(/^「序章」 \/ あらすじ: /);
		expect(desc).toContain('結婚生活'); // catchphrase
	});

	test('episode URL で episodeBody 空文字も fallback 扱い', () => {
		const desc = composeDescription(SAMPLE_WORK, '序章', '');
		expect(desc).toMatch(/^「序章」 \/ あらすじ: /);
	});

	test('episodeBody が長い場合は 80 文字で clip', () => {
		const longBody = 'あ'.repeat(500);
		const desc = composeDescription(SAMPLE_WORK, '序章', longBody);
		expect(desc.length).toBeLessThan(150);
	});
});

describe('extractEpisodeTitleFromOg', () => {
	test('og:title から各話タイトルを抽出', () => {
		expect(extractEpisodeTitleFromOg('序章 - 百花宮のお掃除係 - カクヨム')).toBe('序章');
	});

	test('作品タイトルに " - " が含まれる場合は末尾の " - " で split', () => {
		// 末尾 ' - ' で split = `<EpisodeTitle>` / `<WorkTitle - subtitle>`
		expect(extractEpisodeTitleFromOg('第1話 - 異世界転生 - 異世界では英雄になりました - カクヨム'))
			.toBe('第1話 - 異世界転生');
	});

	test('og:title が空なら null', () => {
		expect(extractEpisodeTitleFromOg('')).toBeNull();
	});

	test('" - " が無いなら null', () => {
		expect(extractEpisodeTitleFromOg('単一タイトル - カクヨム')).toBeNull();
	});
});

describe('extractEpisodeBody', () => {
	test('widget-episodeBody 内の <p> を改行で結合', () => {
		const html = `<html><body>
<div class="widget-episodeBody js-episode-body">
<p id="p1">後宮の下っ端宮女の雨妹は、今日も元気に掃除に勤しんでいる。</p>
<p id="p2">「綺麗になるって気持ちいい～♪」</p>
<p id="p3">鼻歌交じりに雑巾がけをしていると、回廊を誰かが歩いてくる音がする。</p>
</div>
</body></html>`;
		const $ = cheerio.load(html);
		const body = extractEpisodeBody($);
		expect(body).toBe(
			'後宮の下っ端宮女の雨妹は、今日も元気に掃除に勤しんでいる。\n「綺麗になるって気持ちいい～♪」\n鼻歌交じりに雑巾がけをしていると、回廊を誰かが歩いてくる音がする。',
		);
	});

	test('class="widget-episodeBody" のみでも取れる (js-episode-body 不在ケース)', () => {
		const html = `<div class="widget-episodeBody"><p>テスト本文</p></div>`;
		const $ = cheerio.load(html);
		expect(extractEpisodeBody($)).toBe('テスト本文');
	});

	test('空段落はスキップ', () => {
		const html = `<div class="widget-episodeBody">
<p></p>
<p>本文1</p>
<p>   </p>
<p>本文2</p>
</div>`;
		const $ = cheerio.load(html);
		expect(extractEpisodeBody($)).toBe('本文1\n本文2');
	});

	test('構造が無ければ null', () => {
		const $ = cheerio.load('<div>無関係</div>');
		expect(extractEpisodeBody($)).toBeNull();
	});

	test('段落が無ければ null', () => {
		const $ = cheerio.load('<div class="widget-episodeBody"><span>no p</span></div>');
		expect(extractEpisodeBody($)).toBeNull();
	});
});

describe('buildSummaryFromWork', () => {
	const url = new URL('https://kakuyomu.jp/works/1177354054894377419');

	test('通常作品', () => {
		const s = buildSummaryFromWork(SAMPLE_WORK, '山田', url, undefined);
		expect(s.title).toBe('サンプル作品タイトル');
		expect(s.sitename).toBe('カクヨム');
		expect(s.sensitive).toBe(false); // isSexual = false
		expect(s.player.url).toBeNull();
		expect(s.thumbnail).toBe('https://cdn-static.kakuyomu.jp/works/1177354054894377419/ogimage.png');
	});

	test('isSexual = true で sensitive: true', () => {
		const s = buildSummaryFromWork({ ...SAMPLE_WORK, isSexual: true }, '山田', url, undefined);
		expect(s.sensitive).toBe(true);
	});

	test('embedBaseUrl 指定で player.url が組み立てられる (3:2)', () => {
		const s = buildSummaryFromWork(SAMPLE_WORK, '山田', url, 'https://summaly.example.com');
		expect(s.player.url).toBe('https://summaly.example.com/embed?url=https%3A%2F%2Fkakuyomu.jp%2Fworks%2F1177354054894377419');
		expect(s.player.width).toBe(3);
		expect(s.player.height).toBe(2);
	});

	test('embedBaseUrl 末尾スラッシュは除去', () => {
		const s = buildSummaryFromWork(SAMPLE_WORK, '山田', url, 'https://summaly.example.com/');
		expect(s.player.url).toBe('https://summaly.example.com/embed?url=https%3A%2F%2Fkakuyomu.jp%2Fworks%2F1177354054894377419');
	});

	test('ogImageUrl 不在時は SITE_LOGO にフォールバック', () => {
		const s = buildSummaryFromWork({ ...SAMPLE_WORK, ogImageUrl: null }, '山田', url, undefined);
		expect(s.thumbnail).toBe('https://kakuyomu.jp/images/brand/favicons/app-256.png');
	});
});

describe('composeEmbedHtml', () => {
	test('完全な HTML5 ドキュメント', () => {
		const html = composeEmbedHtml(SAMPLE_WORK, '山田');
		expect(html).toMatch(/^<!DOCTYPE html>/);
		expect(html).toContain('<html lang="ja">');
		expect(html).toContain('<body>');
		expect(html).toContain('</html>');
	});

	test('CSP 対応: <script> を含まない', () => {
		const html = composeEmbedHtml(SAMPLE_WORK, '山田');
		expect(html).not.toMatch(/<script[\s>]/i);
	});

	test('title / author / introduction / tag が含まれる', () => {
		const html = composeEmbedHtml(SAMPLE_WORK, '山田');
		expect(html).toContain('サンプル作品タイトル');
		expect(html).toContain('山田');
		expect(html).toContain('これはあらすじです');
		expect(html).toContain('恋愛, 異世界, 戦争, 中佐, じゃじゃ馬');
		// author の独立 div は撤廃 (meta 行先頭に統合)
		expect(html).not.toContain('class="author"');
	});

	test('meta 行は「作者 / 連載ステータス / ジャンル / 警告」順 1 行統合', () => {
		const html = composeEmbedHtml(SAMPLE_WORK, '山田');
		// SAMPLE_WORK: serialStatus=RUNNING, episodes=169, char=282850, genre=LOVE_STORY (恋愛), isCruel=true
		// → `作者: 山田 / 連載中 (169話 / 282,850文字) / 恋愛 / <span>[残酷描写]</span>`
		expect(html).toMatch(/<div class="meta">作者: 山田 \/ 連載中 \(169話 \/ 282,850文字\) \/ 恋愛 \/ <span class="markers">\[残酷描写\]<\/span><\/div>/);
		// flex pill デザイン (`<span>genre</span>` 個別) は撤廃
		expect(html).not.toMatch(/<span>恋愛<\/span>/);
	});

	test('連載ステータスに話数+文字数を内包 (読み応え情報を 1 単位に集約)', () => {
		const html = composeEmbedHtml(SAMPLE_WORK, '山田');
		expect(html).toContain('連載中 (169話 / 282,850文字)');
	});

	test('完結作品で「完結 (...)」表記', () => {
		const html = composeEmbedHtml({ ...SAMPLE_WORK, serialStatus: 'COMPLETED' }, '山田');
		expect(html).toContain('完結 (169話 / 282,850文字)');
		expect(html).not.toContain('連載中');
	});

	test('文字数が無い作品は status の括弧から省略', () => {
		const html = composeEmbedHtml({ ...SAMPLE_WORK, totalCharacterCount: null }, '山田');
		expect(html).toContain('連載中 (169話)');
		expect(html).not.toContain('文字)');
	});

	test('話数も文字数も無い作品は base ステータスのみ', () => {
		const html = composeEmbedHtml(
			{ ...SAMPLE_WORK, publicEpisodeCount: null, totalCharacterCount: null },
			'山田',
		);
		expect(html).toMatch(/\/ 連載中 \//);
		expect(html).not.toMatch(/連載中 \(/);
	});

	test('複数マーカー (残酷 + 性的 + 暴力) は span 内にスペース区切りで連結', () => {
		const html = composeEmbedHtml(
			{ ...SAMPLE_WORK, isCruel: true, isSexual: true, isViolent: true },
			'山田',
		);
		expect(html).toMatch(/<span class="markers">\[残酷描写\] \[性的描写\] \[暴力描写\]<\/span>/);
	});

	test('マーカー無しの作品は警告 span が省略される', () => {
		const html = composeEmbedHtml(
			{ ...SAMPLE_WORK, isCruel: false, isSexual: false, isViolent: false },
			'山田',
		);
		expect(html).not.toContain('<span class="markers">');
		expect(html).not.toContain('[残酷描写]');
	});

	test('CSS で警告 span を赤文字強調', () => {
		const html = composeEmbedHtml(SAMPLE_WORK, '山田');
		expect(html).toContain('.markers { color: #c33; }');
	});

	test('XSS: title に <script> を含めても escape される', () => {
		const html = composeEmbedHtml({ ...SAMPLE_WORK, title: '<script>alert(1)</script>' }, '山田');
		expect(html).not.toMatch(/<script>alert/);
		expect(html).toContain('&lt;script&gt;');
	});

	test('XSS: author 名に属性破壊攻撃を含めても escape される', () => {
		const html = composeEmbedHtml(SAMPLE_WORK, '" onmouseover="alert(1)');
		expect(html).not.toMatch(/" onmouseover="alert/);
		expect(html).toContain('&quot;');
	});

	test('XSS: introduction に onerror= を含む img タグも escape される (knowhow 推奨 3 ケース目)', () => {
		// docs/knowhow/embed-endpoint-design.md 推奨「<script> / 属性破壊 / onerror= の 3 ケース」の onerror 担保
		const html = composeEmbedHtml(
			{ ...SAMPLE_WORK, introduction: '<img src=x onerror="alert(1)">' },
			'山田',
		);
		expect(html).not.toMatch(/onerror="alert/);
		expect(html).toContain('&lt;img'); // < が entity 化されている
	});

	test('introduction が長い場合は 300 文字で clip', () => {
		const long = 'a'.repeat(500);
		const html = composeEmbedHtml({ ...SAMPLE_WORK, introduction: long }, '山田');
		// clip 300 文字 + 末尾 ellipsis 等を考慮しつつ 500 文字が完全には含まれないことを確認
		const occurrences = (html.match(/a/g) ?? []).length;
		expect(occurrences).toBeLessThan(500);
	});

	test('未知ジャンル enum でも壊れない (フォールバック)', () => {
		const html = composeEmbedHtml({ ...SAMPLE_WORK, genre: 'UNKNOWN_GENRE_2026' }, '山田');
		expect(html).toContain('その他');
	});

	test('author / title が null でも壊れない (フォールバック表示)', () => {
		const html = composeEmbedHtml({ ...SAMPLE_WORK, title: undefined }, null);
		expect(html).toContain('(タイトル不明)');
		expect(html).toContain('(作者不明)');
	});

	test('episode URL では各話タイトルが title 直下に「」付きで表示', () => {
		const html = composeEmbedHtml(SAMPLE_WORK, '山田', '序章');
		expect(html).toContain('<div class="episode-title">「序章」</div>');
		// title (作品名) の直後に episode-title が来ること
		const titleIdx = html.indexOf('<div class="title">');
		const epIdx = html.indexOf('<div class="episode-title">');
		const metaIdx = html.indexOf('<div class="meta">');
		expect(titleIdx).toBeGreaterThan(0);
		expect(epIdx).toBeGreaterThan(titleIdx);
		expect(metaIdx).toBeGreaterThan(epIdx);
	});

	test('episodeTitle 未指定 (work URL) では episode-title div を出さない', () => {
		const html = composeEmbedHtml(SAMPLE_WORK, '山田');
		expect(html).not.toContain('class="episode-title"');
	});

	test('episodeTitle が空文字でも episode-title div を出さない', () => {
		const html = composeEmbedHtml(SAMPLE_WORK, '山田', '');
		expect(html).not.toContain('class="episode-title"');
	});

	test('XSS: episodeTitle に <script> を含めても escape される', () => {
		const html = composeEmbedHtml(SAMPLE_WORK, '山田', '<script>alert(1)</script>');
		expect(html).not.toMatch(/<script>alert/);
		expect(html).toContain('&lt;script&gt;');
	});

	test('episodeBody が指定されたら story 部分を本文に置換 (introduction を使わない)', () => {
		const body = '後宮の下っ端宮女の雨妹は、今日も元気に掃除に勤しんでいる。\n「綺麗になるって気持ちいい～♪」';
		const html = composeEmbedHtml(SAMPLE_WORK, '山田', '序章', body);
		expect(html).toContain('後宮の下っ端宮女の雨妹');
		// introduction (作品全体のあらすじ) は使われない
		expect(html).not.toContain('これはあらすじです');
	});

	test('episodeBody 不在なら従来どおり introduction を表示', () => {
		const html = composeEmbedHtml(SAMPLE_WORK, '山田', '序章', null);
		expect(html).toContain('これはあらすじです');
	});

	test('XSS: episodeBody に <script> を含めても escape される', () => {
		const malicious = '<script>alert(1)</script>本文だ';
		const html = composeEmbedHtml(SAMPLE_WORK, '山田', '序章', malicious);
		expect(html).not.toMatch(/<script>alert/);
		expect(html).toContain('&lt;script&gt;');
	});
});
