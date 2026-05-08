/**
 * Fastify モードのエラー観測ログ用レベル判定。
 *
 * `categorizeError` の結果からログレベルを派生させる：
 *
 * - **info**: upstream 4xx（普通のことなので運用上は priority filter で除外可）
 *   - `not_found` / `bot_blocked`
 * - **warn**: upstream 5xx・timeout・SSRF block・型 reject・サイズ超過・低レベルネットワーク（運用者が気にすべき）
 *   - `origin_error` / `timeout` / `unsupported_type` / `content_too_large` / `ssrf_blocked` / `network_error` / `connection_dropped`
 * - **error**: 想定外（プラグインのバグ・cheerio 失敗・catch-all）
 *   - `parse_error` / `unknown`
 *
 * journalctl 等で `--priority=warning` で運用上注視すべき分だけ拾える設計。
 */

import { StatusError } from '@/utils/status-error.js';
import { categorizeError, type SummalyErrorCategory } from '@/utils/parse-failure-log.js';

export type LogLevel = 'info' | 'warn' | 'error';

const LOG_LEVEL_BY_CATEGORY: Record<SummalyErrorCategory, LogLevel> = {
	not_found: 'info',
	bot_blocked: 'info',
	origin_error: 'warn',
	timeout: 'warn',
	unsupported_type: 'warn',
	content_too_large: 'warn',
	ssrf_blocked: 'warn',
	network_error: 'warn',
	connection_dropped: 'warn',
	parse_error: 'error',
	unknown: 'error',
};

/**
 * 与えられたエラーから pino のログレベルを決定する。
 * `categorizeError` の結果でルックアップする派生実装なので、カテゴリと level の整合性は
 * `LOG_LEVEL_BY_CATEGORY` テーブル 1 箇所で保たれる。
 */
export function chooseLogLevel(e: unknown): LogLevel {
	const message = e instanceof Error ? e.message : (typeof e === 'string' ? e : undefined);
	const name = e instanceof Error ? e.name : undefined;
	const statusCode = e instanceof StatusError ? e.statusCode : undefined;
	const category = categorizeError(message, name, statusCode);
	return LOG_LEVEL_BY_CATEGORY[category];
}
