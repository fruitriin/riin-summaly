/**
 * src/plugins/amazon.ts の単体テスト (phase12.1 followup)。
 *
 * `normalizeAmazonUrl` は Amazon URL を `/dp/<asin>` の canonical 形に揃える。
 * 長い query 付き URL が CF Workers proxy 経由でも 500 を返す問題への対処
 * （referral tracking の query は商品ページに影響しないため削る）。
 */

import { describe, expect, test } from 'vitest';
import { normalizeAmazonUrl } from '@/plugins/amazon.js';

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
});
