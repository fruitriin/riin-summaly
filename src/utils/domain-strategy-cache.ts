/**
 * 経路学習キャッシュ。
 *
 * ドメイン (host + path prefix 1〜2 段) ごとに「成功した取得経路」を学習し、
 * JSONL で永続化する。次回以降のリクエストで第一選択肢として使うことで、
 * 「初回 default UA で 20 秒空回り → fallback で成功」のような時間損失を回避する。
 *
 * ## ストレージ設計
 *
 * - bootstrap JSONL (リポ同梱、初期データ) を起動時に 1 回ロード
 * - runtime JSONL (環境ローカル) を bootstrap の後にロード（runtime 優先で上書き）
 * - 学習更新は runtime JSONL に append
 * - append 回数が `compactionThreshold` を超えたら BG で全件書き換え (compaction)
 *
 * ## lookup 順序 (specific → general)
 *
 * URL `https://amazon.co.jp/dp/B0XXXXXX/?ref=...` の場合:
 *   1. `amazon.co.jp/dp/B0XXXXXX` (path 2 段) — 完全一致
 *   2. `amazon.co.jp/dp` (path 1 段) — prefix 一致
 *   3. `amazon.co.jp` (host のみ) — host 一致
 *
 * 最初にヒットしたエントリの `strategy` を第一選択肢として使う。
 *
 * ## 失敗ベース invalidate
 *
 * 一時障害でエントリが破棄されないよう、N 連続失敗 (デフォルト 3) で破棄する。
 * 連続失敗中は学習した経路を引き続き第一選択肢として使う (= 一時障害なら次回成功で
 * `consecutiveFailures` リセット)。サイトの WAF ポリシー変更にも自然に追従する。
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 学習対象の取得経路。`scpaping` カスケードの段ごとに対応する。 */
export type DomainStrategy = 'default' | 'fallback_ua' | 'proxy' | 'curl_cffi';

const VALID_STRATEGIES: ReadonlySet<string> = new Set<DomainStrategy>([
	'default',
	'fallback_ua',
	'proxy',
	'curl_cffi',
]);

export interface DomainStrategyEntry {
	/** lookup key: 例 "amazon.co.jp" / "amazon.co.jp/dp" / "amazon.co.jp/dp/B0XXX" */
	pathKey: string;
	strategy: DomainStrategy;
	/** 連続成功回数 (= 信頼度) */
	successCount: number;
	/** 連続失敗回数。`consecutiveFailureThreshold` 以上で破棄 */
	consecutiveFailures: number;
	/** 最後に成功した unix ms */
	lastSuccessAt: number;
	/** 最後に試行した unix ms */
	lastAttemptAt: number;
}

export interface DomainStrategyCacheConfig {
	/** in-memory LRU の上限エントリ数 (default 5000) */
	maxEntries?: number;
	/** リポ同梱の bootstrap JSONL パス。指定があれば起動時に 1 回ロード */
	bootstrapPath?: string;
	/** runtime JSONL パス。指定があれば起動時にロード + 学習更新で append + compaction の対象 */
	runtimePath?: string;
	/** N 連続失敗で破棄 (default 3) */
	consecutiveFailureThreshold?: number;
	/** runtime JSONL の累積行数がこれを超えたら BG 圧縮 (default 1000) */
	compactionThreshold?: number;
}

/**
 * `SummalyOptions.domainStrategyCache` の型 (TOML config 由来の値を運ぶ)。
 * `enabled === true` なら summaly レイヤで `DomainStrategyCache` を 1 つ作って共有する想定。
 *
 * `DomainStrategyCacheConfig` との違いは `enabled` フラグの有無のみ。インスタンス化時に
 * このオプションから `DomainStrategyCacheConfig` に詰め替える。
 */
export interface DomainStrategyCacheOptions extends DomainStrategyCacheConfig {
	enabled: boolean;
}

const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COMPACTION_THRESHOLD = 1000;

/**
 * URL から lookup 用 pathKey を specific → general 順に生成する。
 *
 * - `https://amazon.co.jp/dp/B0XXXXXX/?ref=...` → `['amazon.co.jp/dp/B0XXXXXX', 'amazon.co.jp/dp', 'amazon.co.jp']`
 * - `https://example.com/` → `['example.com']`
 * - 不正 URL → `[]`
 *
 * **注**: `URL.hostname` は port を含まない。`groupKeyOf` (parse-failure-log) と同じ正規化方針。
 */
export function pathKeysOf(input: URL | string): string[] {
	let u: URL;
	try {
		u = input instanceof URL ? input : new URL(input);
	} catch {
		return [];
	}
	// `data:` / `file:` / `javascript:` 等のスキームは `URL.origin === 'null'` 系で hostname も
	// 空 / 不適切になるため学習対象外。http(s) のみ受け入れる。
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return [];
	const host = u.hostname;
	if (host === '') return [];
	const segs = u.pathname.split('/').filter(Boolean).slice(0, 2);
	if (segs.length === 0) return [host];
	if (segs.length === 1) return [`${host}/${segs[0]}`, host];
	return [`${host}/${segs[0]}/${segs[1]}`, `${host}/${segs[0]}`, host];
}

/**
 * 任意の値が `DomainStrategyEntry` として有効かを判定する型ガード。
 * JSONL ロード時の壊れ行を弾くために使う。
 */
function isValidEntry(v: unknown): v is DomainStrategyEntry {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	if (typeof o.pathKey !== 'string' || o.pathKey === '') return false;
	if (typeof o.strategy !== 'string' || !VALID_STRATEGIES.has(o.strategy)) return false;
	if (typeof o.successCount !== 'number' || !Number.isFinite(o.successCount) || o.successCount < 0) return false;
	if (typeof o.consecutiveFailures !== 'number' || !Number.isFinite(o.consecutiveFailures) || o.consecutiveFailures < 0) return false;
	if (typeof o.lastSuccessAt !== 'number' || !Number.isFinite(o.lastSuccessAt)) return false;
	if (typeof o.lastAttemptAt !== 'number' || !Number.isFinite(o.lastAttemptAt)) return false;
	return true;
}

/**
 * 経路学習キャッシュ。
 *
 * **同期 API**: `recordSuccess` / `recordFailure` は同期関数で event loop 上で原子的に完了する。
 * Fastify の async ハンドラから並行に呼ばれても `Map` の中間状態は競合しない。
 * 将来 await を入れたくなったら呼び出し側との競合を再設計する必要あり。
 *
 * **永続化**: append は `appendFileSync` (失敗は 1 度だけ stderr 警告)。compaction は
 * `setImmediate` 経由で次イベントループに defer して呼ぶが、内部処理は同期 (writeFileSync +
 * renameSync) で原子性を担保する。
 */
export class DomainStrategyCache {
	readonly maxEntries: number;
	readonly bootstrapPath?: string;
	readonly runtimePath?: string;
	readonly consecutiveFailureThreshold: number;
	readonly compactionThreshold: number;
	private readonly map: Map<string, DomainStrategyEntry> = new Map();
	/** `appendRuntime` (per-line append) 用の連発抑制フラグ */
	private appendErrorLogged = false;
	/** `doCompact` (rewrite) 用の連発抑制フラグ。append 系と分離することで一方が抑制されても他方は通る */
	private compactErrorLogged = false;
	private compactingScheduled = false;
	private runtimeLineCount = 0;

	constructor(config: DomainStrategyCacheConfig = {}) {
		this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
		if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
			throw new RangeError(`domainStrategyCache.maxEntries must be a positive integer, got ${this.maxEntries}`);
		}
		this.consecutiveFailureThreshold = config.consecutiveFailureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
		if (!Number.isInteger(this.consecutiveFailureThreshold) || this.consecutiveFailureThreshold < 1) {
			throw new RangeError(`domainStrategyCache.consecutiveFailureThreshold must be a positive integer, got ${this.consecutiveFailureThreshold}`);
		}
		this.compactionThreshold = config.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
		if (!Number.isInteger(this.compactionThreshold) || this.compactionThreshold < 1) {
			throw new RangeError(`domainStrategyCache.compactionThreshold must be a positive integer, got ${this.compactionThreshold}`);
		}
		this.bootstrapPath = config.bootstrapPath;
		this.runtimePath = config.runtimePath;

		// bootstrap → runtime の順にロード (runtime 優先で上書き)
		if (this.bootstrapPath != null) this.loadJsonl(this.bootstrapPath, 'bootstrap');
		if (this.runtimePath != null) {
			this.runtimeLineCount = this.loadJsonl(this.runtimePath, 'runtime');
		}
	}

	/**
	 * URL に最も specific にマッチするエントリを返す。
	 * ヒットしなければ undefined。
	 */
	lookup(url: URL | string): { entry: DomainStrategyEntry; hitKey: string } | undefined {
		const keys = pathKeysOf(url);
		for (const key of keys) {
			const entry = this.map.get(key);
			if (entry !== undefined) {
				return { entry, hitKey: key };
			}
		}
		return undefined;
	}

	/**
	 * pathKey に成功を記録する。
	 *
	 * - 既存エントリと strategy が同じ → `successCount++`、`consecutiveFailures = 0`
	 * - 既存エントリと strategy が違う、または新規 → 新しい strategy に切り替えて再カウント
	 *
	 * 永続化: runtime JSONL に append。
	 */
	recordSuccess(pathKey: string, strategy: DomainStrategy): void {
		const now = Date.now();
		const existing = this.map.get(pathKey);
		const entry: DomainStrategyEntry = (existing != null && existing.strategy === strategy)
			? {
				pathKey,
				strategy,
				successCount: existing.successCount + 1,
				consecutiveFailures: 0,
				lastSuccessAt: now,
				lastAttemptAt: now,
			}
			: {
				pathKey,
				strategy,
				successCount: 1,
				consecutiveFailures: 0,
				lastSuccessAt: now,
				lastAttemptAt: now,
			};
		this.upsert(entry);
		this.appendRuntime(entry);
	}

	/**
	 * pathKey に失敗を記録する。
	 *
	 * - 既存エントリ無し → no-op (失敗を記録する対象が無い)
	 * - 既存エントリあり → `consecutiveFailures++`
	 *   - 閾値以上になったらエントリ破棄 (in-memory から delete + JSONL にも閾値到達状態を append)
	 *
	 * **注**: 閾値到達 → in-memory delete + JSONL append の順だが、append が I/O エラーで失敗した場合、
	 * in-memory では消えているのに JSONL の最後の行は「閾値未満」のままとなり、次回起動時に bootstrap
	 * の値があれば復元されてしまう (一時 I/O エラーで破棄が「なかったこと」になる)。連続失敗状況下では
	 * 次の `recordFailure` で再び閾値到達 → 破棄が試みられるため、最終的には破棄が永続化される。
	 */
	recordFailure(pathKey: string): void {
		const existing = this.map.get(pathKey);
		if (existing == null) return;
		const now = Date.now();
		const newConsecutive = existing.consecutiveFailures + 1;
		const entry: DomainStrategyEntry = {
			...existing,
			consecutiveFailures: newConsecutive,
			lastAttemptAt: now,
		};
		if (newConsecutive >= this.consecutiveFailureThreshold) {
			// 閾値到達 — in-memory から削除。JSONL には閾値到達状態を append しておくことで、
			// 次回起動時のロードで `loadJsonl` が「この pathKey は破棄済み」と認識して
			// bootstrap の値を上書き削除する。
			this.map.delete(pathKey);
			this.appendRuntime(entry);
		} else {
			this.upsert(entry);
			this.appendRuntime(entry);
		}
	}

	/** 全エントリを `lastAttemptAt` 降順で返す (テスト・dev サーバ表示用)。 */
	snapshot(): DomainStrategyEntry[] {
		return Array.from(this.map.values())
			.sort((a, b) => b.lastAttemptAt - a.lastAttemptAt);
	}

	get size(): number {
		return this.map.size;
	}

	clear(): void {
		this.map.clear();
	}

	/** 強制 compaction (テスト用)。通常は append 回数で自動発火する。 */
	forceCompaction(): void {
		this.doCompact();
	}

	/**
	 * Map の挿入順を最新化する LRU 風 upsert。
	 * 上限超過時は最古キーから捨てる。
	 */
	private upsert(entry: DomainStrategyEntry): void {
		this.map.delete(entry.pathKey);
		this.map.set(entry.pathKey, entry);
		while (this.map.size > this.maxEntries) {
			const oldest = this.map.keys().next().value;
			if (oldest === undefined) break;
			this.map.delete(oldest);
		}
	}

	/**
	 * JSONL ファイルをロードして map に展開する。
	 *
	 * - **bootstrap (リポ同梱の信頼データ)**: 各行をそのまま採用するが `consecutiveFailures` は
	 *   常に 0 にリセットしてロード (bootstrap に閾値以上の失敗カウントが書かれていても誤削除しない)。
	 *   bootstrap は「同梱時点でのベスト経路」を表すスナップショットであり、過去の失敗カウントは
	 *   実行環境では意味を持たないため
	 * - **runtime (環境固有の学習履歴)**: `consecutiveFailures >= threshold` のエントリは
	 *   「破棄済みマーク」として扱い、map から delete する (bootstrap で入っていれば打ち消し)
	 * - 後勝ち (= ファイル末尾に近いほうが優先) で同 pathKey を上書き
	 * - 不正な行 (JSON parse 失敗 / schema 不一致) は無視
	 * - ファイル未存在は OK (no-op)
	 *
	 * 戻り値: 有効に処理した行数 (compaction 判定で使う)。
	 */
	private loadJsonl(path: string, label: 'bootstrap' | 'runtime'): number {
		let text: string;
		try {
			text = readFileSync(path, 'utf8');
		} catch (e) {
			// ENOENT は OK (空状態でスタート)
			const code = (e as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') return 0;
			process.stderr.write(`[summaly][domainStrategyCache] failed to read ${label} JSONL ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
			return 0;
		}
		let count = 0;
		for (const line of text.split('\n')) {
			if (line.trim() === '') continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (!isValidEntry(parsed)) continue;
			count++;
			if (label === 'bootstrap') {
				// bootstrap は信頼データ。consecutiveFailures を 0 にリセットして取り込み、
				// 起動時 threshold 設定で誤って削除されるのを防ぐ。
				this.upsert({ ...parsed, consecutiveFailures: 0 });
			} else if (parsed.consecutiveFailures >= this.consecutiveFailureThreshold) {
				// runtime の閾値到達エントリは「破棄済みマーク」として扱い、bootstrap を打ち消す。
				this.map.delete(parsed.pathKey);
			} else {
				this.upsert(parsed);
			}
		}
		return count;
	}

	/**
	 * runtime JSONL に 1 行 append し、append 回数が閾値を超えたら compaction を schedule する。
	 *
	 * ファイル I/O エラーは 1 度だけ stderr に出して以降サイレント (連発抑制)。
	 */
	private appendRuntime(entry: DomainStrategyEntry): void {
		if (this.runtimePath == null) return;
		const line = JSON.stringify(entry) + '\n';
		try {
			// 親ディレクトリが無いと appendFileSync が失敗するため、初回だけ作成を試みる
			this.ensureDirOnce(this.runtimePath);
			appendFileSync(this.runtimePath, line, 'utf8');
			this.runtimeLineCount++;
		} catch (e) {
			if (!this.appendErrorLogged) {
				this.appendErrorLogged = true;
				const msg = e instanceof Error ? e.message : String(e);
				process.stderr.write(`[summaly][domainStrategyCache] runtime JSONL append failed (subsequent errors suppressed): ${msg}\n`);
			}
			return;
		}
		if (this.runtimeLineCount >= this.compactionThreshold && !this.compactingScheduled) {
			this.compactingScheduled = true;
			setImmediate(() => this.doCompact());
		}
	}

	private dirEnsured = false;
	private ensureDirOnce(path: string): void {
		if (this.dirEnsured) return;
		const dir = dirname(path);
		try {
			mkdirSync(dir, { recursive: true });
		} catch {
			// 既に存在 / 権限エラー等は appendFileSync 側で発覚させる
		}
		this.dirEnsured = true;
	}

	/**
	 * runtime JSONL を現在の map 内容で書き換える (compaction)。
	 *
	 * 同期 I/O だが、`setImmediate` 経由で defer されているため呼び出しスタックは
	 * リクエスト処理から切り離されている。`writeFileSync` で tmp に書いて `renameSync`
	 * で原子的に置き換える。
	 */
	private doCompact(): void {
		this.compactingScheduled = false;
		if (this.runtimePath == null) return;
		const tmpPath = `${this.runtimePath}.tmp.${process.pid}.${Date.now()}`;
		const lines = Array.from(this.map.values())
			.map(e => JSON.stringify(e) + '\n')
			.join('');
		try {
			this.ensureDirOnce(this.runtimePath);
			writeFileSync(tmpPath, lines, 'utf8');
			renameSync(tmpPath, this.runtimePath);
			this.runtimeLineCount = this.map.size;
		} catch (e) {
			// `writeFileSync` は成功したが `renameSync` で失敗したケース (cross-device rename 等) を含め、
			// 残った tmp ファイルをディスクから消す (失敗しても無視 — 元の例外を優先)
			try { unlinkSync(tmpPath); } catch { /* tmp 未作成 / 権限エラー等 */ }
			if (!this.compactErrorLogged) {
				this.compactErrorLogged = true;
				const msg = e instanceof Error ? e.message : String(e);
				process.stderr.write(`[summaly][domainStrategyCache] compaction failed (subsequent errors suppressed): ${msg}\n`);
			}
		}
	}
}

/**
 * リポ同梱の bootstrap JSONL の絶対パスを返す。
 *
 * `data/domain-strategy-bootstrap.jsonl` は `package.json` `files: ["built", "data", "LICENSE"]`
 * で publish 対象に含まれており、利用者の `node_modules/@misskey-dev/summaly/data/` 配下に配備される。
 *
 * **パス解決戦略**: `import.meta.url` を起点に複数の候補を `statSync` で probe する:
 * - **bundled**: `built/index.js` → `../data/domain-strategy-bootstrap.jsonl`
 * - **source dev**: `src/utils/domain-strategy-cache.ts` → `../../data/domain-strategy-bootstrap.jsonl`
 *
 * 見つからない場合 (= カスタムビルドや非標準レイアウト) は `undefined` を返す。
 * 呼出側は undefined のとき bootstrap なしで cache を初期化する。
 *
 * 設計選択: `DomainStrategyCache` コンストラクタで自動解決すると、テスト時に意図せず本ファイルが
 * ロードされて状態が汚染されるため、本関数は **明示的に呼ばれた場合のみ** デフォルトを返す。
 * Fastify auto-init (src/index.ts) では `bootstrapPath ?? getDefaultBootstrapPath()` で利用する。
 */
export function getDefaultBootstrapPath(): string | undefined {
	if (typeof import.meta.url !== 'string') return undefined;
	let here: string;
	try {
		here = fileURLToPath(import.meta.url);
	} catch {
		return undefined;
	}
	const dir = dirname(here);
	// **2 候補を順番に probe する設計 (S-1 review feedback)**:
	// - tsdown でビルドした output ('built/index.js' or `built/<chunk>-<hash>.js`) から見ると
	//   data/ は `../data/` に位置する (publish 後の `node_modules/@misskey-dev/summaly/data/`)
	// - source dev (`src/utils/domain-strategy-cache.ts` を tsx で実行) から見ると
	//   data/ は `../../data/` に位置する (repo root の `data/`)
	// 将来 tsdown 設定で chunk が `built/chunks/` 配下に置かれるようになっても 2 番目の
	// candidate が source レイアウトでない限り fallback しないので注意 (将来配置変更時は本配列の追加が必要)。
	const candidates = [
		// bundled: built/<file> から見て ../data/...
		join(dir, '..', 'data', 'domain-strategy-bootstrap.jsonl'),
		// source dev: src/utils/domain-strategy-cache.ts から見て ../../data/...
		join(dir, '..', '..', 'data', 'domain-strategy-bootstrap.jsonl'),
	];
	for (const c of candidates) {
		try {
			const st = statSync(c);
			if (st.isFile()) return c;
		} catch {
			// ENOENT 等、次の候補を試す
		}
	}
	return undefined;
}

/**
 * 既存の runtime JSONL ファイルサイズ確認 (運用診断用ヘルパ。本クラス内では未使用)。
 */
export function tryStatJsonl(path: string): { size: number } | undefined {
	try {
		const st = statSync(path);
		return { size: st.size };
	} catch {
		return undefined;
	}
}

/**
 * 現在 active な `DomainStrategyCache` インスタンス。
 *
 * `setActiveCache` で設定する。`scpaping()` は `getActiveCache()` で取得して lookup する。
 * 設計選択: `agent` (got.ts) と同じくモジュールレベル singleton。
 *
 * - **Fastify モード**: プラグイン setup 時に `[scraping.strategy_cache].enabled = true` なら
 *   インスタンス化して `setActiveCache` を呼ぶ
 * - **ライブラリモード**: 利用者が `setActiveCache` を直接呼ぶ
 * - **テスト**: `beforeEach` / `afterEach` で `setActiveCache(undefined)` に戻して状態リセット
 */
let activeCache: DomainStrategyCache | undefined;

export function setActiveCache(cache: DomainStrategyCache | undefined): void {
	activeCache = cache;
}

export function getActiveCache(): DomainStrategyCache | undefined {
	return activeCache;
}

/**
 * `summaly()` レイヤと `scpaping()` レイヤ間で cache 記録 context を伝達する mutable side-channel。
 *
 * 設計理由: Summary の良し悪し判定 (`isThinSummary`) は `summaly()` の最後で行うが、
 * 記録すべき pathKey と成功 strategy は `scpaping()` レイヤでしか分からない。
 * そこで scpaping は cache.recordX を呼ばず、本オブジェクトに必要 context を埋めて summaly() に渡す。
 * summaly() は Summary 確定後に context を読んで適切に recordSuccess / recordFailure を呼ぶ。
 *
 * フィールド:
 * - `recordKey`: 記録対象の pathKey (cache hit があれば hitKey、cache miss なら 1-seg pathKey)
 * - `strategy`: cascade で成功した strategy (cache hit success / fast path success / cascade success)
 * - `gateFailedNeutral`: cache hit がゲート不通過だった場合 true。summaly() は record をスキップし
 *   entry を「config 復帰時の再利用候補」として温存する (neutrality 維持)
 *
 * **HTTP-layer recordSuccess を scpaping から外した理由 (Step 2b 後半 設計修正)**: HTTP success
 * → recordSuccess (consecutiveFailures=0) → Summary thin → recordFailure (consecutiveFailures=1)
 * → 次回 HTTP success → recordSuccess (consecutiveFailures=0) ... の循環で連続失敗カウンタが
 * 閾値に達せず invalidate が機能しない問題があった。Summary 層で一括判定すれば bot-block 200+thin
 * パターンも正しく N 回で破棄される。
 */
export type CacheRecordingState = {
	recordKey?: string;
	strategy?: DomainStrategy;
	gateFailedNeutral?: boolean;
	/** phase18 hedged race: 並列発火が起きたか (pino ログ用) */
	hedgeFired?: boolean;
	/** phase18 hedged race: 各経路の outcome (pino ログ用) */
	hedgeOutcomes?: Partial<Record<DomainStrategy, 'valid' | 'invalid' | 'error' | 'gate_failed'>>;
	/** phase18 hedged race: 各経路の completion latency ms (pino ログ用) */
	hedgeLatencyMs?: Partial<Record<DomainStrategy, number>>;
	/**
	 * phase18.1: 各経路の失敗 error message (pino ログ用、本番診断必須)。
	 * outcomes: 'error' の strategy について「**なぜ** error か」を string で保持。
	 * 例: `{ curl_cffi: 'curl_cffi spawn failed (uv が未インストール...)', proxy: '403 Forbidden' }`
	 */
	hedgeErrors?: Partial<Record<DomainStrategy, string>>;
};
