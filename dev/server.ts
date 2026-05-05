/**
 * Dev サーバ — `pnpm dev` で起動する動作確認 UI。
 *
 * - `GET /` → 静的 UI（dev/public/index.html）
 * - `GET /api/summaly?url=...&lang=...&useRange=1&enablePdf=1&allowedPlugins=youtube,spotify`
 *   → クエリで毎回オプションを変えて `summaly()` を呼ぶ。Fastify プラグインモードと違い
 *   オプションがリクエスト単位で切り替えられるため UI からのチェックボックス操作が即時に反映される
 * - `GET /api/sample-urls` → サンプル URL 集（フロント JS から fetch する）
 *
 * 本番 bundle (`pnpm build` 出力 = `built/`) には含まれない（`tsconfig.json` の include を
 * `./src/**` に限定しているため）。`pnpm dev` で `tsx` が直接 TS を実行する。
 *
 * SUMMALY_ALLOW_PRIVATE_IP は dev サーバ内でだけ true にして、ローカルサイトに対する
 * プレビューを許可する。シェル env を汚染しないようにこのファイル内で設定する。
 */

// ビルド時定数 `_VERSION_` を tsx 実行環境向けに注入する（必ず src/ より前に import する）
import './setup-version.js';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { summaly, type SummalyOptions, type SummalyResult } from '../src/index.js';
import { plugins as builtinPlugins } from '../src/plugins/index.js';
import { sampleGroups } from './sample-urls.js';

const builtinPluginNames = builtinPlugins
	.map(p => p.name)
	.filter((n): n is string => n != null);

process.env.SUMMALY_ALLOW_PRIVATE_IP = 'true';

// Proxy fallback (phase12.1)。env が両方セットされていれば dev UI の checkbox から有効化できる。
// SUMMALY_PROXY_URL = "https://summaly-proxy.<your>.workers.dev"
// SUMMALY_PROXY_SECRET = wrangler secret put SHARED_SECRET と同値
const proxyEnv = {
	url: process.env.SUMMALY_PROXY_URL ?? '',
	secret: process.env.SUMMALY_PROXY_SECRET ?? '',
};
const proxyAvailable = proxyEnv.url !== '' && proxyEnv.secret !== '';

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

const app = Fastify({ logger: true });

if (proxyAvailable) {
	app.log.info({ url: proxyEnv.url }, 'proxy fallback available (use ?proxy=1 to enable per-request)');
} else {
	app.log.info(
		'proxy fallback unavailable (set SUMMALY_PROXY_URL + SUMMALY_PROXY_SECRET env vars to enable)',
	);
}

interface SummalyQuery {
	url?: string;
	lang?: string;
	useRange?: string;
	enablePdf?: string;
	allowedPlugins?: string;
	/** "1" にすると proxy fallback を有効化（env で URL/secret 設定済みのときのみ有効） */
	proxy?: string;
}

// 直接 summaly() を叩くハンドラ。register options ではなく request 単位で options を組み立てるので
// UI のチェックボックス操作が即時に反映される（プラグインモードでは register 時に options が固定される）。
app.get<{ Querystring: SummalyQuery }>('/api/summaly', async (req, reply) => {
	const url = req.query.url;
	if (!url) {
		reply.status(400);
		return { error: 'url is required' };
	}
	try { new URL(url); } catch {
		reply.status(400);
		return { error: 'invalid URL format' };
	}

	const opts: SummalyOptions = {
		lang: req.query.lang || null,
		useRange: req.query.useRange === '1',
		enablePdf: req.query.enablePdf === '1',
		followRedirects: true,
	};
	if (req.query.allowedPlugins) {
		opts.allowedPlugins = req.query.allowedPlugins.split(',').map(s => s.trim()).filter(Boolean);
	}
	// Proxy fallback (phase12.1)。env で URL/secret が設定されていて、かつ ?proxy=1 のときに有効化。
	// dev では Amazon class IP block の救援を手元で再現できるように UI から ON/OFF を切り替えたい。
	if (req.query.proxy === '1' && proxyAvailable) {
		opts.proxyFallback = {
			enabled: true,
			url: proxyEnv.url,
			secret: proxyEnv.secret,
			categories: ['origin_error'],
			domains: [
				'amazon.com', 'amazon.co.jp', 'amazon.co.uk', 'amazon.de', 'amazon.fr',
				'amazon.it', 'amazon.es', 'amazon.ca', 'amazon.com.au', 'amazon.com.br',
				'amazon.com.mx', 'amazon.in',
			],
			timeoutMs: 30000,
		};
	}

	try {
		const result: SummalyResult = await summaly(url, opts);
		return result;
	} catch (e) {
		reply.status(500);
		return {
			error: e instanceof Error ? { message: e.message, name: e.name } : String(e),
		};
	}
});

app.get('/api/sample-urls', async () => ({
	groups: sampleGroups,
	plugins: builtinPluginNames,
}));

// dev UI が起動時に呼ぶ。env の有無で UI のチェックボックス表示を切り替える。
// secret 自体は **絶対に返さない**（UI の info 表示用に proxyAvailable と URL の host だけ）。
app.get('/api/dev-config', async () => {
	let proxyHost: string | null = null;
	if (proxyAvailable) {
		try { proxyHost = new URL(proxyEnv.url).host; } catch { proxyHost = '(invalid url)'; }
	}
	return {
		proxyAvailable,
		proxyHost,
	};
});

// バージョン情報エンドポイント。本番 (Fastify プラグイン経由) と同じ shape を返す。
app.get('/v', async (_req, reply) => {
	reply.header('Cache-Control', 'no-store');
	return {
		version: _VERSION_,
		commit: _GIT_COMMIT_,
		message: _GIT_MESSAGE_,
	};
});

await app.register(fastifyStatic, {
	root: resolve(_dirname, 'public'),
	prefix: '/',
});

// `??` は `null` / `undefined` のみを fallback にするため、空文字列の HOST が
// `listen({ host: '' })` に渡ると IPv6 全インターフェースバインドになり SSRF リレーになりうる。
// 空文字列も fallback 対象にする。
const rawHost = process.env.HOST;
const host = (rawHost != null && rawHost.trim() !== '') ? rawHost.trim() : '127.0.0.1';

// `Number('')` は `0`、`Number('abc')` は `NaN`。どちらもサイレントな誤動作になるため厳格に検証する。
const rawPort = process.env.PORT;
const port = (rawPort != null && /^\d+$/.test(rawPort)) ? parseInt(rawPort, 10) : 3000;

try {
	await app.listen({ port, host });
	app.log.info(`summaly dev server: http://${host}:${port}`);
} catch (err) {
	app.log.error(err);
	process.exit(1);
}
