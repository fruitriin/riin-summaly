#!/usr/bin/env node
/**
 * phase18 E2E 動作確認シナリオ。本番デプロイ後の summaly が複数の代表サイトで preview を
 * 取れるかを一括チェックする。各サイトに「期待する title 部分文字列」「thumbnail 必須かどうか」
 * 等の assertion を仕込んでおき、結果を pass/fail で表示。
 *
 * 実行前に `/v` エンドポイントを叩いて「いま動いているのは何のバージョン (commit / message) か」を
 * 表示する (アサーションには使わない、人間が現状把握するための情報)。
 *
 * ## base URL の決定順 (上が優先)
 *
 *     1) CLI 引数 `--base <url>`
 *     2) 環境変数 `SUMMALY_E2E_BASE_URL`
 *     3) リポジトリルートの `.env` の `SUMMALY_E2E_BASE_URL=...`
 *
 * いずれも未設定なら起動失敗。誤って public な本番 URL を hard-code しないため、デフォルト値は持たない。
 *
 * ## .env 例
 *
 *     SUMMALY_E2E_BASE_URL=https://summaly.example.com/
 *
 * `.env` は `.gitignore` 対象なので、各開発者・運用者環境ごとに置く想定。
 *
 * ## 使い方
 *
 *     # `.env` または env 変数経由で base 指定済みなら引数なしで実行可
 *     node scripts/e2e-preview-check.mjs
 *
 *     # base を CLI で override (env / .env より優先)
 *     node scripts/e2e-preview-check.mjs --base http://127.0.0.1:3000/
 *
 *     # cache buster を固定 (デバッグ時に同じ JSON を比較したい等)
 *     node scripts/e2e-preview-check.mjs --buster t1
 *
 *     # 特定シナリオだけ実行 (カンマ区切り、scenario の name で指定)
 *     node scripts/e2e-preview-check.mjs --only monotaro,yodobashi
 *
 *     # 1 シナリオあたりのタイムアウト変更 (ms、デフォルト 60000)
 *     node scripts/e2e-preview-check.mjs --timeout 90000
 *
 *     # /v を叩く版を skip (デプロイ確認エンドポイントが無い別環境向け)
 *     node scripts/e2e-preview-check.mjs --skip-version
 *
 * ## 終了コード
 *
 *     0  = 全シナリオ pass
 *     1  = 1 つ以上 fail
 *     2  = 引数不正 / base 未設定
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const _filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(_filename), '..');

const DEFAULT_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 10_000;

// =============================================================================
// シナリオ定義
// =============================================================================

/**
 * 各シナリオは以下のフィールドを持つ:
 *
 * - name:        識別子 (--only で絞り込み可能)
 * - url:         summaly に投げる対象 URL
 * - notes:       fail mode 分類や hedge race の期待動作 (人間向けメモ)
 * - assertions:  検証関数群 (response JSON を受け取り、エラー文字列か null を返す)
 *
 * `assertions` 各要素は `(json) => string | null` シグネチャ。null なら pass、
 * 文字列なら fail 理由として表示。
 */
const SCENARIOS = [
	{
		name: 'monotaro',
		url: 'https://www.monotaro.com/p/7281/1123/',
		// phase18.1 で fail mode J 確定 (2026-05-10)。datacenter IP 全般 (Vultr / CF AS13335) を
		// monotaro 側で TLS layer block。curl_cffi の TLS 偽装も IP 層で別途切断される
		// (本番ログ: HTTP/2 stream INTERNAL_ERROR)。家庭 IP なら curl_cffi で取れるが、
		// 本番デプロイ環境 (datacenter) では救援不可。詳細は docs/knowhow/spa-dynamic-ogp-unfixable.md。
		notes: 'fail mode J (datacenter IP 全般 block、ニトリと同型)。本番では救援不可、UNUSABLE 期待',
		expectedUnusable: true,
		assertions: [], // 救援不可なので assertion なし (200 が返ったらむしろサプライズ)
	},
	{
		name: 'yodobashi',
		url: 'https://www.yodobashi.com/product/100000001005025148/',
		notes: 'fail mode H。bootstrap entry で curl_cffi 直行。yodobashi プラグインで skipRedirectResolution',
		assertions: [
			titleNotEmpty(),
			titleContains(['ヨドバシ', 'Yodobashi']),
		],
	},
	{
		name: 'amazon',
		url: 'https://www.amazon.co.jp/dp/B0BX1TYH98/',
		notes: 'fail mode B (IP レピュテーション)。proxy 経路で hedge race 救援',
		assertions: [
			titleNotEmpty(),
			hasThumbnail(),
		],
	},
	{
		name: 'sqex',
		url: 'https://store.jp.square-enix.com/category/feature/9000_kaku.html',
		notes: 'fail mode B\' (datacenter IP block + 200+正規 404 ページボディ、エラーシグナルなし)。proxy 経路で hedge race 救援',
		assertions: [
			titleNotEmpty(),
			titleNotContains('404 NOT FOUND'),
		],
	},
	{
		name: 'nintendo-store',
		url: 'https://store-jp.nintendo.com/list/software/70010000038900.html',
		notes: 'fail mode G (Akamai Bot Manager + facebookexternalhit allowlist)。プラグインで UA 固定 (fallback_ua 経路相当)',
		assertions: [
			titleNotEmpty(),
			titleContains(['Nintendo', 'ニンテンドー']),
		],
	},
	{
		name: 'youtube',
		url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
		notes: 'oEmbed 経由。default UA で即勝ち、hedge fire しない (定常状態)',
		assertions: [
			titleNotEmpty(),
			hasThumbnail(),
			hasPlayer(),
		],
	},
	{
		name: 'wikipedia',
		url: 'https://ja.wikipedia.org/wiki/HTTP',
		notes: 'wikipedia プラグインの MediaWiki API 経由。default UA で即勝ち',
		assertions: [
			titleContains(['HTTP', 'Hypertext']),
			descriptionNotEmpty(),
		],
	},
	{
		name: 'npmjs',
		url: 'https://www.npmjs.com/package/got',
		notes: 'fail mode F (Cloudflare Bot Management)。npmjs プラグインで registry.npmjs.org 直叩き',
		assertions: [
			titleNotEmpty(),
			sitenameContains('npm'),
		],
	},
	{
		name: 'bluesky',
		url: 'https://bsky.app/profile/bsky.app',
		notes: 'bluesky プラグイン。HEAD だと 404、GET 限定経路',
		assertions: [
			titleNotEmpty(),
		],
	},
	{
		name: 'github',
		url: 'https://github.com/fruitriin/riin-summaly',
		notes: '汎用パス (default UA で即勝ち、hedge fire しない)',
		assertions: [
			titleContains(['summaly', 'GitHub']),
			hasThumbnail(),
		],
	},
];

// =============================================================================
// アサーション・ヘルパー
// =============================================================================

function titleContains(needles) {
	return (json) => {
		const t = json?.title;
		if (typeof t !== 'string' || t.length === 0) return `title が空 (受信値: ${JSON.stringify(t)})`;
		const ok = needles.some((n) => t.toLowerCase().includes(n.toLowerCase()));
		return ok ? null : `title が ${JSON.stringify(needles)} のいずれも含まない (受信値: ${JSON.stringify(t.slice(0, 100))})`;
	};
}

function titleNotEmpty() {
	return (json) => {
		const t = json?.title;
		if (typeof t !== 'string' || t.trim().length === 0) return `title が空 (受信値: ${JSON.stringify(t)})`;
		return null;
	};
}

function titleNotContains(needle) {
	return (json) => {
		const t = json?.title;
		if (typeof t !== 'string') return null;
		if (t.toLowerCase().includes(needle.toLowerCase())) return `title に ${JSON.stringify(needle)} が含まれている (= preview HTML 詐欺の疑い、受信値: ${JSON.stringify(t.slice(0, 100))})`;
		return null;
	};
}

function descriptionNotEmpty() {
	return (json) => {
		const d = json?.description;
		if (typeof d !== 'string' || d.trim().length === 0) return `description が空 (受信値: ${JSON.stringify(d)})`;
		return null;
	};
}

function hasThumbnail() {
	return (json) => {
		const u = json?.thumbnail;
		if (typeof u !== 'string' || u.length === 0) return `thumbnail が無い (受信値: ${JSON.stringify(u)})`;
		try {
			const parsed = new URL(u);
			if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return `thumbnail URL の protocol が不正 (${parsed.protocol})`;
		} catch {
			return `thumbnail が valid URL でない (受信値: ${JSON.stringify(u.slice(0, 100))})`;
		}
		return null;
	};
}

function sitenameContains(needle) {
	return (json) => {
		const s = json?.sitename;
		if (typeof s !== 'string' || s.length === 0) return `sitename が空 (受信値: ${JSON.stringify(s)})`;
		if (!s.toLowerCase().includes(needle.toLowerCase())) return `sitename に ${JSON.stringify(needle)} が含まれない (受信値: ${JSON.stringify(s)})`;
		return null;
	};
}

function hasPlayer() {
	return (json) => {
		const p = json?.player;
		if (p == null || typeof p !== 'object') return 'player が無い';
		if (typeof p.url !== 'string' || p.url.length === 0) return `player.url が無い (受信値: ${JSON.stringify(p)})`;
		return null;
	};
}

// =============================================================================
// CLI 引数パース
// =============================================================================

/**
 * リポジトリルートの `.env` を最小限自前 parse して `process.env` に載せる (未設定キーのみ)。
 * `KEY=value` / `KEY="value"` / `KEY='value'` 形式に対応、`#` 行頭コメント無視。
 * `check-nitori-via-worker.mjs` と同じパターン。
 */
function loadDotEnvIfPresent() {
	const envPath = path.join(repoRoot, '.env');
	let text;
	try {
		text = fs.readFileSync(envPath, 'utf8');
	} catch {
		return;
	}
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (line === '' || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
			value = value.slice(1, -1);
		}
		if (process.env[key] === undefined) process.env[key] = value;
	}
}

function parseArgs(argv) {
	const opts = {
		base: undefined,
		buster: String(Date.now()),
		only: null,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		skipVersion: false,
	};
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === '--base') {
			if (next == null) usageAndExit('--base には URL を指定してください');
			opts.base = next;
			i++;
		} else if (arg === '--buster') {
			if (next == null) usageAndExit('--buster には文字列を指定してください');
			opts.buster = next;
			i++;
		} else if (arg === '--only') {
			if (next == null) usageAndExit('--only にはカンマ区切り名前を指定してください');
			opts.only = new Set(next.split(',').map((s) => s.trim()).filter(Boolean));
			i++;
		} else if (arg === '--timeout') {
			if (next == null) usageAndExit('--timeout には ms を指定してください');
			const n = Number(next);
			if (!Number.isFinite(n) || n <= 0) usageAndExit('--timeout は正の数値で');
			opts.timeoutMs = n;
			i++;
		} else if (arg === '--skip-version') {
			opts.skipVersion = true;
		} else if (arg === '--help' || arg === '-h') {
			usageAndExit(null, 0);
		} else {
			usageAndExit(`unknown argument: ${arg}`);
		}
	}
	return opts;
}

/**
 * base URL を CLI 引数 → 環境変数 → .env の順で解決する。
 * 誤って public な本番 URL を hard-code しないため、いずれも未設定なら起動失敗。
 */
function resolveBaseUrl(cliBase) {
	if (cliBase != null && cliBase !== '') return cliBase;
	const envBase = process.env.SUMMALY_E2E_BASE_URL;
	if (envBase != null && envBase !== '') return envBase;
	usageAndExit(
		'base URL が未指定です。--base <url> を渡すか、リポジトリルートの .env に '
		+ 'SUMMALY_E2E_BASE_URL=https://your.summaly/ を書いてください',
	);
}

function usageAndExit(msg, code = 2) {
	if (msg != null) process.stderr.write(`Error: ${msg}\n\n`);
	process.stderr.write(`Usage: node scripts/e2e-preview-check.mjs [options]

Options:
  --base    <url>      summaly base URL (env SUMMALY_E2E_BASE_URL or .env からも読む、CLI 優先)
  --buster  <str>      cache buster value for ?t= (default: epoch ms)
  --only    <names>    シナリオを名前で絞り込み (カンマ区切り)
  --timeout <ms>       1 シナリオあたりのタイムアウト (default: ${DEFAULT_TIMEOUT_MS}ms)
  --skip-version       /v エンドポイント取得を skip
  --help               このヘルプを表示

base URL は CLI > env > .env の順で解決。いずれも未設定なら起動失敗 (本番 URL を
hard-code しないため)。
`);
	process.exit(code);
}

/**
 * `/v` エンドポイントを叩いてデプロイされている version / commit / message を表示。
 * 失敗しても assertion 扱いにはせず、stderr に warning を出すだけで継続する
 * (古いバージョンが動いている / `/v` 未実装の環境もあり得る)。
 */
async function fetchAndPrintVersion(baseUrl) {
	const versionUrl = (baseUrl.endsWith('/') ? baseUrl : baseUrl + '/') + 'v';
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), VERSION_TIMEOUT_MS);
	try {
		const res = await fetch(versionUrl, {
			signal: controller.signal,
			headers: { accept: 'application/json' },
		});
		const text = await res.text();
		if (res.status !== 200) {
			process.stdout.write(`  ${colorize('!', 'yellow')} /v returned HTTP ${res.status}: ${text.slice(0, 200)}\n`);
			return;
		}
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			process.stdout.write(`  ${colorize('!', 'yellow')} /v returned non-JSON: ${text.slice(0, 200)}\n`);
			return;
		}
		const version = json?.version ?? '(unknown)';
		const commit = typeof json?.commit === 'string' ? json.commit.slice(0, 12) : '(unknown)';
		const message = typeof json?.message === 'string' ? json.message.split('\n')[0].slice(0, 80) : '(unknown)';
		process.stdout.write(`  ${colorize('deployed', 'cyan')}: v${version} @ ${commit}\n`);
		process.stdout.write(`  ${colorize('commit msg', 'gray')}: ${message}\n`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stdout.write(`  ${colorize('!', 'yellow')} /v fetch failed: ${msg}\n`);
	} finally {
		clearTimeout(timer);
	}
}

// =============================================================================
// 本体
// =============================================================================

/**
 * 1 シナリオを実行して結果を返す。
 *
 * @returns {Promise<{name: string, status: 'pass' | 'fail', errors: string[], httpStatus: number | null, latencyMs: number, json: unknown}>}
 */
async function runScenario(scenario, baseUrl, buster, timeoutMs) {
	const summalyUrl = buildSummalyUrl(baseUrl, scenario.url, buster);
	const startedAt = Date.now();
	const errors = [];
	let httpStatus = null;
	let json = null;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(summalyUrl, {
			signal: controller.signal,
			headers: { accept: 'application/json' },
		});
		httpStatus = res.status;
		const text = await res.text();
		try {
			json = JSON.parse(text);
		} catch {
			errors.push(`JSON parse failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
		}
		if (res.status !== 200) {
			errors.push(`HTTP status ${res.status} (期待: 200)`);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		errors.push(`fetch failed: ${msg}`);
	} finally {
		clearTimeout(timer);
	}

	const latencyMs = Date.now() - startedAt;

	if (json != null) {
		for (const assert of scenario.assertions) {
			const failure = assert(json);
			if (failure != null) errors.push(failure);
		}
	}

	// `expectedUnusable: true` のシナリオは「救援不可」期待 (= 5xx / error が正常)。
	// 200 が返ったらむしろ環境改善のサプライズとして扱い、fail にする (期待値の見直しを促す)。
	if (scenario.expectedUnusable === true) {
		const errorsBackup = [...errors];
		errors.length = 0;
		if (httpStatus !== null && httpStatus >= 200 && httpStatus < 300) {
			errors.push('expectedUnusable シナリオが 200 を返した (環境改善か、scenarios の expectedUnusable 見直し検討)');
		}
		// それ以外は assertion 結果を捨てて pass 扱い (5xx / error は期待通り)
		void errorsBackup;
	}

	return {
		name: scenario.name,
		status: errors.length === 0 ? 'pass' : 'fail',
		errors,
		httpStatus,
		latencyMs,
		json,
	};
}

function buildSummalyUrl(baseUrl, targetUrl, buster) {
	const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
	const params = new URLSearchParams();
	params.set('t', buster);
	params.set('url', targetUrl);
	return base + '?' + params.toString();
}

function colorize(text, color) {
	const colors = { red: 31, green: 32, yellow: 33, cyan: 36, gray: 90 };
	if (!process.stdout.isTTY) return text;
	const code = colors[color];
	return code != null ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function fmtPass() { return colorize('PASS', 'green'); }

function fmtFail() { return colorize('FAIL', 'red'); }

async function main() {
	loadDotEnvIfPresent();
	const opts = parseArgs(process.argv);
	const baseUrl = resolveBaseUrl(opts.base);

	const scenarios = opts.only == null
		? SCENARIOS
		: SCENARIOS.filter((s) => opts.only.has(s.name));

	if (scenarios.length === 0) {
		const known = SCENARIOS.map((s) => s.name).join(', ');
		usageAndExit(`--only に該当するシナリオがありません。指定可能: ${known}`);
	}

	process.stdout.write(`Running ${scenarios.length} scenario(s) against ${baseUrl} (buster=${opts.buster})\n\n`);

	if (!opts.skipVersion) {
		await fetchAndPrintVersion(baseUrl);
		process.stdout.write('\n');
	}

	const results = [];
	for (const scenario of scenarios) {
		process.stdout.write(`  ${colorize(scenario.name, 'cyan')} ... `);
		const result = await runScenario(scenario, baseUrl, opts.buster, opts.timeoutMs);
		results.push(result);
		const tag = result.status === 'pass' ? fmtPass() : fmtFail();
		const meta = colorize(`(HTTP ${result.httpStatus ?? 'n/a'}, ${result.latencyMs}ms)`, 'gray');
		process.stdout.write(`${tag} ${meta}\n`);
		if (result.errors.length > 0) {
			for (const e of result.errors) {
				process.stdout.write(`      ${colorize('-', 'red')} ${e}\n`);
			}
		}
	}

	const passed = results.filter((r) => r.status === 'pass').length;
	const failed = results.length - passed;
	process.stdout.write(`\n${passed} passed, ${failed} failed (of ${results.length})\n`);

	if (failed > 0) {
		process.stdout.write('\nFailed scenarios:\n');
		for (const r of results.filter((r) => r.status === 'fail')) {
			process.stdout.write(`  - ${r.name}\n`);
		}
		process.exit(1);
	}
	process.exit(0);
}

main().catch((err) => {
	process.stderr.write(`Unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
	process.exit(1);
});
