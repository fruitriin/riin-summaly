#!/usr/bin/env node
/**
 * 汎用 URL 取得チェックスクリプト。任意の URL を **複数経路** (direct / worker / curl_cffi)
 * で叩いて status / content-type / OGP / latency を比較表示する。phase18 hedge race の
 * 各 strategy をローカルから模擬する切り分けツール。
 *
 * 経路:
 *   - direct (got 相当):  指定 UA で直接 fetch (preset: summalybot / browser / facebook / twitter)
 *   - worker:             CF Workers proxy 経由 (HMAC 署名)、`SUMMALY_PROXY_URL` / `SUMMALY_PROXY_SECRET` 必須
 *   - curl_cffi:          `tools/curl-cffi-fetcher/` の uv を spawn、TLS フィンガープリント偽装
 *
 * `--via all` (default) で全経路実行 (direct は UA preset 4 種を全部試す)、結果を summary 表で比較。
 * 「どの経路で取れて、どの経路で 4xx/5xx/timeout になるか」が一目で分かる。
 *
 * ## env / .env
 *
 *     SUMMALY_PROXY_URL=https://summaly-proxy.<account>.workers.dev    # worker 経路で必要
 *     SUMMALY_PROXY_SECRET=<your-hmac-secret>                          # worker 経路で必要
 *
 * リポジトリルートの `.env` 自前 parse でフォールバック (`.env` は `.gitignore` 対象)。
 *
 * ## 使い方
 *
 *     # デフォルト: 全経路 (direct 4 UA + worker + curl_cffi) を順次実行
 *     node scripts/check-url-fetch.mjs https://www.monotaro.com/p/7281/1123/
 *
 *     # 経路を絞る
 *     node scripts/check-url-fetch.mjs <URL> --via worker
 *     node scripts/check-url-fetch.mjs <URL> --via curl_cffi
 *     node scripts/check-url-fetch.mjs <URL> --via direct --ua facebook
 *
 *     # 経路を複数指定 (カンマ区切り)
 *     node scripts/check-url-fetch.mjs <URL> --via direct,worker
 *
 *     # 詳細 body 出力 (デフォルトは抑制、OGP 抽出のみ)
 *     node scripts/check-url-fetch.mjs <URL> --body-bytes 800
 *
 * ## 経路詳細
 *
 *   - `direct`     UA preset: summalybot / browser / facebook / twitter (`--ua` で固定可)
 *   - `worker`     forward UA は `--ua` で指定 (default = summalybot)
 *   - `curl_cffi`  impersonate ターゲットは `chrome120` 固定 (将来 --impersonate 追加余地)
 *
 * ## 終了コード
 *
 *     0  = 全経路 2xx (or 単一経路 2xx)
 *     1  = 1 つ以上の経路が 5xx / fetch error
 *     2  = 引数不正 / env 未設定 / curl_cffi spawn 不可
 *     3  = 4xx あり (5xx は無し)
 */

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const _filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(_filename), '..');

// =============================================================================
// UA preset
// =============================================================================

const UA_PRESETS = {
	summalybot: 'Mozilla/5.0 (compatible; SummalyBot/check-url-fetch; +https://github.com/fruitriin/riin-summaly)',
	browser: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
	facebook: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
	twitter: 'Twitterbot/1.0',
	slack: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
	discord: 'Discordbot/2.0',
};
// alias 解決
const UA_ALIASES = { bot: 'summalybot', chrome: 'browser', fb: 'facebook', tw: 'twitter' };

const DIRECT_DEFAULT_UA_PRESETS = ['summalybot', 'browser', 'facebook', 'twitter'];

function resolveUa(uaArg) {
	if (uaArg == null) return null;
	const lower = uaArg.toLowerCase();
	const aliased = UA_ALIASES[lower] ?? lower;
	if (Object.prototype.hasOwnProperty.call(UA_PRESETS, aliased)) return UA_PRESETS[aliased];
	// preset でなければそのまま UA 文字列として使う
	return uaArg;
}

// =============================================================================
// .env loader (check-nitori-via-worker.mjs と同じ最小実装)
// =============================================================================

function loadDotEnvFallback() {
	const envPath = path.join(repoRoot, '.env');
	if (!fs.existsSync(envPath)) return;
	const raw = fs.readFileSync(envPath, 'utf8');
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === '' || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq < 1) continue;
		const key = trimmed.slice(0, eq).trim();
		if (process.env[key] !== undefined) continue;
		let value = trimmed.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"'))
			|| (value.startsWith('\'') && value.endsWith('\''))) {
			value = value.slice(1, -1);
		}
		process.env[key] = value;
	}
}

// =============================================================================
// CLI
// =============================================================================

const VALID_VIA = new Set(['direct', 'worker', 'curl_cffi', 'all']);

function parseArgs(argv) {
	const opts = {
		url: null,
		via: ['all'],
		ua: null,
		bodyBytes: 0,
		extract: true,
		timeoutMs: 20_000, // hard timeout (この時間で kill)
		softTimeoutMs: 10_000, // soft timeout (経過しても返ってきても「実用レベル外」マーク)
	};
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === '--via') {
			if (next == null) usageAndExit('--via には direct/worker/curl_cffi/all をカンマ区切りで指定');
			const list = next.split(',').map((s) => s.trim()).filter(Boolean);
			for (const v of list) if (!VALID_VIA.has(v)) usageAndExit(`--via に未知の経路: ${v}`);
			opts.via = list;
			i++;
		} else if (arg === '--ua') {
			if (next == null) usageAndExit('--ua には preset 名 (summalybot/browser/facebook/twitter/slack/discord) または UA 文字列を指定');
			opts.ua = next;
			i++;
		} else if (arg === '--body-bytes') {
			if (next == null) usageAndExit('--body-bytes には数値を指定');
			const n = Number(next);
			if (!Number.isFinite(n) || n < 0) usageAndExit('--body-bytes は 0 以上の数値で');
			opts.bodyBytes = n;
			i++;
		} else if (arg === '--no-extract') {
			opts.extract = false;
		} else if (arg === '--timeout') {
			if (next == null) usageAndExit('--timeout には ms を指定');
			const n = Number(next);
			if (!Number.isFinite(n) || n <= 0) usageAndExit('--timeout は正の数値で');
			opts.timeoutMs = n;
			i++;
		} else if (arg === '--soft-timeout') {
			if (next == null) usageAndExit('--soft-timeout には ms を指定');
			const n = Number(next);
			if (!Number.isFinite(n) || n <= 0) usageAndExit('--soft-timeout は正の数値で');
			opts.softTimeoutMs = n;
			i++;
		} else if (arg === '--help' || arg === '-h') {
			usageAndExit(null, 0);
		} else if (arg.startsWith('--')) {
			usageAndExit(`unknown option: ${arg}`);
		} else if (opts.url == null) {
			opts.url = arg;
		} else {
			usageAndExit(`複数の URL は指定できません (既に: ${opts.url}, 追加: ${arg})`);
		}
	}
	if (opts.url == null) usageAndExit('URL を指定してください (位置引数)');
	try {
		const u = new URL(opts.url);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') {
			usageAndExit(`URL の protocol は http(s) のみサポート (受信値: ${u.protocol})`);
		}
	} catch {
		usageAndExit(`URL parse 失敗: ${opts.url}`);
	}
	return opts;
}

function usageAndExit(msg, code = 2) {
	if (msg != null) process.stderr.write(`Error: ${msg}\n\n`);
	process.stderr.write(`Usage: node scripts/check-url-fetch.mjs <URL> [options]

Options:
  --via         <list>      経路: direct, worker, curl_cffi, all (カンマ区切り、default: all)
  --ua          <ua>        UA preset (summalybot/browser/facebook/twitter/slack/discord) または UA 文字列
                            direct + 単一指定で UA 固定 (未指定なら 4 preset 全部試す)
                            worker の forward UA / 任意経路の UA 固定にも使う
  --body-bytes  <n>         body 出力サイズ (default: 0 = 抑制、OGP 抽出のみ)
  --no-extract              OGP / <title> 抽出を skip
  --timeout       <ms>      1 経路あたりハードタイムアウト = この時間で kill (default: 20000ms)
  --soft-timeout  <ms>      ソフトタイムアウト = 200 で取れても elapsed >= soft なら「実用レベル外」(default: 10000ms)
  --help                    このヘルプを表示

env / .env:
  SUMMALY_PROXY_URL         worker 経路で必要
  SUMMALY_PROXY_SECRET      worker 経路で必要

経路詳細:
  direct      指定 UA で fetch。--ua なしなら summalybot/browser/facebook/twitter を全部試す
  worker      CF Workers proxy 経由 (HMAC 署名)。forward UA は --ua で指定 (default: summalybot)
  curl_cffi   tools/curl-cffi-fetcher/ の uv を spawn (chrome120 impersonate)
`);
	process.exit(code);
}

// =============================================================================
// 共通: OGP 抽出
// =============================================================================

function extractOgpAndTitle(body) {
	const tags = ['og:title', 'og:image', 'og:description', 'og:site_name'];
	const out = {};
	for (const tag of tags) {
		const re = new RegExp(`<meta[^>]+(?:property|name)=["']${escapeRegex(tag)}["'][^>]*content=["']([^"']*)["']`, 'i');
		const m = body.match(re);
		if (m != null) out[tag] = m[1];
	}
	const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/i);
	if (titleMatch != null) out['<title>'] = titleMatch[1];
	return out;
}

function escapeRegex(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// =============================================================================
// 経路: direct
// =============================================================================

async function fetchDirect(url, ua, timeoutMs) {
	const startedAt = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method: 'GET',
			redirect: 'follow',
			signal: controller.signal,
			headers: { 'user-agent': ua, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
		});
		const body = await res.text();
		return {
			ok: true,
			status: res.status,
			elapsed: Date.now() - startedAt,
			contentType: res.headers.get('content-type') ?? '',
			body,
			finalUrl: res.url,
		};
	} catch (e) {
		const elapsed = Date.now() - startedAt;
		const aborted = controller.signal.aborted;
		return {
			ok: false,
			status: null,
			elapsed,
			error: aborted ? `timeout (${timeoutMs}ms)` : (e instanceof Error ? e.message : String(e)),
		};
	} finally {
		clearTimeout(timer);
	}
}

// =============================================================================
// 経路: worker (CF Workers proxy)
// =============================================================================

async function fetchWorker(url, forwardUa, timeoutMs) {
	const WORKER_URL = process.env.SUMMALY_PROXY_URL;
	const SECRET = process.env.SUMMALY_PROXY_SECRET;
	if (WORKER_URL == null || WORKER_URL === '' || SECRET == null || SECRET === '') {
		return { ok: false, status: null, elapsed: 0, error: 'env 未設定: SUMMALY_PROXY_URL / SUMMALY_PROXY_SECRET' };
	}
	const ts = Date.now();
	const message = `${url}\n${ts}`;
	const sig = crypto.createHmac('sha256', SECRET).update(message).digest('hex');
	const proxyUrl = `${WORKER_URL.replace(/\/$/, '')}/?url=${encodeURIComponent(url)}`;

	const startedAt = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(proxyUrl, {
			method: 'GET',
			signal: controller.signal,
			headers: {
				'x-summaly-sig': sig,
				'x-summaly-ts': String(ts),
				'x-summaly-forward-ua': forwardUa,
			},
		});
		const body = await res.text();
		return {
			ok: true,
			status: res.status,
			elapsed: Date.now() - startedAt,
			contentType: res.headers.get('content-type') ?? '',
			body,
			finalUrl: res.headers.get('x-summaly-final-url') ?? url,
		};
	} catch (e) {
		const elapsed = Date.now() - startedAt;
		const aborted = controller.signal.aborted;
		return {
			ok: false,
			status: null,
			elapsed,
			error: aborted ? `timeout (${timeoutMs}ms)` : (e instanceof Error ? e.message : String(e)),
		};
	} finally {
		clearTimeout(timer);
	}
}

// =============================================================================
// 経路: curl_cffi (tools/curl-cffi-fetcher の uv spawn)
// =============================================================================

async function fetchCurlCffi(url, timeoutMs) {
	const projectDir = path.join(repoRoot, 'tools', 'curl-cffi-fetcher');
	if (!fs.existsSync(projectDir)) {
		return { ok: false, status: null, elapsed: 0, error: `tools/curl-cffi-fetcher が無い (${projectDir})` };
	}
	const startedAt = Date.now();
	const argv = ['run', 'fetch', url, '--impersonate', 'chrome120'];

	return new Promise((resolve) => {
		let proc;
		try {
			proc = spawn('uv', argv, { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] });
		} catch (e) {
			resolve({ ok: false, status: null, elapsed: Date.now() - startedAt, error: `spawn failed: ${e instanceof Error ? e.message : String(e)}` });
			return;
		}
		let settled = false;
		const settle = (val) => { if (settled) return; settled = true; clearTimeout(killTimer); resolve(val); };
		const killTimer = setTimeout(() => {
			proc.kill('SIGKILL');
			settle({ ok: false, status: null, elapsed: Date.now() - startedAt, error: `timeout (${timeoutMs}ms)` });
		}, timeoutMs);

		let stdoutBuf = '';
		proc.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString('utf8'); });
		proc.stderr.on('data', () => { /* drop */ });
		proc.on('error', (err) => {
			settle({ ok: false, status: null, elapsed: Date.now() - startedAt, error: `spawn error: ${err.message} (uv が PATH にあるか確認)` });
		});
		proc.on('exit', () => {
			const elapsed = Date.now() - startedAt;
			let parsed;
			try {
				parsed = JSON.parse(stdoutBuf);
			} catch {
				settle({ ok: false, status: null, elapsed, error: `JSON parse 失敗: ${stdoutBuf.slice(0, 200)}` });
				return;
			}
			if ('error' in parsed) {
				settle({ ok: false, status: null, elapsed, error: `curl_cffi error (${parsed.category}): ${parsed.error}` });
				return;
			}
			settle({
				ok: true,
				status: parsed.status,
				elapsed,
				contentType: parsed.content_type ?? '',
				body: parsed.body ?? '',
				finalUrl: parsed.final_url ?? url,
			});
		});
	});
}

// =============================================================================
// 出力フォーマット
// =============================================================================

function colorize(text, color) {
	const colors = { red: 31, green: 32, yellow: 33, cyan: 36, gray: 90, magenta: 35 };
	if (!process.stdout.isTTY) return text;
	const code = colors[color];
	return code != null ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function statusBadge(status) {
	if (status == null) return colorize('ERR', 'red');
	if (status >= 200 && status < 300) return colorize(`${status}`, 'green');
	if (status >= 400 && status < 500) return colorize(`${status}`, 'yellow');
	return colorize(`${status}`, 'red');
}

/**
 * 「実用レベル」判定: status が 2xx かつ elapsed が softTimeoutMs 未満なら true。
 * 200 で取れていてもソフトタイムアウト超過は「実用レベル外」扱い。
 */
function isPracticallyUsable(result, softTimeoutMs) {
	if (!result.ok || result.status == null) return false;
	if (result.status < 200 || result.status >= 300) return false;
	if (result.elapsed >= softTimeoutMs) return false;
	return true;
}

function printResult(label, result, opts) {
	process.stdout.write(`\n=== ${colorize(label, 'cyan')} ===\n`);
	if (!result.ok) {
		process.stdout.write(`  ${statusBadge(null)} elapsed=${result.elapsed}ms\n`);
		process.stdout.write(`  ${colorize('error:', 'red')} ${result.error}\n`);
		return;
	}
	const slow = result.elapsed >= opts.softTimeoutMs;
	const slowTag = slow ? ` ${colorize(`SLOW (>=${opts.softTimeoutMs}ms 実用レベル外)`, 'yellow')}` : '';
	process.stdout.write(`  ${statusBadge(result.status)} elapsed=${result.elapsed}ms${slowTag} ct=${result.contentType || '(missing)'} size=${result.body.length}\n`);
	if (result.finalUrl != null && result.finalUrl !== '' && result.finalUrl !== opts.url) {
		process.stdout.write(`  final-url: ${result.finalUrl}\n`);
	}
	if (opts.bodyBytes > 0) {
		process.stdout.write(`  --- body (first ${opts.bodyBytes} bytes) ---\n`);
		const slice = result.body.slice(0, opts.bodyBytes);
		process.stdout.write(`  ${slice.split('\n').join('\n  ')}\n`);
	}
	if (opts.extract && result.status != null && result.status >= 200 && result.status < 300) {
		const tags = extractOgpAndTitle(result.body);
		const keys = Object.keys(tags);
		if (keys.length === 0) {
			process.stdout.write(`  ${colorize('OGP:', 'gray')} (none extracted)\n`);
		} else {
			for (const k of keys) {
				const v = tags[k];
				const truncated = v.length > 100 ? v.slice(0, 100) + '...' : v;
				process.stdout.write(`  ${colorize(k.padEnd(16), 'magenta')} ${truncated}\n`);
			}
		}
	}
}

function printSummary(results, opts) {
	process.stdout.write(`\n=== ${colorize('summary', 'cyan')} (soft timeout ${opts.softTimeoutMs}ms / hard ${opts.timeoutMs}ms) ===\n`);
	const rows = [];
	for (const { label, result } of results) {
		const usable = isPracticallyUsable(result, opts.softTimeoutMs);
		const status = result.ok ? String(result.status) : 'ERR';
		const slow = result.ok && result.elapsed >= opts.softTimeoutMs;
		const ogpStatus = result.ok && result.status != null && result.status >= 200 && result.status < 300
			? (Object.keys(extractOgpAndTitle(result.body)).length > 0 ? 'OGP ✓' : 'OGP ✗')
			: '-';
		const verdict = usable ? colorize('USABLE', 'green') : (slow ? colorize('SLOW', 'yellow') : colorize('UNUSABLE', 'red'));
		rows.push({
			label,
			status,
			elapsed: `${result.elapsed}ms`,
			ogp: ogpStatus,
			verdict,
		});
	}
	const labelW = Math.max(...rows.map((r) => r.label.length), 'route'.length);
	const statusW = Math.max(...rows.map((r) => r.status.length), 'status'.length);
	const elapsedW = Math.max(...rows.map((r) => r.elapsed.length), 'elapsed'.length);
	const ogpW = Math.max(...rows.map((r) => r.ogp.length), 'ogp'.length);
	process.stdout.write(`  ${'route'.padEnd(labelW)}  ${'status'.padEnd(statusW)}  ${'elapsed'.padEnd(elapsedW)}  ${'ogp'.padEnd(ogpW)}  verdict\n`);
	process.stdout.write(`  ${'-'.repeat(labelW)}  ${'-'.repeat(statusW)}  ${'-'.repeat(elapsedW)}  ${'-'.repeat(ogpW)}  -------\n`);
	for (const r of rows) {
		process.stdout.write(`  ${r.label.padEnd(labelW)}  ${r.status.padEnd(statusW)}  ${r.elapsed.padEnd(elapsedW)}  ${r.ogp.padEnd(ogpW)}  ${r.verdict}\n`);
	}
}

// =============================================================================
// main
// =============================================================================

async function main() {
	loadDotEnvFallback();
	const opts = parseArgs(process.argv);
	const expanded = opts.via.includes('all') ? ['direct', 'worker', 'curl_cffi'] : opts.via;

	process.stdout.write(`target: ${opts.url}\n`);
	process.stdout.write(`via:    ${expanded.join(', ')}\n`);

	const results = [];

	for (const via of expanded) {
		if (via === 'direct') {
			const uaPresets = opts.ua != null ? [opts.ua] : DIRECT_DEFAULT_UA_PRESETS;
			for (const uaKey of uaPresets) {
				const ua = resolveUa(uaKey);
				if (ua == null || ua === '') continue;
				const label = `direct + ${uaKey}`;
				const result = await fetchDirect(opts.url, ua, opts.timeoutMs);
				printResult(label, result, opts);
				results.push({ label, result });
			}
		} else if (via === 'worker') {
			const ua = resolveUa(opts.ua) ?? UA_PRESETS.summalybot;
			const result = await fetchWorker(opts.url, ua, opts.timeoutMs);
			printResult('worker (CF proxy)', result, opts);
			results.push({ label: 'worker (CF proxy)', result });
		} else if (via === 'curl_cffi') {
			const result = await fetchCurlCffi(opts.url, opts.timeoutMs);
			printResult('curl_cffi (chrome120)', result, opts);
			results.push({ label: 'curl_cffi (chrome120)', result });
		}
	}

	if (results.length > 1) printSummary(results, opts);

	// 終了コード: 1 つでも実用レベル経路があれば 0 (= 救援可能)、無ければ 1
	const anyUsable = results.some(({ result }) => isPracticallyUsable(result, opts.softTimeoutMs));
	if (anyUsable) process.exit(0);
	const has5xxOrError = results.some(({ result }) => !result.ok || (result.status != null && result.status >= 500));
	if (has5xxOrError) process.exit(1);
	process.exit(3);
}

main().catch((err) => {
	process.stderr.write(`Unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
	process.exit(1);
});
