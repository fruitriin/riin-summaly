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
}
