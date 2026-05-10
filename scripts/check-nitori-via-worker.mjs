#!/usr/bin/env node
/**
 * phase15.4 Followup #2 検証スクリプト: ニトリ API を CF Workers proxy 経由で叩いて、
 * Cloudflare の AS13335 IP が Akamai 系で通るか (datacenter IP block 切り分け) を確認する。
 *
 * ## 使い方
 *
 * 認証情報 (Worker URL / HMAC secret) はコードに埋め込まず env から読む:
 *
 *   1) シェル export:
 *        export SUMMALY_PROXY_URL='https://summaly-proxy.<account>.workers.dev'
 *        export SUMMALY_PROXY_SECRET='your-secret'
 *        node scripts/check-nitori-via-worker.mjs
 *
 *   2) Node.js v20.6+ の `--env-file` (`.env` がリポジトリルートにある場合):
 *        node --env-file=.env scripts/check-nitori-via-worker.mjs
 *
 *   3) 何もしなくても、本スクリプトはリポジトリルートの `.env` を自前 parse して
 *      フォールバックするため、`.env` に `SUMMALY_PROXY_URL` / `SUMMALY_PROXY_SECRET`
 *      が書かれていれば追加設定なしで動く (`.env` は `.gitignore` 対象なので安全)。
 *
 * ## 期待する判定
 *
 *   - 502 + upstream_fetch_error (TLS) → CF AS13335 も Akamai に block (fail mode J)
 *   - 520 (Cloudflare Web Server Returns Unknown Error) → 同上 (CF が origin から異常終了を受信)
 *   - 200 OK + content-type: application/xhtml+xml → TLS は通過 ✓ (Worker の Accept ヘッダ固定が原因)
 *   - 200 OK + content-type: application/json → 既に動作
 *   - 401/403 → secret 違いか HMAC 計算ミス、または Worker 側 ALLOWED_DOMAINS に nitori-net.jp が無い
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const _filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(_filename), '..');

/**
 * `.env` を最小限自前 parse して `process.env` に載せる (未設定キーのみ)。
 * 既に env が設定されていればそちらを尊重 (シェル export / `--env-file` 等)。
 *
 * 仕様: `KEY=VALUE` 形式のみ。`#` で始まる行はコメント、空行は無視。
 * クォートは前後一致時のみ除去 ('...' / "..."). エスケープ・複数行はサポートしない
 * (本検証スクリプトの用途に十分な最小実装)。
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

loadDotEnvFallback();

const WORKER_URL = process.env.SUMMALY_PROXY_URL;
const SECRET = process.env.SUMMALY_PROXY_SECRET;

if (WORKER_URL == null || WORKER_URL === '' || SECRET == null || SECRET === '') {
	console.error('[check-nitori-via-worker] env 未設定: SUMMALY_PROXY_URL / SUMMALY_PROXY_SECRET');
	console.error('  シェルで export するか、リポジトリルートの .env に書いてください。');
	console.error('  example:');
	console.error('    SUMMALY_PROXY_URL=https://summaly-proxy.<account>.workers.dev');
	console.error('    SUMMALY_PROXY_SECRET=<your-hmac-secret>');
	process.exit(2);
}

const NITORI_API = 'https://www.nitori-net.jp/occ/v2/nitorinet/nitori/products/2116100013272s?handleError=true&lang=ja&curr=JPY';

const ts = Date.now();
const message = `${NITORI_API}\n${ts}`;
const sig = crypto.createHmac('sha256', SECRET).update(message).digest('hex');

const proxyUrl = `${WORKER_URL.replace(/\/$/, '')}/?url=${encodeURIComponent(NITORI_API)}`;

console.log('=== request ===');
console.log('proxy url:', proxyUrl);
console.log('ts:', ts, '(expires ±5min)');
console.log('sig:', sig.slice(0, 16) + '... (truncated)');
console.log('');

const startedAt = Date.now();
let response;
try {
	response = await fetch(proxyUrl, {
		method: 'GET',
		headers: {
			'x-summaly-sig': sig,
			'x-summaly-ts': String(ts),
			'x-summaly-forward-ua': 'Mozilla/5.0 (compatible; SummalyBot/5.3.0; +https://github.com/fruitriin/riin-summaly)',
		},
	});
} catch (e) {
	console.error('=== fetch error ===');
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
}
const elapsed = Date.now() - startedAt;

console.log('=== response ===');
console.log('status:', response.status, response.statusText);
console.log('elapsed:', elapsed + 'ms');
console.log('content-type:', response.headers.get('content-type') ?? '(missing)');
console.log('x-summaly-proxy:', response.headers.get('x-summaly-proxy') ?? '(missing)');
console.log('x-summaly-final-url:', response.headers.get('x-summaly-final-url') ?? '(missing)');
console.log('');

const body = await response.text();
console.log('=== body (first 800 bytes) ===');
console.log(body.slice(0, 800));
console.log('');

console.log('=== 判定ヒント ===');
const ct = response.headers.get('content-type') ?? '';
if (response.status === 520) {
	console.log('  → 520 Cloudflare Web Server Returns Unknown Error: CF→origin で異常終了');
	console.log('     fail mode J 確定 (proxy では救援不可、residential proxy / Playwright 待ち)');
} else if (response.status >= 500 && response.status < 600) {
	console.log('  → 5xx: Worker 経由でも upstream エラー。body の error code を見る (TLS / upstream_fetch_error 系なら fail mode J 確定)');
} else if (response.status === 401 || response.status === 403) {
	console.log('  → 認証エラー: secret か HMAC 計算が違う可能性、または Worker 側 ALLOWED_DOMAINS に nitori-net.jp が無い');
} else if (response.status >= 200 && response.status < 300) {
	if (ct.includes('application/json')) {
		console.log('  → 200 + JSON: 既に動作。本番で fail する別経路を再調査');
	} else if (ct.includes('xhtml') || ct.includes('text/html')) {
		console.log('  → 200 + XHTML/HTML: TLS は通過 ✓、Worker の Accept ヘッダ固定が原因');
		console.log('     phase15.4b で「Worker headers 透過機構追加 + nitori 経路 pivot」を実装すれば救援できる');
	} else {
		console.log('  → 200 + 想定外 content-type: 本番ロジックでは弾かれる、追加調査');
	}
}
