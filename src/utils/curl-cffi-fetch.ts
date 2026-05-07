/**
 * curl_cffi (libcurl-impersonate) フォールバック (phase12.5)。
 *
 * `getResponseWithProxyFallback` (phase12.1 の Worker proxy フォールバック) でも救えなかった
 * **TLS layer の bot block** に対し、`tools/curl-cffi-fetcher/` の Python CLI を
 * `child_process.spawn` で呼び出してリトライする。
 *
 * curl_cffi は libcurl-impersonate の Python バインディングで、Chrome / Firefox / Safari の
 * **TLS フィンガープリント (JA3)** と HTTP/2 settings を完全再現する。`got` (undici) や
 * Cloudflare Workers の fetch は TLS フィンガープリントが固定で偽装できないため、
 * yodobashi 級の TLS layer 切断 (HTTP/2 INTERNAL_ERROR / 即時切断) はここでしか救えない。
 *
 * 発火条件:
 * - 1 回目 + UA fallback + proxy fallback すべて失敗
 * - エラーカテゴリが `categories` (デフォルト `['timeout', 'connection_dropped', 'bot_blocked']`) に含まれる
 * - target hostname が `domains` allowlist にマッチ (suffix-match、proxy と同じ規則)
 *
 * production server には `uv` (Python パッケージマネージャ) を別途インストールし、
 * `cd tools/curl-cffi-fetcher && uv sync` で依存解決しておく必要がある。
 */

import { spawn } from 'node:child_process';
import * as Got from 'got';
import { categorizeError, type SummalyErrorCategory } from '@/utils/parse-failure-log.js';
import { StatusError } from '@/utils/status-error.js';
import {
	matchesDomain,
	getResponseWithProxyFallback,
	type ProxyFallbackConfig,
} from '@/utils/proxy-fallback.js';
import {
	type GotOptions,
	type FallbackUaConfig,
	type StrategyTracker,
	DEFAULT_RESPONSE_TIMEOUT,
	DEFAULT_MAX_RESPONSE_SIZE,
} from '@/utils/got.js';

/**
 * curl_cffi フォールバック設定。
 *
 * - `enabled === false` なら curl_cffi 経路は無効
 * - `categories` のエラーが発生 + `domains` 一致 のときだけ curl_cffi が発火
 */
export interface CurlCffiFallbackConfig {
	enabled: boolean;
	/** uv バイナリのパス。PATH 上にあれば `'uv'` で OK、無ければ絶対パス指定 */
	uvPath: string;
	/** `tools/curl-cffi-fetcher/` のパス (絶対 or process.cwd() 相対) */
	projectDir: string;
	/** 偽装する TLS フィンガープリント (`chrome120` / `firefox120` / `safari17_0` 等) */
	impersonate: string;
	/** リトライ発火対象のエラーカテゴリ */
	categories: SummalyErrorCategory[];
	/**
	 * 許可ドメイン (suffix-match)。`proxy` と同じ規則。
	 * 任意 URL を ブラウザ偽装で叩けるツールを scraping bridge として晒さないための allowlist。
	 */
	domains: string[];
	/** 1 リクエスト全体のタイムアウト (ミリ秒)。spawn 起動 + curl_cffi 完走の合計 */
	timeoutMs: number;
}

// TLS layer 遮断は `connection_dropped` (HTTP/2 INTERNAL_ERROR) / `timeout`
// (Vultr 等から `Timeout awaiting 'socket'`) / `bot_blocked` のいずれかで来る (phase12.4 yodobashi 観測)。
export const DEFAULT_CURL_CFFI_CATEGORIES: SummalyErrorCategory[] = [
	'timeout',
	'connection_dropped',
	'bot_blocked',
];
export const DEFAULT_CURL_CFFI_TIMEOUT_MS = 30000;
export const DEFAULT_CURL_CFFI_IMPERSONATE = 'chrome120';

/**
 * `getResponseWithProxyFallback` のラッパで、proxy fallback でも救えなかったエラーが
 * curl_cffi 発火条件に合致するなら Python CLI 経由でリトライする (phase12.5)。
 *
 * 段階構造:
 * 1. デフォルト UA で `getResponse`
 * 2. `getResponseWithFallback` で UA 切替リトライ (phase11.9)
 * 3. `getResponseWithProxyFallback` で CF Workers proxy 経由リトライ (phase12.1)
 * 4. **`getResponseWithCurlCffiFallback` で curl_cffi 経由リトライ (phase12.5、本関数)**
 *
 * - `curlCffiConfig === undefined` または `enabled === false` なら通常の proxy fallback 等価
 * - 1〜3 段全て失敗 → カテゴリ判定 + ドメイン allowlist チェック → curl_cffi 経由でリトライ
 * - curl_cffi も失敗したら **curl_cffi のエラー**（最後のエラー）を throw
 */
export async function getResponseWithCurlCffiFallback(
	args: GotOptions,
	uaFallback: FallbackUaConfig | undefined,
	proxyConfig: ProxyFallbackConfig | undefined,
	curlCffiConfig: CurlCffiFallbackConfig | undefined,
	tracker?: StrategyTracker,
): Promise<Got.Response<string>> {
	try {
		return await getResponseWithProxyFallback(args, uaFallback, proxyConfig, tracker);
	} catch (err) {
		if (curlCffiConfig == null || !curlCffiConfig.enabled) {
			throw err;
		}
		const message = err instanceof Error ? err.message : undefined;
		const name = err instanceof Error ? err.name : undefined;
		const statusCode = err instanceof StatusError ? err.statusCode : undefined;
		const category = categorizeError(message, name, statusCode);
		if (!curlCffiConfig.categories.includes(category)) {
			throw err;
		}
		let targetUrl: URL;
		try {
			targetUrl = new URL(args.url);
		} catch {
			throw err;
		}
		if (!matchesDomain(targetUrl.hostname, curlCffiConfig.domains)) {
			throw err;
		}
		// URL は curl_cffi CLI 内でも `https://` プレフィックス検証している (二重防御)
		if (targetUrl.protocol !== 'https:') {
			throw err;
		}
		const r = await viaCurlCffi(args, curlCffiConfig);
		if (tracker != null) tracker.value = 'curl_cffi';
		return r;
	}
}

/**
 * CLI レスポンスの JSON 形式 (`tools/curl-cffi-fetcher/src/curl_cffi_fetcher/fetch.py` の出力)。
 */
type CurlCffiCliResponse =
	| {
		status: number;
		final_url: string;
		content_type: string;
		headers: Record<string, string>;
		body: string;
	}
	| {
		error: string;
		category: 'timeout' | 'network' | 'tls' | 'setup' | 'content_too_large' | 'invalid_url' | 'other';
	};

/**
 * `tools/curl-cffi-fetcher/` の Python CLI を `uv run fetch <url>` で起動し、
 * stdout の JSON をパースして `Got.Response<string>` 形式で返す。
 *
 * セキュリティ:
 * - `spawn` を `shell: false` (デフォルト) で呼ぶため shell injection の経路は無い
 * - URL は呼出側で `new URL()` で検証済み + 本関数で `https:` 限定 + allowlist 通過済み
 * - `--impersonate` 値は `cfg.impersonate` (config 由来、外部入力ではない)
 * - 子プロセスの timeout は `cfg.timeoutMs` で SIGKILL 強制終了
 */
export async function viaCurlCffi(
	args: GotOptions,
	cfg: CurlCffiFallbackConfig,
): Promise<Got.Response<string>> {
	const maxBytes = args.contentLengthLimit ?? DEFAULT_MAX_RESPONSE_SIZE;
	const responseTimeoutSec = (args.responseTimeout ?? DEFAULT_RESPONSE_TIMEOUT) / 1000;

	const cliResult = await runCurlCffiCli(args.url, cfg, responseTimeoutSec, maxBytes);

	if ('error' in cliResult) {
		// CLI のエラー category を Node 側の StatusError / Error に変換。
		// `category: 'timeout' | 'tls'` は categorizeError で `timeout` / `connection_dropped` 相当に分類される
		// (phase11.2 で導入した SummalyErrorCategory との互換)。
		throw new Error(`curl_cffi (${cliResult.category}): ${cliResult.error}`);
	}

	if (cliResult.status >= 400) {
		throw new StatusError(
			`${cliResult.status} (via curl_cffi)`,
			cliResult.status,
			'curl_cffi error',
		);
	}

	// content-type の type filter 再検証 (defense-in-depth)。
	// curl_cffi 経由でも yodobashi のような bot 検出系が `text/html` 以外を返すケースをガード。
	if (args.typeFilter != null) {
		const ct = cliResult.content_type;
		if (ct === '' || !ct.match(args.typeFilter)) {
			throw new Error(`Rejected by type filter ${ct} (via curl_cffi)`);
		}
	}

	// body サイズ cap (CLI 側でも 5 MiB cap しているが、`--max-bytes` で渡しているため通常はここに到達しない)
	//
	// **エンコーディング契約 (W-1)**: `cliResult.body` は CLI (`fetch.py`) 側で `curl_cffi` の
	// `response.text` (Content-Type の charset または chardet で検出してデコード済み) として
	// Python str を JSON 文字列に乗せて渡されてくる。**Node 側では UTF-8 として固定的に扱う**
	// 設計選択。`got` 経路では `rawBody` を `detectEncoding` → `toUtf8` で再変換するが、
	// curl_cffi 経路では Python 側でデコード済みのため二重変換しない。
	// non-UTF-8 (古い ISO-8859-1 等) サイトで万が一文字化けが起きた場合は、CLI 側を
	// `body_base64` で生バイト列を返すスキーマに拡張するのが正攻法。
	const rawBody = Buffer.from(cliResult.body, 'utf8');
	if (rawBody.byteLength > maxBytes) {
		throw new Error(`maxSize exceeded (${rawBody.byteLength} > ${maxBytes}) on response (via curl_cffi)`);
	}

	// final URL の安全な再検証 (proxy-fallback と同じ defense-in-depth)
	let resolvedUrl = args.url;
	if (cliResult.final_url !== '') {
		try {
			const parsed = new URL(cliResult.final_url);
			if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
				resolvedUrl = cliResult.final_url;
			}
		} catch {
			// 不正な URL は無視して元の URL を使う
		}
	}

	// `Got.Response<string>` 形式に整形して返す。`scpaping` が見るのは
	// `rawBody` (encoding 検出) / `headers` (content-type) / `statusCode` / `url` で十分。
	return {
		body: cliResult.body,
		rawBody,
		headers: cliResult.headers,
		statusCode: cliResult.status,
		statusMessage: '',
		url: resolvedUrl,
		// `ip` は curl_cffi 経由のため取得不能 (proxy 経由と同じ扱い)
		ip: undefined,
	} as unknown as Got.Response<string>;
}

/**
 * `uv run fetch <url>` を spawn で起動し、stdout JSON をパースして返す。
 * timeoutMs を超えたら SIGKILL で強制終了する。テストで mock 可能なよう関数として export。
 */
export async function runCurlCffiCli(
	url: string,
	cfg: CurlCffiFallbackConfig,
	responseTimeoutSec: number,
	maxBytes: number,
): Promise<CurlCffiCliResponse> {
	const argv = [
		'run',
		'fetch',
		url,
		'--impersonate',
		cfg.impersonate,
		'--timeout',
		String(responseTimeoutSec),
		'--max-bytes',
		String(maxBytes),
	];

	const { stdout, exitCode } = await new Promise<{ stdout: string; exitCode: number | null }>((resolve, reject) => {
		const proc = spawn(cfg.uvPath, argv, {
			cwd: cfg.projectDir,
			stdio: ['ignore', 'pipe', 'pipe'],
			// shell: false (デフォルト) — argv が直接 execve される。shell injection 不可能
		});
		let stdoutBuf = '';
		// stderr は無視 (uv の warning 等が混入する可能性があるため stdout のみ JSON として扱う)
		proc.stdout.on('data', (chunk: Buffer) => {
			stdoutBuf += chunk.toString('utf8');
		});
		proc.stderr.on('data', () => { /* drop */ });

		// `error` と `exit` の両方が発火するケース (signal で終了した場合等) で
		// resolve/reject が二重に呼ばれないよう settle ガード (W-3 review feedback)。
		let settled = false;
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(killTimer);
			fn();
		};

		const killTimer = setTimeout(() => {
			proc.kill('SIGKILL');
			settle(() => reject(new Error(`curl_cffi spawn timeout (${cfg.timeoutMs}ms)`)));
		}, cfg.timeoutMs);

		proc.on('error', (err) => {
			// `spawn` 自体が失敗 (ENOENT for uv 等)。production で uv が未インストールなら
			// ここに到達する。呼出側で original error と差し替えられるよう error メッセージに含める。
			settle(() => reject(new Error(`curl_cffi spawn failed (${err.message}). uv が未インストールか、projectDir が間違っている可能性`)));
		});
		proc.on('exit', (code) => {
			settle(() => resolve({ stdout: stdoutBuf, exitCode: code }));
		});
	});

	if (stdout === '') {
		throw new Error(`curl_cffi: empty stdout (exit ${exitCode ?? '?'})`);
	}
	try {
		return JSON.parse(stdout) as CurlCffiCliResponse;
	} catch (e) {
		throw new Error(`curl_cffi: malformed JSON from CLI (exit ${exitCode ?? '?'}): ${e instanceof Error ? e.message : String(e)}`);
	}
}
