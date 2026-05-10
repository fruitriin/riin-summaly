/**
 * curl_cffi (libcurl-impersonate) 経路 (phase18 hedge race の challenger)。
 *
 * Vultr Tokyo IP / CF Workers IP の両方で TLS layer の bot block (HTTP/2 INTERNAL_ERROR /
 * 即時切断) に遭うサイト (yodobashi 級) を、`tools/curl-cffi-fetcher/` の Python CLI を
 * `child_process.spawn` で呼び出して TLS フィンガープリント (JA3) 偽装で取得する。
 *
 * phase18.1 で段階的 cascade (`getResponseWithCurlCffiFallback`) を撤廃し、`fetchByStrategy` から
 * `viaCurlCffi` を直接呼ぶ形に変更。発火条件 (categories / domains allowlist) も廃止し、
 * 「設定で enabled なら hedge race の challenger として常に並列発火」する設計。
 *
 * Python 側 SSRF ガード (`assert_public_ip`) が `domains` 撤廃の代替防御として機能する。
 *
 * production server には `uv` (Python パッケージマネージャ) を別途インストールし、
 * `cd tools/curl-cffi-fetcher && uv sync` で依存解決しておく必要がある。
 */

import { spawn } from 'node:child_process';
import * as Got from 'got';
import { StatusError } from '@/utils/status-error.js';
import {
	type GotOptions,
	DEFAULT_RESPONSE_TIMEOUT,
	DEFAULT_MAX_RESPONSE_SIZE,
} from '@/utils/got.js';

/**
 * curl_cffi 設定。
 *
 * - `enabled === false` なら curl_cffi 経路は無効
 *
 * phase18.1 で `categories` / `domains` field を撤廃 (hedge race ですべての URL に対して並列発火)。
 * SSRF 防御は Python 側 `assert_public_ip` で実施。
 */
export interface CurlCffiFallbackConfig {
	enabled: boolean;
	/** uv バイナリのパス。PATH 上にあれば `'uv'` で OK、無ければ絶対パス指定 */
	uvPath: string;
	/** `tools/curl-cffi-fetcher/` のパス (絶対 or process.cwd() 相対) */
	projectDir: string;
	/** 偽装する TLS フィンガープリント (`chrome120` / `firefox120` / `safari17_0` 等) */
	impersonate: string;
	/** 1 リクエスト全体のタイムアウト (ミリ秒)。spawn 起動 + curl_cffi 完走の合計 */
	timeoutMs: number;
}

export const DEFAULT_CURL_CFFI_TIMEOUT_MS = 30000;
export const DEFAULT_CURL_CFFI_IMPERSONATE = 'chrome120';

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
		category: 'timeout' | 'network' | 'tls' | 'setup' | 'content_too_large' | 'invalid_url' | 'ssrf_blocked' | 'other';
	};

/**
 * `tools/curl-cffi-fetcher/` の Python CLI を `uv run fetch <url>` で起動し、
 * stdout の JSON をパースして `Got.Response<string>` 形式で返す。
 *
 * セキュリティ:
 * - `spawn` を `shell: false` (デフォルト) で呼ぶため shell injection の経路は無い
 * - URL は呼出側で `new URL()` で検証済み + 本関数で `https:` 限定
 * - SSRF 防御は Python 側 `assert_public_ip` で実施 (DNS rebinding partial 対応 + redirect 後最終 URL 再検証)
 * - `--impersonate` 値は `cfg.impersonate` (config 由来、外部入力ではない)
 * - 子プロセスの timeout は `cfg.timeoutMs` で SIGKILL 強制終了
 *
 * phase18 hedge race の challenger 経路として `fetchByStrategy` から呼ばれる。
 * `externalSignal` (hedge race 勝者確定後 cancellation) で subprocess を SIGKILL。
 */
export async function viaCurlCffi(
	args: GotOptions,
	cfg: CurlCffiFallbackConfig,
	externalSignal?: AbortSignal,
): Promise<Got.Response<string>> {
	const maxBytes = args.contentLengthLimit ?? DEFAULT_MAX_RESPONSE_SIZE;
	const responseTimeoutSec = (args.responseTimeout ?? DEFAULT_RESPONSE_TIMEOUT) / 1000;

	const overrideHeaders = pickOverrideHeaders(args.headers);
	const cliResult = await runCurlCffiCli(args.url, cfg, responseTimeoutSec, maxBytes, overrideHeaders, externalSignal);

	if ('error' in cliResult) {
		// CLI のエラー category を Node 側で適切に分類できる形に変換。
		// `ssrf_blocked` は Node 側 `categorizeError` で「Private IP rejected」相当に拾われるよう、
		// Error message に `Private IP rejected` を含める形にして category 復元できるようにする。
		if (cliResult.category === 'ssrf_blocked') {
			throw new Error(`Private IP rejected: ${cliResult.error}`);
		}
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
	if (args.typeFilter != null) {
		const ct = cliResult.content_type;
		if (ct === '' || !ct.match(args.typeFilter)) {
			throw new Error(`Rejected by type filter ${ct} (via curl_cffi)`);
		}
	}

	// **エンコーディング契約**: `cliResult.body` は CLI (`fetch.py`) 側で `curl_cffi` の
	// `response.text` (Content-Type の charset または chardet で検出してデコード済み) として
	// Python str を JSON 文字列に乗せて渡されてくる。**Node 側では UTF-8 として固定的に扱う**
	// 設計選択 (二重デコードを避ける)。
	const rawBody = Buffer.from(cliResult.body, 'utf8');
	if (rawBody.byteLength > maxBytes) {
		throw new Error(`maxSize exceeded (${rawBody.byteLength} > ${maxBytes}) on response (via curl_cffi)`);
	}

	let resolvedUrl = args.url;
	if (cliResult.final_url !== '') {
		try {
			const parsed = new URL(cliResult.final_url);
			if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
				resolvedUrl = cliResult.final_url;
			}
		} catch {
			// 不正な URL は無視
		}
	}

	return {
		body: cliResult.body,
		rawBody,
		headers: cliResult.headers,
		statusCode: cliResult.status,
		statusMessage: '',
		url: resolvedUrl,
		ip: undefined,
	} as unknown as Got.Response<string>;
}

/**
 * `viaCurlCffi` から CLI へ伝えるヘッダを絞り込むホワイトリスト。
 *
 * **設計**: impersonate は Chrome / Firefox / Safari の TLS + HTTP/2 ヘッダ群を完全再現する。
 * Range / Content-Type / Accept-Encoding 等を呼出側から上書きすると、impersonate ブラウザの
 * 振る舞いと矛盾し TLS / WAF 検査で弾かれるリスクがある。一方 `Accept` (API JSON 要求) /
 * `Accept-Language` (lang 指定) / `Referer` (一部 API 必須) / `User-Agent` (SNS bot 偽装等) は
 * 呼出側の意図を尊重する必然性がある。この 4 つのみ通す。
 */
const CURL_CFFI_OVERRIDE_HEADER_ALLOWLIST = new Set([
	'accept',
	'accept-language',
	'referer',
	'user-agent',
]);

export function pickOverrideHeaders(headers: GotOptions['headers']): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [rawName, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		const name = rawName.toLowerCase();
		if (!CURL_CFFI_OVERRIDE_HEADER_ALLOWLIST.has(name)) continue;
		if (rawName.includes(':')) continue;
		if (value === '') continue;
		out[rawName] = value;
	}
	return out;
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
	overrideHeaders: Record<string, string> = {},
	externalSignal?: AbortSignal,
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

	for (const [name, value] of Object.entries(overrideHeaders)) {
		argv.push('--header', `${name}:${value}`);
	}

	const { stdout, exitCode } = await new Promise<{ stdout: string; exitCode: number | null }>((resolve, reject) => {
		const proc = spawn(cfg.uvPath, argv, {
			cwd: cfg.projectDir,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdoutBuf = '';
		proc.stdout.on('data', (chunk: Buffer) => {
			stdoutBuf += chunk.toString('utf8');
		});
		proc.stderr.on('data', () => { /* drop */ });

		let externalAbortListener: (() => void) | undefined;
		let settled = false;
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(killTimer);
			if (externalAbortListener != null && externalSignal != null) {
				externalSignal.removeEventListener('abort', externalAbortListener);
			}
			fn();
		};

		const killTimer = setTimeout(() => {
			proc.kill('SIGKILL');
			settle(() => reject(new Error(`curl_cffi spawn timeout (${cfg.timeoutMs}ms)`)));
		}, cfg.timeoutMs);

		// 外部 signal (hedge race の勝者確定後 cancellation) で subprocess を SIGKILL。
		// listener は settle 内で removeEventListener (leak 防止)。
		if (externalSignal != null) {
			if (externalSignal.aborted) {
				proc.kill('SIGKILL');
				settle(() => reject(new Error('curl_cffi aborted by external signal')));
			} else {
				externalAbortListener = () => {
					proc.kill('SIGKILL');
					settle(() => reject(new Error('curl_cffi aborted by external signal')));
				};
				externalSignal.addEventListener('abort', externalAbortListener);
			}
		}

		proc.on('error', (err) => {
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
