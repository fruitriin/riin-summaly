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
	test('連載中 + 残酷描写 + 作者 + ジャンル + あらすじ', () => {
		const desc = composeDescription(SAMPLE_WORK, '山田太郎');
		expect(desc).toContain('作者: 山田太郎');
		expect(desc).toContain('異世界恋愛'); // LOVE_STORY → 異世界恋愛
		expect(desc).toContain('連載中 (169話)');
		expect(desc).toContain('[残酷描写]');
		expect(desc).toContain('あらすじ:');
	});

	test('完結作品', () => {
		const desc = composeDescription({ ...SAMPLE_WORK, serialStatus: 'COMPLETED' }, '山田');
		expect(desc).toContain('完結');
		expect(desc).not.toContain('連載中');
	});

	test('catchphrase が無ければ introduction が使われる', () => {
		const desc = composeDescription({ ...SAMPLE_WORK, catchphrase: null }, '山田');
		expect(desc).toContain('あらすじ');
		expect(desc).toContain('これはあらすじです');
	});

	test('catchphrase があれば優先される', () => {
		const desc = composeDescription(SAMPLE_WORK, '山田');
		expect(desc).toContain('結婚生活'); // catchphrase の冒頭
	});

	test('未知ジャンル enum は "その他" にフォールバック', () => {
		const desc = composeDescription({ ...SAMPLE_WORK, genre: 'UNKNOWN_GENRE_2026' }, '山田');
		expect(desc).toContain('その他');
	});

	test('author null でも壊れない', () => {
		const desc = composeDescription(SAMPLE_WORK, null);
		expect(desc).not.toContain('作者:');
	});

	test('複数マーカー (残酷 + 性的 + 暴力)', () => {
		const desc = composeDescription({ ...SAMPLE_WORK, isCruel: true, isSexual: true, isViolent: true }, '山田');
		expect(desc).toContain('[残酷描写]');
		expect(desc).toContain('[性的描写]');
		expect(desc).toContain('[暴力描写]');
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
});
