import type Summary from '@/summary.js';
import { parseGeneral, type GeneralScrapingOptions } from '@/general.js';
import { scpaping } from '@/utils/got.js';

export const name = 'yodobashi';

/**
 * ヨドバシカメラオンラインショップ (`www.yodobashi.com` / `yodobashi.com`) のプラグイン
 * (phase12.4 で proxy 拡張で導入 → phase12.5 で curl_cffi 直行に切替 → phase14 Step 4 で
 * 経路学習キャッシュ + bootstrap に統合)。
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
 * **phase14 Step 4 での簡素化**: 以前は `forceCurlCffiFallback: true` + `proxyFallback: undefined`
 * で「1〜3段目を強制スキップして curl_cffi 直行」していたが、phase14 Step 3 で同梱した
 * `data/domain-strategy-bootstrap.jsonl` に `yodobashi.com → curl_cffi` の bootstrap エントリが
 * 入ったため、Fastify モードで cache 有効なら `scpaping()` 冒頭の cache hit fast path で
 * 直接 curl_cffi が呼ばれる。本プラグインは特殊な経路強制を一切行わず通常の cascade に乗る。
 *
 * **本プラグインを残す意味** (I-1 review feedback):
 * - `test()` で URL pattern を判定してプラグインとして優先マッチ
 * - `skipRedirectResolution = true` で HEAD probe をスキップ (TLS 切断する HEAD の空回り回避)
 * これら 2 点は cache / bootstrap で代替できない独立した価値。
 *
 * **運用要件 (Fastify モード前提)**:
 * - `[scraping.strategy_cache]` で `enabled = true` (デフォルト) — bootstrap fast path が動くために必須
 * - `[scraping.curl_cffi]` で `enabled = true` + `domains = ["yodobashi.com"]`
 * - production server に `uv` をインストール + `cd tools/curl-cffi-fetcher && uv sync`
 *
 * **strategy_cache 無効環境のデグレ警告 (W-2 review feedback)**: 上記要件を満たさない場合
 * (cache 無効、または bootstrap が連続失敗で破棄された後)、cache miss → 通常 4 段カスケードに乗り、
 * 1段目 (default UA) で `Timeout awaiting 'socket'` 20 秒を待つ純損失が復活する。本プラグインは
 * Fastify モード + strategy_cache 有効を前提としており、library 直接利用やカスタム build では
 * 期待する性能が出ない (機能的には fallback が動くため失敗はしないが遅い)。
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
 *
 * **注**: HEAD probe スキップは経路学習キャッシュとは独立した最適化なので phase14 Step 4 でも維持する
 * (TLS 切断する HEAD のスキップは bootstrap で代替不可)。
 */
export const skipRedirectResolution = true;

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const res = await scpaping(url.href, opts);
	return await parseGeneral(url, res);
}
