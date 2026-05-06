import type Summary from '@/summary.js';
import { parseGeneral, type GeneralScrapingOptions } from '@/general.js';
import { scpaping } from '@/utils/got.js';

export const name = 'yodobashi';

/**
 * ヨドバシカメラオンラインショップ (`www.yodobashi.com` / `yodobashi.com`) のプラグイン
 * (phase12.4 で proxy 拡張で導入 → phase12.5 で curl_cffi 直行に切替)。
 *
 * yodobashi は **TLS / HTTP/2 レイヤーで能動的に bot を切断**する。Vultr Tokyo IP からは
 * `category: "timeout"` (`Timeout awaiting 'socket'`)、ローカル MacOS からは `HTTP/2 stream
 * INTERNAL_ERROR` (即時切断、time<0.05s) で同様に失敗する。SummalyBot / ブラウザ UA / 各種
 * SNS bot UA すべてで弾かれるため UA レイヤーでは救えない (skill `/url-preview-check` の
 * Phase 3 fail mode H 「HTTP/2 INTERNAL_ERROR」)。
 *
 * **CF Workers proxy も TLS フィンガープリントが固定なので構造的に救えない** (本番実証で
 * proxy 段が ~15-20 秒空回りして失敗、結果として 4 段目の curl_cffi で救援していた)。
 * 唯一の正解経路は **`curl_cffi` (libcurl-impersonate) で Chrome TLS フィンガープリントを偽装**
 * すること (phase12.5)。
 *
 * このプラグインは:
 * - **proxy fallback 段を強制スキップ** して 15-20 秒の純損失を回避
 * - curl_cffi fallback は opts 透過で受ける (デフォルトカテゴリ
 *   `['timeout', 'connection_dropped', 'bot_blocked']` で yodobashi の TLS 切断をカバー)
 *
 * **運用要件**: production server に `uv` をインストール + `cd tools/curl-cffi-fetcher && uv sync`、
 * config.toml の `[scraping.curl_cffi]` で `enabled = true` + `domains = ["yodobashi.com"]`。
 * curl_cffi が未設定なら通常 scpaping にフォールスルー (= 失敗するが破壊的ではない)。
 */
const YODOBASHI_HOST = /^(?:www\.)?yodobashi\.com$/;

export function test(url: URL): boolean {
	return YODOBASHI_HOST.test(url.hostname);
}

/**
 * yodobashi は **URL が終端確定** (短縮 URL でない、商品 URL は `/product/<id>/` の固定形) なので
 * `summaly()` 冒頭の `resolveRedirect` (HEAD/GET probe) は不要。さらに HEAD も TLS layer で
 * 切断されるため、デフォルト挙動だと HEAD probe が timeout (20 秒) まで空回りする純損失が発生する。
 *
 * `skipRedirectResolution = true` を宣言することで `summaly()` がこのプラグインにマッチした URL に
 * 対して resolveRedirect 段を完全にスキップする。本番実測で 21 秒 → 1〜3 秒に短縮見込み。
 */
export const skipRedirectResolution = true;

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	// **1段目 (default UA) も yodobashi では socket timeout 20 秒で空回り**するため、
	// `forceCurlCffiFallback: true` で 1〜3段目をすべてスキップして curl_cffi 直行する
	// (phase12.5 followup #3)。proxy 段スキップ + skipRedirectResolution と合わせて、
	// 「yodobashi に対する無駄な got リクエスト」を完全にゼロにする。
	//
	// curl_cffi が未設定の環境では scpaping が通常段階に fallthrough する (互換性維持)。
	const res = await scpaping(url.href, {
		...opts,
		proxyFallback: undefined,
		forceCurlCffiFallback: true,
	});
	return await parseGeneral(url, res);
}
