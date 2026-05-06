import type Summary from '@/summary.js';
import type { GeneralScrapingOptions } from '@/general.js';

export interface SummalyPlugin {
	/**
	 * プラグイン名。allowedPlugins 等のキーやキャッシュキー用に利用する。
	 * 組み込みプラグインではファイル名（拡張子なし）と一致させる。
	 * 既存外部プラグインの破壊的変更を避けるため optional。
	 */
	name?: string;
	test: (url: URL) => boolean;
	summarize: (url: URL, opts?: GeneralScrapingOptions) => Promise<Summary | null>;
	/**
	 * **`summaly()` の初期 `resolveRedirect` (HEAD/GET probe) をスキップさせる宣言** (phase12.5)。
	 *
	 * `true` を宣言すると、URL が初期段階で本プラグインの `test()` にマッチした場合に限り、
	 * `summaly()` 冒頭の HEAD/GET によるリダイレクト解決を **完全にスキップ**する。
	 *
	 * **用途**: yodobashi のように **TLS layer で bot を切断するサイト** + **URL が終端確定**
	 * (短縮 URL でない / リダイレクト不要) のケースで、HEAD/GET probe が timeout
	 * (デフォルト 20 秒) で空回りする純損失を回避する。
	 *
	 * **注意**: 短縮 URL を扱うプラグイン (`branchio-deeplinks` 等) や、`amzn.asia` のような
	 * 短縮形を含む URL を受けるプラグイン (amazon) では絶対に有効化しないこと。
	 * 終端 URL でないとプラグインが正しく動かない。
	 */
	skipRedirectResolution?: boolean;
}
