/**
 * src/plugins/nitori.ts の単体テスト (phase15.4)。
 *
 * pure 関数 (test / extractSku / buildApiUrl / stripAndTruncate / buildSummaryFromApi) を中心に
 * ネットワーク非依存でカバーする。`summarize()` のフルフロー (curl_cffi 経由 API 取得) は
 * dev サーバ手動確認 / 本番運用ログに委ねる。
 */

import { describe, expect, test } from 'vitest';
import { StatusError } from '@/utils/status-error.js';
import type { CurlCffiFallbackConfig } from '@/utils/curl-cffi-fetch.js';
import {
	test as nitoriTest,
	extractSku,
	buildApiUrl,
	stripAndTruncate,
	buildSummaryFromApi,
	summarize,
	skipRedirectResolution,
} from '@/plugins/nitori.js';

describe('nitori test() (URL マッチ)', () => {
	test('商品 URL (末尾 /) にマッチ', () => {
		expect(nitoriTest(new URL('https://www.nitori-net.jp/ec/product/2116100013272s/'))).toBe(true);
	});
	test('商品 URL (末尾 / 無し) にマッチ', () => {
		expect(nitoriTest(new URL('https://www.nitori-net.jp/ec/product/2116100013272s'))).toBe(true);
	});
	test('www なし host にもマッチ', () => {
		expect(nitoriTest(new URL('https://nitori-net.jp/ec/product/2116100013272s/'))).toBe(true);
	});
	test('商品ページ以外のパスはマッチしない', () => {
		expect(nitoriTest(new URL('https://www.nitori-net.jp/'))).toBe(false);
		expect(nitoriTest(new URL('https://www.nitori-net.jp/ec/category/sofa/'))).toBe(false);
		expect(nitoriTest(new URL('https://www.nitori-net.jp/ec/product/2116100013272s/reviews'))).toBe(false);
	});
	test('別ホストはマッチしない', () => {
		expect(nitoriTest(new URL('https://www.nitori.com/'))).toBe(false);
		expect(nitoriTest(new URL('https://shop.nitori-net.jp/ec/product/abc/'))).toBe(false);
	});
});

describe('extractSku', () => {
	test('末尾 / 有り無しで同じ SKU を返す', () => {
		expect(extractSku('/ec/product/2116100013272s/')).toBe('2116100013272s');
		expect(extractSku('/ec/product/2116100013272s')).toBe('2116100013272s');
	});
	test('不正パスは null', () => {
		expect(extractSku('/')).toBe(null);
		expect(extractSku('/ec/category/sofa/')).toBe(null);
		expect(extractSku('/ec/product/')).toBe(null);
		expect(extractSku('/ec/product/abc/reviews')).toBe(null);
	});
});

describe('buildApiUrl', () => {
	test('SKU を OCC API URL に組み込む', () => {
		expect(buildApiUrl('2116100013272s')).toBe(
			'https://www.nitori-net.jp/occ/v2/nitorinet/nitori/products/2116100013272s?handleError=true&lang=ja&curr=JPY',
		);
	});
	test('特殊文字を含む SKU は encodeURIComponent される (defense-in-depth)', () => {
		const url = buildApiUrl('abc/def?x=1');
		expect(url).toContain('abc%2Fdef%3Fx%3D1');
	});
});

describe('stripAndTruncate', () => {
	test('<br> を改行に変換しつつ連続空白を 1 個に縮約', () => {
		expect(stripAndTruncate('foo<br>bar<br><br>baz')).toBe('foo bar baz');
	});
	test('<a> はリンクテキストだけ残す', () => {
		expect(stripAndTruncate("<a href='https://example.com'>link text</a>")).toBe('link text');
	});
	test('HTML エンティティをデコード', () => {
		expect(stripAndTruncate('&amp; &lt; &gt; &quot; &nbsp;a')).toBe('& < > " a');
	});
	test('HTML コメントを削除', () => {
		expect(stripAndTruncate('foo<!-- internal comment -->bar')).toBe('foobar');
	});
	test('300 文字超は切り詰め + 末尾省略記号', () => {
		const long = 'あ'.repeat(400);
		const out = stripAndTruncate(long);
		expect(out.length).toBe(301);
		expect(out.endsWith('…')).toBe(true);
	});
	test('300 文字以下はそのまま', () => {
		expect(stripAndTruncate('短い説明')).toBe('短い説明');
	});
	test('maxLen 引数で長さを上書き可能', () => {
		expect(stripAndTruncate('abcdefghij', 5)).toBe('abcde…');
	});
});

const SAMPLE_API_RESPONSE = {
	averageRating: 4.5,
	brand: {
		code: '001',
		imageUrl: 'https://www.nitori-net.jp/ecstatic/nitori/common/icon/logo/NITORI_LOGO_SQUARE_2.png',
		name: 'ニトリ',
	},
	categories: { name: '子供用抱き枕・ぬいぐるみ' },
	code: '2116100013272s',
	skuData: {
		name: 'Nクール ぬいぐるみ ニシキアナゴ L(BK26)',
		productDescription: '【ニトリの接触冷感(Nクール)】<br><br>■組成<br>側生地：ナイロン90%、ポリウレタン10%<br>充填物：ポリエステル100%<br><br>■手洗い<br><br>■対象年齢：3才以上<!-- レビューCPリンク開始 --><br><br><a href="https://www.nitori-net.jp/ec/characteristic/reviewcampaign202202/"><img src="..." alt="レビュー"></a><!-- レビューCPリンク終了 -->',
		mediasList: [
			{ type: 'image', url: 'https://www.nitori-net.jp/ecstatic/image/product/.../211610001327201.jpg' },
			{ type: 'image', url: 'https://www.nitori-net.jp/ecstatic/image/product/.../211610001327230.jpg' },
		],
		specifications: { color: 'その他', material: 'ナイロン　ポリウレタン' },
	},
};

describe('buildSummaryFromApi', () => {
	test('正常レスポンスから Summary を組み立てる', () => {
		const summary = buildSummaryFromApi(SAMPLE_API_RESPONSE);
		expect(summary.title).toBe('Nクール ぬいぐるみ ニシキアナゴ L(BK26)');
		expect(summary.sitename).toBe('ニトリ');
		expect(summary.icon).toBe('https://www.nitori-net.jp/ecstatic/nitori/common/icon/logo/NITORI_LOGO_SQUARE_2.png');
		expect(summary.thumbnail).toBe('https://www.nitori-net.jp/ecstatic/image/product/.../211610001327201.jpg');
		expect(summary.description).toContain('Nクール');
		expect(summary.description).toContain('側生地：ナイロン90%');
		expect(summary.description).not.toContain('<br>');
		expect(summary.description).not.toContain('<!--');
		expect(summary.sensitive).toBe(false);
		expect(summary.player.url).toBe(null);
	});

	test('mediasList に image type が無ければ thumbnail は icon フォールバック', () => {
		const body = {
			...SAMPLE_API_RESPONSE,
			skuData: { ...SAMPLE_API_RESPONSE.skuData, mediasList: [{ type: 'video', url: 'https://example.com/v.mp4' }] },
		};
		const summary = buildSummaryFromApi(body);
		expect(summary.thumbnail).toBe(summary.icon);
	});

	test('brand 欠如時は sitename がデフォルトになり icon は favicon フォールバック', () => {
		const body = { skuData: { name: 'X', mediasList: [] } };
		const summary = buildSummaryFromApi(body);
		expect(summary.sitename).toBe('ニトリネット');
		expect(summary.icon).toBe('https://www.nitori-net.jp/favicon.ico');
	});

	test('error.errorCode === INVALID_PRODUCT は StatusError(404) を throw (not_found 分類)', () => {
		const body = { error: { errorCode: 'INVALID_PRODUCT', errorDescription: '表示できる商品が見つかりませんでした' } };
		expect(() => buildSummaryFromApi(body)).toThrow(StatusError);
		try {
			buildSummaryFromApi(body);
		} catch (e) {
			expect(e).toBeInstanceOf(StatusError);
			if (e instanceof StatusError) {
				expect(e.statusCode).toBe(404);
				expect(e.message).toContain('INVALID_PRODUCT');
			}
		}
	});

	test('error.errorCode が INVALID_PRODUCT 以外なら通常 Error を throw (parse_error 分類で blocked candidate log に記録)', () => {
		const body = { error: { errorCode: 'SERVER_ERROR', errorDescription: 'temporary' } };
		expect(() => buildSummaryFromApi(body)).toThrow(/failed summarize: nitori API error: SERVER_ERROR/);
		// StatusError ではなく素の Error である (404 になっていない) ことを確認
		try {
			buildSummaryFromApi(body);
		} catch (e) {
			expect(e).not.toBeInstanceOf(StatusError);
			expect(e).toBeInstanceOf(Error);
		}
	});

	test('errorCode 欠如 (UNKNOWN) でも parse_error として throw', () => {
		const body = { error: { errorDescription: 'opaque' } };
		expect(() => buildSummaryFromApi(body)).toThrow(/UNKNOWN/);
	});

	test('skuData.name 欠如は Error を throw', () => {
		const body = { brand: { name: 'ニトリ' }, skuData: { mediasList: [] } };
		expect(() => buildSummaryFromApi(body)).toThrow(/missing skuData\.name/);
	});

	test('skuData 自体が無い場合も Error を throw', () => {
		const body = { brand: { name: 'ニトリ' } };
		expect(() => buildSummaryFromApi(body)).toThrow(/missing skuData\.name/);
	});

	test('null / 非オブジェクトは Error を throw', () => {
		expect(() => buildSummaryFromApi(null)).toThrow();
		expect(() => buildSummaryFromApi('string')).toThrow();
	});

	test('description が空文字なら null', () => {
		const body = {
			brand: { name: 'ニトリ' },
			skuData: { name: 'X', productDescription: '', mediasList: [] },
		};
		const summary = buildSummaryFromApi(body);
		expect(summary.description).toBe(null);
	});
});

describe('skipRedirectResolution', () => {
	test('true で export されている (HEAD probe スキップ宣言)', () => {
		expect(skipRedirectResolution).toBe(true);
	});
});

describe('summarize() の curl_cffi 設定検証 (silent fail を避ける)', () => {
	const sampleUrl = new URL('https://www.nitori-net.jp/ec/product/2116100013272s/');

	test('curlCffiFallback 未設定なら明示エラーを throw', async () => {
		await expect(summarize(sampleUrl, {})).rejects.toThrow(/requires curl_cffi fallback/);
	});

	test('curlCffiFallback.enabled = false なら明示エラーを throw', async () => {
		const cfg = {
			enabled: false,
			uvPath: 'uv',
			projectDir: '/tmp',
			impersonate: 'chrome120',
			timeoutMs: 30000,
		} satisfies CurlCffiFallbackConfig;
		await expect(summarize(sampleUrl, { curlCffiFallback: cfg })).rejects.toThrow(/requires curl_cffi fallback/);
	});

	// phase18.1: domains allowlist 撤廃に伴い「domains に nitori-net.jp が含まれていなければ throw」テストは廃止
	// (host 制約は plugin の test() で host match していることで担保)

	test('test() が false の URL では summarize は null を返す (extractSku 失敗パス)', async () => {
		// 念のため: extractSku 失敗 = 早期 return null。curl_cffi config が無くても throw しない
		const nonProductUrl = new URL('https://www.nitori-net.jp/ec/category/sofa/');
		await expect(summarize(nonProductUrl, {})).resolves.toBeNull();
	});
});
