import type Summary from '@/summary.js';
import { parseGeneral, type GeneralScrapingOptions } from '@/general.js';
import { scpaping } from '@/utils/got.js';

export const name = 'yodobashi';

/**
 * ヨドバシカメラオンラインショップ (`www.yodobashi.com` / `yodobashi.com`) のプラグイン (phase12.4)。
 *
 * yodobashi は **TLS / HTTP/2 レイヤーで能動的に bot を切断**する。Vultr Tokyo IP からは
 * `category: "timeout"` (`Timeout awaiting 'socket'`)、ローカル MacOS からは `HTTP/2 stream
 * INTERNAL_ERROR` (即時切断、time<0.05s) で同様に失敗する。SummalyBot / ブラウザ UA / 各種
 * SNS bot UA すべてで弾かれるため UA レイヤーでは救えない (skill `/url-preview-check` の
 * Phase 3 fail mode H 「HTTP/2 INTERNAL_ERROR」)。
 *
 * **しかし yodobashi は OGP を整備しており share link 機能も提供**しているため、SNS で share
 * されたい意思はある。CF Workers の egress IP / TLS フィンガープリントなら通る可能性が高い。
 * このプラグインは proxy fallback の `categories` に `timeout` / `connection_dropped` を
 * **強制追加** して、デフォルトでは発火しない timeout カテゴリでも yodobashi だけは proxy 経由で
 * リトライさせる設計。
 *
 * **運用要件**: Worker 側 `wrangler.toml` の `ALLOWED_DOMAINS` と summaly 側
 * `[scraping.proxy].domains` の両方に `yodobashi.com` を追加した上で `wrangler deploy` 必須。
 * Worker 経由でも CF egress IP から弾かれる場合は 502 が返り、proxy 救援は失敗する
 * (その場合 Misskey 側で薄い preview を許容)。
 */
const YODOBASHI_HOST = /^(?:www\.)?yodobashi\.com$/;

export function test(url: URL): boolean {
	return YODOBASHI_HOST.test(url.hostname);
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	// proxy fallback の categories を拡張: 通常デフォルトの ['origin_error', 'bot_blocked'] では
	// 救えない `timeout` / `connection_dropped` も yodobashi では発火対象に含める。
	// proxyFallback 自体が未設定 (= 機能無効) なら何もしない (通常の scpaping にフォールスルー)。
	const proxyOverride = opts?.proxyFallback != null
		? {
			...opts.proxyFallback,
			categories: ['origin_error', 'bot_blocked', 'timeout', 'connection_dropped'] satisfies import('@/utils/parse-failure-log.js').SummalyErrorCategory[],
		}
		: undefined;

	const res = await scpaping(url.href, {
		...opts,
		proxyFallback: proxyOverride,
	});
	return await parseGeneral(url, res);
}
