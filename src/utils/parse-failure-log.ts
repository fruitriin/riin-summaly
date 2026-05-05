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

import { appendFileSync, statSync } from 'node:fs';
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
 * - description があれば false
 * - thumbnail があり、かつ `thumbnail !== icon` (= favicon フォールバック発動以外) であれば false (phase11.7)
 * - player.url / medias[] があれば false
 * - title が null / 空文字 / hostname と一致 → 「実質取れていない」とみなして true
 *
 * プラグインがマッチして取得した結果（title が `<user> on X` 等）は false 判定になる。
 * 完璧な判定ではないが、プラグイン化候補を取りこぼすよりノイズが少し増える方を許容する設計。
 *
 * **phase11.7 補正**: `thumbnail === icon` は parseGeneral の favicon フォールバック発動状態
 * （OG/Twitter/image_src/apple-touch-icon が全部無く favicon を thumbnail に流用したケース）なので、
 * thumbnail があっても thin 候補として継続判定する。「favicon あり + title だけ」は依然として
 * プラグイン化候補のシグナル。
 *
 * **注意**: `thumbnail === icon` の比較は **文字列完全一致** で行う。`parseGeneral` は同一の
 * `URL.href` 値を両方に代入するため通常は一致する。カスタムプラグインが両者に異なる正規化
 * 形式（末尾スラッシュあり/なし等）を入れた場合は、本フォールバック検出が効かない可能性がある。
 */
export function isThinSummary(summary: SummalyResult): boolean {
	if (summary.description != null && summary.description !== '') return false;
	if (summary.thumbnail != null && summary.thumbnail !== summary.icon) return false;
	if (summary.player.url != null) return false;
	// medias[] が乗っていれば（複数画像対応プラグイン由来）コンテンツは取れているので thin ではない
	if (summary.medias != null && summary.medias.length > 0) return false;
	if (summary.title == null || summary.title === '') return true;
	let host = '';
	try { host = new URL(summary.url).hostname; } catch { return true; }
	return summary.title === host;
}

/**
 * `summaly` Fastify モードの **エラーレスポンス用カテゴリ**（phase11.2）。
 * `error.category` フィールドで Misskey 等の利用側に渡し、UI の出し分けに使う。
 *
 * - `timeout` 取得タイムアウト / abort
 * - `bot_blocked` 4xx — Akamai / Cloudflare 等の bot 検知含む（404 を除く）
 * - `not_found` 404 のみ別カテゴリ（リンク切れ判別）
 * - `origin_error` 5xx 上流障害
 * - `unsupported_type` type filter — 非 HTML（PDF 無効時の PDF 等）
 * - `content_too_large` `contentLengthLimit` 超過 (10 MiB デフォルト)
 * - `ssrf_blocked` プライベート IP 拒否（IP パース失敗で投げられる `Invalid IP` も含む）
 * - `network_error` DNS 失敗 / 接続拒否 (`ENOTFOUND` 等)
 * - `connection_dropped` TCP/TLS は通ったが HTTP 応答前に切断 (`socket hang up` / `EPIPE` / `ECONNRESET` / `Empty reply`) — bot block 系の典型
 * - `parse_error` HTML は取れたが summarize が null / cheerio パース失敗
 * - `unknown` 上記いずれにも該当しない（catch-all）
 */
export type SummalyErrorCategory =
	| 'timeout'
	| 'bot_blocked'
	| 'not_found'
	| 'origin_error'
	| 'unsupported_type'
	| 'content_too_large'
	| 'ssrf_blocked'
	| 'network_error'
	| 'connection_dropped'
	| 'parse_error'
	| 'unknown';

/**
 * エラーオブジェクトからカテゴリを判定する。
 *
 * 優先順位:
 * 1. **メッセージ内の高シグナルパターン** (`Private IP rejected` / `Rejected by type filter` /
 *    timeout 系 / 低レベルネットワーク到達不能 / `failed summarize`) — これらは内部で
 *    `StatusError(_, 400)` 等として投げられても本来の意味で分類したい
 * 2. `errorName === 'TimeoutError' / AbortError / CancelError` で timeout
 * 3. `errorName === 'StatusError'` で `statusCode` が分かれば status 由来カテゴリ
 * 4. メッセージ先頭の 3 桁ステータスコードでフォールバック分類
 * 5. どれにも当たらなければ `'unknown'`
 *
 * ヒューリスティックは将来 got やライブラリのエラーメッセージ変更で false negative になる可能性があるが、
 * 既存挙動の互換性を保ちつつカテゴリを増やしていく。`'parse_error'` は `failed summarize` メッセージで判別する
 * 暫定実装で、将来 `SummarizeError` カスタムエラークラスに昇格すれば `errorName === 'SummarizeError'` で判定できる。
 */
export function categorizeError(
	errorMessage?: string,
	errorName?: string,
	statusCode?: number,
): SummalyErrorCategory {
	// 1. メッセージ内の高シグナルパターン（StatusError の statusCode より優先）
	//    `Private IP rejected` / `Invalid IP` は内部で `StatusError(_, 400/500)` として投げられるので、
	//    statusCode を先に見ると `bot_blocked` / `origin_error` と誤判定してしまう。意味重視で先にメッセージ判定する。
	if (errorMessage != null) {
		if (/Private IP rejected|Invalid IP/i.test(errorMessage)) return 'ssrf_blocked';
		if (/Rejected by type filter/i.test(errorMessage)) return 'unsupported_type';
		if (/maxSize exceeded/i.test(errorMessage)) return 'content_too_large';
		if (/timeout|timed out|aborted/i.test(errorMessage)) return 'timeout';
		// connection_dropped を network_error より前に判定する。`ECONNRESET` は両方にマッチしうるが、
		// 「TCP は通ったが HTTP 応答前に切断」という意味は connection_dropped 側に寄せる
		// （bot block 系 WAF の典型シグニチャ。フォールバック UA リトライの対象）。
		if (/socket hang up|EPIPE|ECONNRESET|Empty reply/i.test(errorMessage)) {
			return 'connection_dropped';
		}
		if (/ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN/i.test(errorMessage)) {
			return 'network_error';
		}
		if (/failed summarize/i.test(errorMessage)) return 'parse_error';
	}

	// 2. errorName ベースの timeout 系
	if (errorName === 'TimeoutError' || errorName === 'AbortError' || errorName === 'CancelError') {
		return 'timeout';
	}

	// 3. StatusError + statusCode で HTTP ステータス由来の分類
	if (errorName === 'StatusError' && typeof statusCode === 'number') {
		if (statusCode === 404) return 'not_found';
		if (statusCode >= 500 && statusCode < 600) return 'origin_error';
		if (statusCode >= 400 && statusCode < 500) return 'bot_blocked';
	}

	// 4. メッセージ先頭の 3 桁ステータスでフォールバック分類（StatusError 名前無しケース）
	if (errorMessage != null) {
		const m = /^\s*(\d{3})/.exec(errorMessage);
		if (m != null) {
			const code = Number(m[1]);
			if (code === 404) return 'not_found';
			if (code >= 500 && code < 600) return 'origin_error';
			if (code >= 400 && code < 500) return 'bot_blocked';
		}
	}

	return 'unknown';
}

/** `categorizeError` の戻り値のうち「プラグインを書いても救えない類型」の集合 */
const FILTERED_CATEGORIES = new Set<SummalyErrorCategory>([
	'timeout',
	'bot_blocked',
	'not_found',
	'origin_error',
	'unsupported_type',
	'content_too_large',
	'ssrf_blocked',
	'network_error',
	'connection_dropped',
]);

/**
 * 「絶対失敗する類型」を判定する。プラグインを書いても救えないため、`thin` 経路の純度を上げるために
 * パース失敗ログから除外する。実装は `categorizeError` の結果を `FILTERED_CATEGORIES` で篩に掛けるだけ。
 *
 * - `reason !== 'throw'` （= `'thin'`）は常に false （`thin` はプラグイン候補なので残す）
 * - `parse_error` / `unknown` は false （ノイズが少なく実装改善のヒントになり得るので残す）
 * - 上記以外（4xx/5xx/timeout/type filter/SSRF/network）は true で記録対象から除外
 */
export function isFilteredFailure(
	reason: ParseFailureReason,
	errorMessage?: string,
	errorName?: string,
	statusCode?: number,
): boolean {
	if (reason !== 'throw') return false;
	const category = categorizeError(errorMessage, errorName, statusCode);
	return FILTERED_CATEGORIES.has(category);
}

export interface ParseFailureLogConfig {
	maxGroups: number;
	samplesPerGroup: number;
	/**
	 * 永続化用の JSONL ファイルパス。指定されたら record() 毎に 1 行 append する。
	 * undefined の場合は in-memory のみ。
	 */
	jsonlPath?: string;
	/**
	 * JSONL ファイルがこのバイト数を超えたら以降の append を停止する（ローテーションはしない）。
	 * 「気付いたタイミングで運用者が rm / mv する」運用想定。デフォルト 10 MiB。
	 */
	jsonlMaxBytes?: number;
}

const DEFAULT_JSONL_MAX_BYTES = 10 * 1024 * 1024;

/** 1 行 JSONL のシリアライズ。改行文字を含むメッセージも 1 行に収まるよう JSON.stringify 任せ */
export function serializeJsonlLine(key: string, sample: ParseFailureSample): string {
	return JSON.stringify({ key, ...sample }) + '\n';
}

/**
 * 集約ログ store。Fastify プラグインスコープ singleton として保持される想定。
 */
export class ParseFailureLog {
	readonly maxGroups: number;
	readonly samplesPerGroup: number;
	readonly jsonlPath?: string;
	readonly jsonlMaxBytes: number;
	/** 現在の JSONL ファイルサイズの in-memory キャッシュ。append のたびに更新 */
	private jsonlBytes: number;
	/** ファイル書き込みエラーを連続記録しないよう連発防止フラグ */
	private jsonlWriteErrorLogged = false;
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
		this.jsonlPath = config.jsonlPath;
		this.jsonlMaxBytes = config.jsonlMaxBytes ?? DEFAULT_JSONL_MAX_BYTES;
		if (!Number.isFinite(this.jsonlMaxBytes) || this.jsonlMaxBytes < 0) {
			throw new RangeError(`parseFailureLog.jsonlMaxBytes must be a non-negative finite number, got ${this.jsonlMaxBytes}`);
		}
		// 起動時に既存ファイルサイズを取得（後続の append サイズチェックの基準値）
		this.jsonlBytes = 0;
		if (this.jsonlPath != null) {
			try {
				const st = statSync(this.jsonlPath);
				this.jsonlBytes = st.size;
			} catch {
				// ファイル未存在は OK（最初の append で作成される）
			}
		}
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

		// JSONL 永続化（オプトイン）。サイズ cap を越えたら以降の append は停止。
		// in-memory map への記録とは独立に効くため、cap 到達後も in-memory は更新が続く。
		this.appendJsonl(key, sample);
	}

	/** 1 サンプルを JSONL ファイルに append。サイズキャップ越え or ファイル I/O 失敗時はサイレントスキップ。 */
	private appendJsonl(key: string, sample: ParseFailureSample): void {
		if (this.jsonlPath == null) return;
		if (this.jsonlBytes >= this.jsonlMaxBytes) return; // 既に cap 越え
		const line = serializeJsonlLine(key, sample);
		const lineBytes = Buffer.byteLength(line, 'utf8');
		// この append で cap を越える場合も書き込まない（cap を厳守し、不揃いな半分書き込みを避ける）
		if (this.jsonlBytes + lineBytes > this.jsonlMaxBytes) {
			this.jsonlBytes = this.jsonlMaxBytes; // 以降スキップさせる
			return;
		}
		try {
			appendFileSync(this.jsonlPath, line, 'utf8');
			this.jsonlBytes += lineBytes;
		} catch (e) {
			// ディレクトリが無い / 権限エラー等。連発を避けて 1 回だけ stderr に出す
			if (!this.jsonlWriteErrorLogged) {
				this.jsonlWriteErrorLogged = true;
				const msg = e instanceof Error ? e.message : String(e);
				process.stderr.write(`[summaly][parseFailureLog] JSONL write failed (subsequent errors suppressed): ${msg}\n`);
			}
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
