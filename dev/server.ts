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
import { buildCspDirectiveParts } from '../src/utils/csp-origin.js';
import {
	DomainStrategyCache,
	getActiveCache,
	getDefaultBootstrapPath,
	setActiveCache,
} from '../src/utils/domain-strategy-cache.js';
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

// `??` は `null` / `undefined` のみを fallback にするため、空文字列の HOST が
// `listen({ host: '' })` に渡ると IPv6 全インターフェースバインドになり SSRF リレーになりうる。
// 空文字列も fallback 対象にする。
const rawHost = process.env.HOST;
const host = (rawHost != null && rawHost.trim() !== '') ? rawHost.trim() : '127.0.0.1';

// `Number('')` は `0`、`Number('abc')` は `NaN`。どちらもサイレントな誤動作になるため厳格に検証する。
const rawPort = process.env.PORT;
const port = (rawPort != null && /^\d+$/.test(rawPort)) ? parseInt(rawPort, 10) : 3000;

// **dev 用 embedBaseUrl**: `summaly()` に渡すと renderEmbed 対応プラグイン (syosetu 等) が
// `Summary.player.url = <base>/embed?url=<encoded>` を組み立てる。dev では自前の /embed ルート
// で renderEmbed を実行し、UI から iframe 表示できるようにする。
// HOST=127.0.0.1 がデフォルトなのでブラウザからアクセスする想定で localhost を使う
// (HOST=0.0.0.0 等で起動する場合は env で `EMBED_PUBLIC_URL` 上書き可能)。
const embedBaseUrl = process.env.EMBED_PUBLIC_URL ?? `http://localhost:${port}`;

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

const app = Fastify({ logger: true });

if (proxyAvailable) {
	// **重要**: ログには `proxyEnv.url` だけを渡す（`proxyEnv` オブジェクト全体を渡すと
	// secret がログに混入する経路ができる）。Fastify の logger には `redact` を設定していないため、
	// このルールを呼出側で守る必要がある (W-1)
	app.log.info({ url: proxyEnv.url }, 'proxy fallback available (use ?proxy=1 to enable per-request)');
} else {
	app.log.info(
		'proxy fallback unavailable (set SUMMALY_PROXY_URL + SUMMALY_PROXY_SECRET env vars to enable)',
	);
}

// **経路学習キャッシュを dev サーバでも有効化** (phase14 Step 5)。
// 同梱 `data/domain-strategy-bootstrap.jsonl` を自動ロードして、yodobashi / sqex / amazon
// 等のサイトに対する初期経路 (curl_cffi / proxy) を `summaly()` の cache fast path で適用できる。
// runtimePath は未指定 = 永続化なし (in-memory のみ、dev 再起動でリセット)。
//
// `/api/strategy-cache` エンドポイントで cache の中身を JSON で返す → UI で経路マッピングを観察。
const devBootstrapPath = getDefaultBootstrapPath();
const devCache = new DomainStrategyCache({
	bootstrapPath: devBootstrapPath,
});
setActiveCache(devCache);
app.log.info(
	{ bootstrapPath: devBootstrapPath ?? '(not found)', size: devCache.size },
	'domain strategy cache initialized for dev server',
);

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
		// renderEmbed 対応プラグイン (syosetu 等) が `Summary.player.url` を組み立てるのに使う。
		// dev サーバ自身が下記 /embed ルートで renderEmbed を実行する。
		embedBaseUrl,
	};
	if (req.query.allowedPlugins) {
		opts.allowedPlugins = req.query.allowedPlugins.split(',').map(s => s.trim()).filter(Boolean);
	}
	// Proxy fallback (phase12.1)。env で URL/secret が設定されていて、かつ ?proxy=1 のときに有効化。
	// dev では Amazon class IP block の救援を手元で再現できるように UI から ON/OFF を切り替えたい。
	//
	// **W-3**: 下記 `domains` allowlist は Worker 側 (`tools/cf-proxy-worker/wrangler.toml` の
	// `ALLOWED_DOMAINS`) と独立に管理されている。**両方を同期して更新すること**
	// （片方だけ更新すると dev UI で proxy 発火条件と Worker の実際の allowlist が乖離する）。
	// Worker 側が最終防衛ラインなので機能的影響は小さいが、UX 的には混乱する。
	//
	// **W-2**: dev サーバはデフォルト `HOST=127.0.0.1` バインド + `SUMMALY_ALLOW_PRIVATE_IP=true` の前提。
	// `HOST=0.0.0.0` で起動すると LAN 公開になり `?proxy=1` を LAN 内別ホストから叩かれうるため、
	// proxy 機能を使う場合は HOST を変更しないこと（変更するなら SUMMALY_PROXY_URL/SECRET を未設定に）。
	if (req.query.proxy === '1' && proxyAvailable) {
		// phase18.1: categories / domains 撤廃 (hedge race ですべての URL に対して並列発火)。
		// Worker 側 ALLOWED_DOMAINS が最終防衛として残る。
		opts.proxyFallback = {
			enabled: true,
			url: proxyEnv.url,
			secret: proxyEnv.secret,
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

// **dev /embed ルート** (本番 `/embed` ルート in src/index.ts L904- の dev 用最小再実装)。
// `Summary.player.url = http://localhost:3000/embed?url=<encoded>` を iframe で開いたときの実体。
// 本番より緩い構成 (allowedPlugins 制限なし、CSP frameAncestors は localhost 自身のみ許可)。
// 動作確認用なので「summaly() の出口で得た player.url をブラウザで実際にレンダリング」できれば十分。
app.get<{ Querystring: { url?: string } }>('/embed', async (req, reply) => {
	const rawUrl = req.query.url;
	if (rawUrl == null || rawUrl === '') {
		reply.code(400);
		reply.type('text/plain; charset=utf-8');
		return 'url query required';
	}
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(rawUrl);
	} catch {
		reply.code(400);
		reply.type('text/plain; charset=utf-8');
		return 'invalid url';
	}
	if (parsedUrl.protocol !== 'https:') {
		reply.code(400);
		reply.type('text/plain; charset=utf-8');
		return 'https only';
	}
	const plugin = builtinPlugins.find(p =>
		p.name != null && p.renderEmbed != null && p.test(parsedUrl),
	);
	if (plugin?.renderEmbed == null) {
		reply.code(404);
		reply.type('text/plain; charset=utf-8');
		return 'no plugin matched';
	}
	let result;
	try {
		result = await plugin.renderEmbed(parsedUrl, {});
	} catch (err) {
		app.log.error(
			{ err: err instanceof Error ? { name: err.name, message: err.message } : { message: String(err) } },
			'embed renderEmbed failed',
		);
		reply.code(500);
		reply.type('text/plain; charset=utf-8');
		return 'render failed';
	}
	// defense-in-depth: <script> 混入を構造的にブロック (本番と同じ契約)
	if (/<script[\s>/]/i.test(result.body)) {
		app.log.error('embed: renderEmbed returned body containing <script>, rejecting');
		reply.code(500);
		reply.type('text/plain; charset=utf-8');
		return 'render failed';
	}
	// 本番 (src/index.ts) と同じ body size cap (512KB)。dev/prod の guard parity を保つ。
	if (Buffer.byteLength(result.body, 'utf8') > 512 * 1024) {
		app.log.error('embed: renderEmbed body too large, rejecting');
		reply.code(500);
		reply.type('text/plain; charset=utf-8');
		return 'render failed';
	}
	reply.type('text/html; charset=utf-8');
	// 外部リソース許可 (frame-src / media-src 等): プラグインが cspDirectives を宣言した場合のみ追加
	// (ディレクティブ許可リスト + origin-only 再検証、本番と共有 util)。
	const cspExtra = buildCspDirectiveParts(result.cspDirectives);
	const cspExtraPart = cspExtra.length > 0 ? `; ${cspExtra.join('; ')}` : '';
	// dev では frame-ancestors を自身 (= dev UI) に限定。本番は config の frameAncestors。
	reply.header(
		'Content-Security-Policy',
		`default-src 'none'; img-src https:; style-src 'unsafe-inline'${cspExtraPart}; frame-ancestors 'self' http://localhost:${port} http://127.0.0.1:${port}`,
	);
	reply.header('X-Content-Type-Options', 'nosniff');
	reply.header('Referrer-Policy', 'no-referrer');
	return result.body;
});

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

// **経路学習キャッシュ観測エンドポイント** (phase14 Step 5、dev 専用)。
// in-memory cache の現在の中身を JSON で返す。サンプル URL から取得 → 経路マッピング学習 →
// 本エンドポイントで確認、というフローで cache 動作を視覚化できる。本番には載せない
// (機密データ = 過去 preview 試行 URL の漏洩経路になりうるため、dev 限定)。
app.get('/api/strategy-cache', async (_req, reply) => {
	reply.header('Cache-Control', 'no-store');
	const cache = getActiveCache();
	if (cache == null) {
		return { active: false, size: 0, entries: [], bootstrapPath: null };
	}
	return {
		active: true,
		size: cache.size,
		bootstrapPath: cache.bootstrapPath ?? null,
		runtimePath: cache.runtimePath ?? null,
		consecutiveFailureThreshold: cache.consecutiveFailureThreshold,
		// `lastAttemptAt` 降順 (最新利用 entry が先頭) → UI で「直近に学習した経路」が見やすい
		entries: cache.snapshot(),
	};
});

await app.register(fastifyStatic, {
	root: resolve(_dirname, 'public'),
	prefix: '/',
});

try {
	await app.listen({ port, host });
	app.log.info(`summaly dev server: http://${host}:${port}`);
} catch (err) {
	app.log.error(err);
	process.exit(1);
}
