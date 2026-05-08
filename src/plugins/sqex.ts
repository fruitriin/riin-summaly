import type Summary from '@/summary.js';
import { parseGeneral, type GeneralScrapingOptions } from '@/general.js';
import { scpaping } from '@/utils/got.js';

export const name = 'sqex';

/**
 * Square Enix e-STORE (`store.jp.square-enix.com`) のプラグイン。
 *
 * SQEX e-STORE は **データセンター IP レンジ全般を CDN 段で広く弾く**: Vultr Tokyo IP からは
 * `HTTP/200 + text/html;charset=utf-8 + 正規 404 ページボディ` で返ってくるため、`got` レイヤでは
 * 何のエラーも発生せず、エラー発火型の救援機構 (proxy fallback の検出条件) では救えない
 * (skill `/url-preview-check` Phase 3 fail mode の新パターン: HTTP 200 + 404 ページボディ)。
 *
 * ローカル MacOS や CF Workers から取得すれば 200 + 完璧な OGP (`og:title` / `og:description` /
 * `og:image` / `og:site_name`) が返ってくるため、**最初から proxy 経由で取りに行けば救援できる**。
 *
 * 経路学習キャッシュの bootstrap (`data/domain-strategy-bootstrap.jsonl` の
 * `store.jp.square-enix.com → proxy`) により、Fastify モードでは `scpaping()` 冒頭の cache hit
 * fast path で proxy が直接呼ばれる。本プラグインは特殊な経路強制を一切行わず通常の cascade
 * に乗る。
 *
 * 短縮 URL `sqex.to/<id>` は HEAD で `store.jp.square-enix.com/...` に正常解決できるため、
 * `summaly()` 冒頭の resolveRedirect 段で展開された後にこのプラグインがマッチする。
 *
 * **運用要件 (Fastify モード前提)**:
 * - `[scraping.strategy_cache]` で `enabled = true` (デフォルト) — bootstrap fast path が動くために必須
 * - `[scraping.proxy]` で `enabled = true` + `domains` に `store.jp.square-enix.com` を含む
 * - CF Worker (`tools/cf-proxy-worker/wrangler.toml`) の `ALLOWED_DOMAINS` にも同 host
 *
 * **strategy_cache 無効環境のデグレ警告**: 上記要件を満たさない場合 (strategy_cache 無効、または
 * bootstrap が連続失敗で破棄された後、または proxy が未設定)、cache fast path が発火しないため
 * 通常 cascade に乗り、HTTP 200 + 正規 404 ページボディを取得して isThinSummary 判定で thin →
 * 失敗と扱われる (破壊的ではない)。本プラグインは Fastify モード + strategy_cache 有効 + proxy
 * 設定済を前提としており、library 直接利用や proxy 未設定環境では期待通りに動かない。
 */
const SQEX_HOST = /^(?:www\.)?store\.jp\.square-enix\.com$/;

export function test(url: URL): boolean {
	return SQEX_HOST.test(url.hostname);
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const res = await scpaping(url.href, opts);
	return await parseGeneral(url, res);
}
