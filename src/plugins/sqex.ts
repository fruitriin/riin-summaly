import type Summary from '@/summary.js';
import { parseGeneral, type GeneralScrapingOptions } from '@/general.js';
import { scpaping } from '@/utils/got.js';

export const name = 'sqex';

/**
 * Square Enix e-STORE (`store.jp.square-enix.com`) のプラグイン (phase12.6)。
 *
 * SQEX e-STORE は **データセンター IP レンジ全般を CDN 段で広く弾く**: Vultr Tokyo IP からは
 * `HTTP/200 + text/html;charset=utf-8 + 正規 404 ページボディ` で返ってくるため、`got` レイヤでは
 * 何のエラーも発生せず、phase12.1 の `getResponseWithProxyFallback` のエラー発火型では救援できない
 * (skill `/url-preview-check` Phase 3 fail mode の新パターン: HTTP 200 + 404 ページボディ)。
 *
 * ローカル MacOS や CF Workers から取得すれば 200 + 完璧な OGP (`og:title` / `og:description` /
 * `og:image` / `og:site_name`) が返ってくるため、**最初から proxy 経由で取りに行けば救援できる**。
 *
 * このプラグインは `forceProxyFallback: true` を `scpaping` に渡し、phase12.6 で追加した
 * 「1〜2段目をスキップして CF Workers proxy 直行」経路を使う (`forceCurlCffiFallback` と並列構造)。
 *
 * 短縮 URL `sqex.to/<id>` は HEAD で `store.jp.square-enix.com/...` に正常解決できるため、
 * `summaly()` 冒頭の resolveRedirect 段で展開された後にこのプラグインがマッチする。
 *
 * **運用要件**:
 * - `[scraping.proxy]` で `enabled = true` + `domains` に `store.jp.square-enix.com` を含む
 * - CF Worker (`tools/cf-proxy-worker/wrangler.toml`) の `ALLOWED_DOMAINS` にも同 host
 * - proxy が未設定な環境では通常の段階的フォールバックに戻る (= 404 ページが返る、ただし破壊的ではない)
 */
const SQEX_HOST = /^(?:www\.)?store\.jp\.square-enix\.com$/;

export function test(url: URL): boolean {
	return SQEX_HOST.test(url.hostname);
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const res = await scpaping(url.href, {
		...opts,
		forceProxyFallback: true,
	});
	return await parseGeneral(url, res);
}
