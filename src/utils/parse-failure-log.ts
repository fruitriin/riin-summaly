/**
 * Fastify モードのパース失敗ログ集約 (phase10.1)。
 *
 * - `summaly()` が throw した場合 → `reason: 'throw'`
 * - 結果が「汎用パスでスカスカ」（`description == null && thumbnail == null && player.url == null`、
 *   かつ title が hostname / 空 / null）→ `reason: 'thin'`
 *
 * `${hostname}/${パスの先頭1〜2セグメント}` を group key にして、グループごとに直近 N サンプルを
 * ring buffer 風に保持する。同じ URL の重複追加は抑制する。グループ数全体にも上限を設けて
 * メモリ爆発を防ぐ。
 *
 * 「プラグイン化候補のドメイン発見器」が主目的のため精度より運用シンプルさ優先。
 */

import type { SummalyResult } from '@/index.js';

export type ParseFailureReason = 'throw' | 'thin';

export interface ParseFailureSample {
	/** プライバシー保護のため query / fragment を捨てた `${origin}${pathname}` */
	url: string;
	/** Date.now() */
	ts: number;
	reason: ParseFailureReason;
	/** `reason === 'throw'` のときのみ。Error.message を 200 文字に切り詰め */
	errorMessage?: string;
}

export interface ParseFailureLogEntry {
	key: string;
	samples: ParseFailureSample[];
}

const ERROR_MESSAGE_MAX_LENGTH = 200;

/**
 * 集約 key を生成する。
 *
 * - `qiita.com/UserA/items/abc?token=...` → `qiita.com/UserA/items`
 * - `note.com/foo/n/abc` → `note.com/foo/n`
 * - `example.com/` → `example.com/`
 * - 不正 URL → `_invalid`
 */
export function groupKeyOf(url: string): string {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return '_invalid';
	}
	const segs = u.pathname.split('/').filter(Boolean).slice(0, 2);
	return segs.length > 0 ? `${u.hostname}/${segs.join('/')}` : `${u.hostname}/`;
}

/**
 * サンプルに保存する `url` を生成する。`${origin}${pathname}` のみ残し、query / fragment / auth 情報を捨てる。
 *
 * `data:` / `file:` 等の非 http(s) スキームは URL.origin が `"null"` を返すため
 * `"nulltext/html,..."` のようなガベージ文字列がログに混入するのを防ぐ。
 * 不正 URL は元の文字列をそのまま返す（記録経路を止めないため）。
 */
export function sanitizeUrlForLog(url: string): string {
	try {
		const u = new URL(url);
		if (u.protocol !== 'https:' && u.protocol !== 'http:') {
			return `${u.protocol}[sanitized]`;
		}
		return `${u.origin}${u.pathname}`;
	} catch {
		return url;
	}
}

/**
 * Summary が「汎用パスで取れたスカスカ」かを判定する。
 *
 * - description / thumbnail / player.url のいずれかがあれば false（汎用パスでも何かは取れている）
 * - title が null / 空文字 / hostname と一致 → 「実質取れていない」とみなして true
 *
 * プラグインがマッチして取得した結果（title が `<user> on X` 等）は false 判定になる。
 * 完璧な判定ではないが、プラグイン化候補を取りこぼすよりノイズが少し増える方を許容する設計。
 */
export function isThinSummary(summary: SummalyResult): boolean {
	if (summary.description != null && summary.description !== '') return false;
	if (summary.thumbnail != null) return false;
	if (summary.player.url != null) return false;
	// medias[] が乗っていれば（複数画像対応プラグイン由来）コンテンツは取れているので thin ではない
	if (summary.medias != null && summary.medias.length > 0) return false;
	if (summary.title == null || summary.title === '') return true;
	let host = '';
	try { host = new URL(summary.url).hostname; } catch { return true; }
	return summary.title === host;
}

/**
 * 「絶対失敗する類型」を判定する。プラグインを書いても救えないため、ログに記録するとノイズになる。
 *
 * skip 条件:
 * - HTTP 4xx / 5xx ステータス（broken link / origin 障害 / Akamai/Cloudflare の bot block など）
 * - SSRF ガードによるプライベート IP 拒否
 * - 非 HTML レスポンス（type filter で reject、PDF や画像など）
 * - タイムアウト / abort（一時的な遅延）
 *
 * これらは「プラグインを書けば preview が綺麗になる候補」ではないため、`thin` 経路の純度を上げるために除外する。
 */
export function isFilteredFailure(reason: ParseFailureReason, errorMessage?: string, errorName?: string): boolean {
	if (reason !== 'throw') return false;

	if (errorName === 'StatusError') return true;
	if (errorName === 'TimeoutError' || errorName === 'AbortError') return true;
	if (errorName === 'CancelError') return true;

	if (errorMessage != null) {
		// got が SUMMALY_BOT で踏む CDN bot block 等。`Response code 4xx/5xx` 形式
		if (/^\s*\d{3}\s/.test(errorMessage)) {
			const code = Number(errorMessage.match(/^\s*(\d{3})/)?.[1]);
			if (Number.isFinite(code) && code >= 400) return true;
		}
		if (/Private IP rejected/i.test(errorMessage)) return true;
		if (/Rejected by type filter/i.test(errorMessage)) return true;
		if (/timeout|timed out|aborted/i.test(errorMessage)) return true;
		// got `RequestError` などの低レベルネットワーク到達不能エラー
		// （ドメイン消失 / サーバ落ち）— プラグインを書いても救えない
		if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN/i.test(errorMessage)) {
			return true;
		}
	}
	return false;
}

export interface ParseFailureLogConfig {
	maxGroups: number;
	samplesPerGroup: number;
}

/**
 * 集約ログ store。Fastify プラグインスコープ singleton として保持される想定。
 */
export class ParseFailureLog {
	readonly maxGroups: number;
	readonly samplesPerGroup: number;
	private readonly map: Map<string, ParseFailureSample[]> = new Map();

	constructor(config: ParseFailureLogConfig) {
		if (!Number.isInteger(config.maxGroups) || config.maxGroups < 1) {
			throw new RangeError(`parseFailureLog.maxGroups must be a positive integer, got ${config.maxGroups}`);
		}
		if (!Number.isInteger(config.samplesPerGroup) || config.samplesPerGroup < 1) {
			throw new RangeError(`parseFailureLog.samplesPerGroup must be a positive integer, got ${config.samplesPerGroup}`);
		}
		this.maxGroups = config.maxGroups;
		this.samplesPerGroup = config.samplesPerGroup;
	}

	/**
	 * パース失敗を記録する。
	 *
	 * **同期関数**: Node.js の event loop 上で原子的に完了することを前提にしている。
	 * Fastify の async ハンドラから複数の record が並行に呼ばれても Map の中間状態は競合しない。
	 * 将来 await を含む変更を加える場合は呼び出し側との競合を再検討すること。
	 */
	record(rawUrl: string, reason: ParseFailureReason, errorMessage?: string): void {
		const sanitized = sanitizeUrlForLog(rawUrl);
		const key = groupKeyOf(sanitized);

		const existing = this.map.get(key) ?? [];
		// 同 URL の重複追加抑制 — 連打されても 1 件しか残らない
		const filtered = existing.filter(s => s.url !== sanitized);
		const sample: ParseFailureSample = {
			url: sanitized,
			ts: Date.now(),
			reason,
			...(errorMessage != null
				? { errorMessage: errorMessage.slice(0, ERROR_MESSAGE_MAX_LENGTH) }
				: {}),
		};
		filtered.unshift(sample);
		if (filtered.length > this.samplesPerGroup) {
			filtered.length = this.samplesPerGroup;
		}

		// Map の挿入順を最新化するため、いったん delete して set（LRU 風）
		this.map.delete(key);
		this.map.set(key, filtered);

		// グループ数上限を超えたら最も古いキーから捨てる
		while (this.map.size > this.maxGroups) {
			const oldest = this.map.keys().next().value;
			if (oldest === undefined) break;
			this.map.delete(oldest);
		}
	}

	/** 全エントリを ts 降順（直近順）で返す */
	snapshot(): ParseFailureLogEntry[] {
		return Array.from(this.map.entries())
			.map(([key, samples]) => ({ key, samples }))
			.sort((a, b) => (b.samples[0]?.ts ?? 0) - (a.samples[0]?.ts ?? 0));
	}

	get size(): number {
		return this.map.size;
	}

	clear(): void {
		this.map.clear();
	}
}
