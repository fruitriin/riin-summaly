#!/usr/bin/env node
/**
 * 汎用 Worker proxy 経由 fetch チェックスクリプト。任意の URL を CF Workers proxy に投げて
 * status / content-type / OGP タグ等を表示する。
 *
 * 用途:
 *   - 「本番 summaly が特定サイトで失敗 / タイムアウトする」原因切り分け
 *     → Worker 経由 (= 別 IP プール、AS13335) で取れるなら IP レピュテーション層の問題と確定
 *     → Worker 経由でも取れないなら upstream 側の構造的 block (fail mode J 等)
 *   - 新規プラグイン候補サイトの proxy 経路実証
 *   - phase18 hedge race で proxy が challenger として機能するかの先行確認
 *
 * `check-nitori-via-worker.mjs` (phase15.4 Followup #2 専用) を base に汎用化。
 *
 * ## env / .env (`check-nitori-via-worker.mjs` と同じパターン)
 *
 *     SUMMALY_PROXY_URL=https://summaly-proxy.<account>.workers.dev
 *     SUMMALY_PROXY_SECRET=<your-hmac-secret>
 *
 * リポジトリルートの `.env` 自前 parse でフォールバック (`.env` は `.gitignore` 対象)。
 *
 * ## 使い方
 *
 *     # 任意 URL を Worker 経由で取得
 *     node scripts/check-via-worker.mjs https://www.monotaro.com/p/7281/1123/
 *
 *     # forward UA を指定 (Worker 側で upstream に転送される)
 *     node scripts/check-via-worker.mjs https://example.com/ --ua 'facebookexternalhit/1.1'
 *
 *     # body 出力サイズ調整 (default 800 bytes、0 で本文 dump skip)
 *     node scripts/check-via-worker.mjs https://example.com/ --body-bytes 4000
 *     node scripts/check-via-worker.mjs https://example.com/ --body-bytes 0
 *
 *     # OGP / <title> 抽出を skip (バイナリ / API 等)
 *     node scripts/check-via-worker.mjs https://api.example.com/ --no-extract
 *
 * ## 終了コード
 *
 *     0  = 2xx 取得成功
 *     1  = fetch 失敗 / 500 系
 *     2  = 引数不正 / env 未設定
 *     3  = 4xx (認証エラー含む)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const _filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(_filename), '..');

const DEFAULT_UA = 'Mozilla/5.0 (compatible; SummalyBot/check-via-worker; +https://github.com/fruitriin/riin-summaly)';
const DEFAULT_BODY_BYTES = 800;

/**
 * `.env` を最小限自前 parse して `process.env` に載せる (未設定キーのみ)。
 * `check-nitori-via-worker.mjs` と同じ実装 (将来 lib 化候補)。
 */
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

function parseArgs(argv) {
	const opts = {
		url: null,
		ua: DEFAULT_UA,
		bodyBytes: DEFAULT_BODY_BYTES,
		extract: true,
	};
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === '--ua') {
			if (next == null) usageAndExit('--ua には UA 文字列を指定してください');
			opts.ua = next;
			i++;
		} else if (arg === '--body-bytes') {
			if (next == null) usageAndExit('--body-bytes には数値を指定してください');
			const n = Number(next);
			if (!Number.isFinite(n) || n < 0) usageAndExit('--body-bytes は 0 以上の数値で');
			opts.bodyBytes = n;
			i++;
		} else if (arg === '--no-extract') {
			opts.extract = false;
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
	process.stderr.write(`Usage: node scripts/check-via-worker.mjs <URL> [options]

Options:
  --ua          <ua>      forward UA (default: SummalyBot 風)
  --body-bytes  <n>       body 出力サイズ (default: ${DEFAULT_BODY_BYTES}、0 で skip)
  --no-extract            OGP / <title> 抽出を skip
  --help                  このヘルプを表示

env / .env:
  SUMMALY_PROXY_URL       Worker のエンドポイント URL
  SUMMALY_PROXY_SECRET    HMAC 共有シークレット
`);
	process.exit(code);
}

function extractOgpAndTitle(body) {
	// 単純な regex 抽出 (cheerio を使うと依存増えるので最小実装)
	const tags = ['og:title', 'og:image', 'og:description', 'og:site_name', 'og:type', 'twitter:card', 'twitter:title'];
	const out = {};
	for (const tag of tags) {
		// `<meta property="og:title" content="...">` / `<meta name="..." content="...">` の両方をカバー
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

async function main() {
	loadDotEnvFallback();
	const opts = parseArgs(process.argv);

	const WORKER_URL = process.env.SUMMALY_PROXY_URL;
	const SECRET = process.env.SUMMALY_PROXY_SECRET;
	if (WORKER_URL == null || WORKER_URL === '' || SECRET == null || SECRET === '') {
		process.stderr.write(
			'env 未設定: SUMMALY_PROXY_URL / SUMMALY_PROXY_SECRET\n'
			+ 'リポジトリルートの .env に書くか、シェルで export してください。\n',
		);
		process.exit(2);
	}

	const ts = Date.now();
	const message = `${opts.url}\n${ts}`;
	const sig = crypto.createHmac('sha256', SECRET).update(message).digest('hex');
	const proxyUrl = `${WORKER_URL.replace(/\/$/, '')}/?url=${encodeURIComponent(opts.url)}`;

	process.stdout.write('=== request ===\n');
	process.stdout.write(`target:   ${opts.url}\n`);
	process.stdout.write(`proxy:    ${proxyUrl}\n`);
	process.stdout.write(`forward UA: ${opts.ua}\n`);
	process.stdout.write(`ts:       ${ts} (expires ±5min)\n`);
	process.stdout.write(`sig:      ${sig.slice(0, 16)}... (truncated)\n\n`);

	const startedAt = Date.now();
	let response;
	try {
		response = await fetch(proxyUrl, {
			method: 'GET',
			headers: {
				'x-summaly-sig': sig,
				'x-summaly-ts': String(ts),
				'x-summaly-forward-ua': opts.ua,
			},
		});
	} catch (e) {
		process.stderr.write(`=== fetch error ===\n${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	}
	const elapsed = Date.now() - startedAt;

	process.stdout.write('=== response ===\n');
	process.stdout.write(`status:       ${response.status} ${response.statusText}\n`);
	process.stdout.write(`elapsed:      ${elapsed}ms\n`);
	process.stdout.write(`content-type: ${response.headers.get('content-type') ?? '(missing)'}\n`);
	process.stdout.write(`x-summaly-proxy:     ${response.headers.get('x-summaly-proxy') ?? '(missing)'}\n`);
	process.stdout.write(`x-summaly-final-url: ${response.headers.get('x-summaly-final-url') ?? '(missing)'}\n\n`);

	const body = await response.text();
	process.stdout.write(`body length:  ${body.length} bytes\n\n`);

	if (opts.bodyBytes > 0) {
		process.stdout.write(`=== body (first ${opts.bodyBytes} bytes) ===\n`);
		process.stdout.write(body.slice(0, opts.bodyBytes));
		if (body.length > opts.bodyBytes) process.stdout.write('\n... (truncated)');
		process.stdout.write('\n\n');
	}

	if (opts.extract && response.status >= 200 && response.status < 300) {
		const tags = extractOgpAndTitle(body);
		const keys = Object.keys(tags);
		if (keys.length === 0) {
			process.stdout.write('=== OGP / <title> ===\n  (none extracted — non-HTML response or missing tags)\n\n');
		} else {
			process.stdout.write('=== OGP / <title> ===\n');
			for (const k of keys) {
				const v = tags[k];
				const truncated = v.length > 120 ? v.slice(0, 120) + '...' : v;
				process.stdout.write(`  ${k.padEnd(16)} = ${truncated}\n`);
			}
			process.stdout.write('\n');
		}
	}

	process.stdout.write('=== 判定ヒント ===\n');
	const ct = response.headers.get('content-type') ?? '';
	if (response.status >= 200 && response.status < 300) {
		if (ct.includes('text/html') || ct.includes('xhtml')) {
			process.stdout.write('  → 200 + HTML: Worker 経由で取得成功 ✓\n');
			process.stdout.write('     本番 summaly が同 URL で fail/timeout する場合、proxy 経路が hedge race の challenger として\n');
			process.stdout.write('     起動できていない可能性 ([scraping.proxy].enabled / domains / Worker ALLOWED_DOMAINS を確認)\n');
		} else if (ct.includes('json')) {
			process.stdout.write('  → 200 + JSON: API 取得成功 ✓\n');
		} else {
			process.stdout.write(`  → 200 + 想定外 content-type (${ct}): summaly の typeFilter で弾かれる可能性\n`);
		}
		process.exit(0);
	} else if (response.status === 401 || response.status === 403) {
		process.stdout.write('  → 認証エラー: secret/HMAC 不一致、または Worker 側 ALLOWED_DOMAINS に対象 host が未登録\n');
		process.exit(3);
	} else if (response.status === 520) {
		process.stdout.write('  → 520 CF Web Server Returns Unknown Error: CF→origin で異常終了 (fail mode J / TLS 切断系)\n');
		process.stdout.write('     proxy では救援不可。residential proxy / Playwright が必要\n');
		process.exit(1);
	} else if (response.status >= 500 && response.status < 600) {
		process.stdout.write(`  → 5xx: Worker 経由でも upstream エラー (${response.status})\n`);
		process.stdout.write('     body の error code を確認 (TLS / upstream_fetch_error 系なら fail mode J 確定)\n');
		process.exit(1);
	} else if (response.status >= 400 && response.status < 500) {
		process.stdout.write(`  → 4xx (${response.status}): upstream が拒否 (UA / リファラ要件等)\n`);
		process.exit(3);
	} else {
		process.stdout.write(`  → 想定外 status: ${response.status}\n`);
		process.exit(1);
	}
}

main().catch((err) => {
	process.stderr.write(`Unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
	process.exit(1);
});
