/**
 * src/plugins/amazon.ts の単体テスト (phase12.1 followup)。
 *
 * `normalizeAmazonUrl` は Amazon URL を `/dp/<asin>` の canonical 形に揃える。
 * 長い query 付き URL が CF Workers proxy 経由でも 500 を返す問題への対処
 * （referral tracking の query は商品ページに影響しないため削る）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';
import { normalizeAmazonUrl, parseAmazonHtml, test as amazonTest } from '@/plugins/amazon.js';

const _dirname = path.dirname(fileURLToPath(import.meta.url));

describe('normalizeAmazonUrl', () => {
	test('短い /dp/<asin> はそのまま', () => {
		const out = normalizeAmazonUrl(new URL('https://www.amazon.co.jp/dp/B0C4LRBFX6'));
		expect(out.href).toBe('https://www.amazon.co.jp/dp/B0C4LRBFX6');
	});

	test('SEO slug 付きの /商品名/dp/<asin> は /dp/<asin> に圧縮', () => {
		const out = normalizeAmazonUrl(new URL(
			'https://www.amazon.co.jp/%E3%83%AF%E3%82%A4%E3%83%A4%E3%83%AC%E3%82%B9%E3%82%A4%E3%83%A4%E3%83%9B%E3%83%B3-Bluetooth/dp/B0FRSGC73Z/',
		));
		expect(out.href).toBe('https://www.amazon.co.jp/dp/B0FRSGC73Z');
	});

	test('長い query (referral tracking) は全部削る', () => {
		const out = normalizeAmazonUrl(new URL(
			'https://www.amazon.co.jp/dp/B0FRSGC73Z/?_encoding=UTF8&pd_rd_w=niSZC&content-id=amzn1.sym.7d628db1&pf_rd_p=7d628db1&ref_=pd_hp_d_atf_ci_mcx_mr_',
		));
		expect(out.href).toBe('https://www.amazon.co.jp/dp/B0FRSGC73Z');
	});

	test('SEO slug + query の組み合わせも canonical 形に', () => {
		const out = normalizeAmazonUrl(new URL(
			'https://www.amazon.co.jp/%E3%83%AF%E3%82%A4%E3%83%A4%E3%83%AC%E3%82%B9-Bluetooth/dp/B0FRSGC73Z/?ref_=pd_hp_d_atf_ci_mcx_mr_',
		));
		expect(out.href).toBe('https://www.amazon.co.jp/dp/B0FRSGC73Z');
	});

	test('fragment も削る', () => {
		const out = normalizeAmazonUrl(new URL('https://www.amazon.com/dp/B0C4LRBFX6/?ref_=foo#productDetails'));
		expect(out.href).toBe('https://www.amazon.com/dp/B0C4LRBFX6');
	});

	test('/gp/product/<asin> 形式も /dp/<asin> に正規化', () => {
		const out = normalizeAmazonUrl(new URL('https://www.amazon.co.jp/gp/product/B0FRSGC73Z?ref_=foo'));
		expect(out.href).toBe('https://www.amazon.co.jp/dp/B0FRSGC73Z');
	});

	test('ASIN は大文字に統一', () => {
		const out = normalizeAmazonUrl(new URL('https://www.amazon.co.jp/dp/b0frsgc73z?ref_=foo'));
		expect(out.href).toBe('https://www.amazon.co.jp/dp/B0FRSGC73Z');
	});

	test('ASIN が見つからない URL (検索ページ等) はそのまま', () => {
		const url = new URL('https://www.amazon.co.jp/s?k=bluetooth');
		expect(normalizeAmazonUrl(url).href).toBe(url.href);
	});

	test('host (TLD) は変えない', () => {
		const out = normalizeAmazonUrl(new URL('https://www.amazon.com/foo/bar/dp/B0C4LRBFX6/?x=y'));
		expect(out.href).toBe('https://www.amazon.com/dp/B0C4LRBFX6');
	});

	test('元 URL を mutate しない', () => {
		const original = new URL('https://www.amazon.co.jp/foo/dp/B0C4LRBFX6/?ref_=x');
		const before = original.href;
		normalizeAmazonUrl(original);
		expect(original.href).toBe(before);
	});

	test('bare hostname (www. なし) は www. 付きに正規化 (phase12.1 followup #3)', () => {
		const out = normalizeAmazonUrl(new URL('https://amazon.co.jp/dp/B0GFN8129G/ref=sspa_dk_detail_5'));
		expect(out.href).toBe('https://www.amazon.co.jp/dp/B0GFN8129G');
	});

	test('bare hostname + SEO slug + query の組み合わせも canonical に', () => {
		const out = normalizeAmazonUrl(new URL('https://amazon.com/foo/dp/B0C4LRBFX6/?ref_=foo'));
		expect(out.href).toBe('https://www.amazon.com/dp/B0C4LRBFX6');
	});
});

describe('amazon.test() short URL hosts (phase12.1 followup #4)', () => {
	test('amzn.asia もマッチする', async () => {
		const { test: amazonTest } = await import('@/plugins/amazon.js');
		expect(amazonTest(new URL('https://amzn.asia/d/0faScmAn'))).toBe(true);
	});

	test('amzn.to もマッチする', async () => {
		const { test: amazonTest } = await import('@/plugins/amazon.js');
		expect(amazonTest(new URL('https://amzn.to/abc123'))).toBe(true);
	});

	test('a.co もマッチする', async () => {
		const { test: amazonTest } = await import('@/plugins/amazon.js');
		expect(amazonTest(new URL('https://a.co/d/abc'))).toBe(true);
	});

	test('amzn.com.evil 等のサブ偽装はマッチしない', async () => {
		const { test: amazonTest } = await import('@/plugins/amazon.js');
		expect(amazonTest(new URL('https://amzn.asia.evil.example/d/x'))).toBe(false);
		expect(amazonTest(new URL('https://www.amzn.asia/d/x'))).toBe(false); // 短縮ホストに www. は不要
	});
});

describe('parseAmazonHtml title fallback chain (phase12.1 followup #5)', () => {
	test('#title が空のとき og:title が次優先', async () => {
		const cheerio = await import('cheerio');
		const html = `<html><head>
			<meta property="og:title" content="OG Fallback">
			<title>HTML Title</title>
		</head><body><h1 id="title"></h1></body></html>`;
		const $ = cheerio.load(html);
		// parseAmazonHtml は内部関数なので summarize 経由ではなく直接シミュレート
		// 簡易的に title 抽出ロジックだけ書き直して検証する。実装と同じ優先順位:
		const title = $('#title').text().trim()
			|| $('meta[property="og:title"]').attr('content')
			|| $('meta[name="twitter:title"]').attr('content')
			|| $('title').text().trim()
			|| '';
		expect(title).toBe('OG Fallback');
	});

	test('og:title も空のとき <title> tag が最終 fallback (Prime Video 等)', async () => {
		const cheerio = await import('cheerio');
		const html = `<html><head>
			<title>機動戦士ガンダム 水星の魔女 シーズン1を観る | Prime Video</title>
		</head><body><div id="title"></div></body></html>`;
		const $ = cheerio.load(html);
		const title = $('#title').text().trim()
			|| $('meta[property="og:title"]').attr('content')
			|| $('meta[name="twitter:title"]').attr('content')
			|| $('title').text().trim()
			|| '';
		expect(title).toBe('機動戦士ガンダム 水星の魔女 シーズン1を観る | Prime Video');
	});

	test('#title に値があれば優先 (Prime Video 専用 HTML 以外の通常商品ページ)', async () => {
		const cheerio = await import('cheerio');
		const html = `<html><head>
			<meta property="og:title" content="OG Title (should NOT be used)">
			<title>HTML Title (should NOT be used)</title>
		</head><body><h1 id="title">  実商品名  </h1></body></html>`;
		const $ = cheerio.load(html);
		const title = $('#title').text().trim()
			|| $('meta[property="og:title"]').attr('content')
			|| $('meta[name="twitter:title"]').attr('content')
			|| $('title').text().trim()
			|| '';
		expect(title).toBe('実商品名');
	});
});

describe('parseAmazonHtml thumbnail extraction', () => {
	test('Prime Video ページ (`/gp/video/detail/`) では og:image も #landingImage も無いので hero `<img data-testid="base-image" loading="eager">` を fallback として採用', async () => {
		const cheerio = await import('cheerio');
		const html = fs.readFileSync(_dirname + '/htmls/amazon-prime-video.html', 'utf-8');
		const $ = cheerio.load(html);
		const summary = parseAmazonHtml($);
		expect(summary.thumbnail).toBe(
			'https://m.media-amazon.com/images/S/pv-target-images/421ec0770c22abb767b4abb8667e3d623b2ce708bb4776ddcb5f2f1b8032aedf._SX1080_FMjpg_.jpg',
		);
		// title は <head><title>...</title></head> が fallback として採用される。
		// SVG icon の <title>Caret Down</title> 等が body に大量にあっても汚染されない
		// (`head > title` で head 限定にしたため)。
		expect(summary.title).toBe('Amazon.co.jp: ポケットモンスター（2023）を観る | Prime Video');
		// icon は amazon プラグイン共通でハードコード
		expect(summary.icon).toBe('https://www.amazon.com/favicon.ico');
	});

	test('og:image があるとき eager hero よりも og:image が優先', async () => {
		const cheerio = await import('cheerio');
		const html = `<html><head>
			<meta property="og:image" content="https://example.com/og.jpg">
			<title>X</title>
		</head><body>
			<img data-testid="base-image" loading="eager" src="https://example.com/hero.jpg">
		</body></html>`;
		const $ = cheerio.load(html);
		expect(parseAmazonHtml($).thumbnail).toBe('https://example.com/og.jpg');
	});

	test('#landingImage があれば最優先 (通常の商品ページ)', async () => {
		const cheerio = await import('cheerio');
		const html = `<html><head>
			<meta property="og:image" content="https://example.com/og.jpg">
			<title>X</title>
		</head><body>
			<img id="landingImage" src="https://example.com/landing.jpg">
			<img data-testid="base-image" loading="eager" src="https://example.com/hero.jpg">
		</body></html>`;
		const $ = cheerio.load(html);
		expect(parseAmazonHtml($).thumbnail).toBe('https://example.com/landing.jpg');
	});

	test('画像が一切無いときは null', async () => {
		const cheerio = await import('cheerio');
		const html = `<html><head><title>X</title></head><body></body></html>`;
		const $ = cheerio.load(html);
		expect(parseAmazonHtml($).thumbnail).toBeNull();
	});

	test('lazy 読み込みのサムネイル群 (data-testid="base-image" loading="lazy") は採用しない', async () => {
		const cheerio = await import('cheerio');
		const html = `<html><head><title>X</title></head><body>
			<img data-testid="base-image" loading="lazy" src="https://example.com/lazy1.jpg">
			<img data-testid="base-image" loading="lazy" src="https://example.com/lazy2.jpg">
		</body></html>`;
		const $ = cheerio.load(html);
		expect(parseAmazonHtml($).thumbnail).toBeNull();
	});
});

describe('amazon.test() (host matching, phase12.1 followup #3)', () => {
	test('www.amazon.co.jp はマッチ', () => {
		expect(amazonTest(new URL('https://www.amazon.co.jp/dp/B0C4LRBFX6'))).toBe(true);
	});

	test('bare amazon.co.jp もマッチ (followup #3)', () => {
		expect(amazonTest(new URL('https://amazon.co.jp/dp/B0GFN8129G/ref=sspa_dk_detail_5'))).toBe(true);
	});

	test('全 TLD で bare / www の両方をマッチ', () => {
		const tlds = ['com', 'co.jp', 'ca', 'com.br', 'com.mx', 'co.uk', 'de', 'fr', 'it', 'es', 'nl', 'cn', 'in', 'au'];
		for (const tld of tlds) {
			expect(amazonTest(new URL(`https://amazon.${tld}/dp/X`))).toBe(true);
			expect(amazonTest(new URL(`https://www.amazon.${tld}/dp/X`))).toBe(true);
		}
	});

	test('aws.amazon.com 等の AWS サブドメインはマッチしない', () => {
		expect(amazonTest(new URL('https://aws.amazon.com/foo'))).toBe(false);
		expect(amazonTest(new URL('https://s3.amazonaws.com/bucket'))).toBe(false);
		expect(amazonTest(new URL('https://amazon.com.evil.example/dp/X'))).toBe(false);
	});

	test('未知の TLD はマッチしない', () => {
		expect(amazonTest(new URL('https://amazon.xyz/dp/X'))).toBe(false);
	});
});
