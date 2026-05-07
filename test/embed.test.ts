/**
 * `/embed` エンドポイントの基盤テスト (phase13.1 Step 1)。
 *
 * 本ファイルは embed エンドポイントの **インフラ層** をカバーする (URL バリデーション /
 * config gating / plugin dispatch / CSP ヘッダ等)。プラグイン本体 (renderEmbed 実装) のテストは
 * 各プラグインの実装フェーズ (Step 3 syosetu) で test/index.test.ts や test/plugin-X.test.ts に追加する。
 */

import { afterEach, describe, expect, test } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import Summaly from '@/index.js';
import type { SummalyPlugin, EmbedRenderResult } from '@/iplugin.js';

let app: FastifyInstance | null = null;

afterEach(async () => {
	if (app != null) {
		await app.close();
		app = null;
	}
});

/** fastify インスタンスを起動して embed-aware mock plugin を register する共通ヘルパ */
async function startApp(opts: {
	embedConfig?: { enabled: boolean; allowedPlugins: string[]; frameAncestors: string[] };
	mockRenderEmbed?: (url: URL) => Promise<EmbedRenderResult>;
	mockPluginName?: string;
	mockTest?: (url: URL) => boolean;
}) {
	app = fastify();
	const mockPlugin: SummalyPlugin = {
		name: opts.mockPluginName ?? 'mock-embed',
		test: opts.mockTest ?? ((url) => url.hostname === 'example.com'),
		summarize: async () => null, // 本テストでは /embed のみ叩くので summarize は呼ばれない
		renderEmbed: opts.mockRenderEmbed,
	};
	const summalyOpts: Parameters<typeof Summaly>[1] = {
		embedConfig: opts.embedConfig,
		// 組み込みプラグインのフィルタを mock 用に絞る (allowedPlugins で mock 名を許可)
		allowedPlugins: [],
		plugins: [mockPlugin],
	};
	await new Promise<void>((resolve, reject) => {
		Summaly(app!, summalyOpts, (err) => err != null ? reject(err) : resolve());
	});
}

/**
 * 注意: `/embed` ルートは builtinPlugins からのみ dispatch する設計のため、`opts.plugins`
 * (カスタムプラグイン経由) は **直接 `/embed` から見えない**。本テスト群は **dispatch ロジック以外** の
 * 観点 (config gating、URL バリデーション、CSP ヘッダ生成) を主に検証する。
 *
 * 完全な dispatch フロー検証はプラグイン実装フェーズ (Step 3 syosetu) で行う。
 */
describe('/embed エンドポイント基盤 (phase13.1 Step 1)', () => {
	test('embedConfig 未指定なら 404', async () => {
		await startApp({});
		const res = await app!.inject({ method: 'GET', url: '/embed?url=https://example.com/page' });
		expect(res.statusCode).toBe(404);
		expect(res.body).toBe('embed disabled');
		expect(res.headers['content-type']).toContain('text/plain');
	});

	test('embedConfig.enabled = false なら 404', async () => {
		await startApp({
			embedConfig: { enabled: false, allowedPlugins: [], frameAncestors: [] },
		});
		const res = await app!.inject({ method: 'GET', url: '/embed?url=https://example.com/page' });
		expect(res.statusCode).toBe(404);
		expect(res.body).toBe('embed disabled');
	});

	test('url クエリ未指定なら 400', async () => {
		await startApp({
			embedConfig: { enabled: true, allowedPlugins: ['mock-embed'], frameAncestors: ['*'] },
		});
		const res = await app!.inject({ method: 'GET', url: '/embed' });
		expect(res.statusCode).toBe(400);
		expect(res.body).toBe('url query required');
	});

	test('不正な URL は 400', async () => {
		await startApp({
			embedConfig: { enabled: true, allowedPlugins: ['mock-embed'], frameAncestors: ['*'] },
		});
		const res = await app!.inject({ method: 'GET', url: '/embed?url=not-a-url' });
		expect(res.statusCode).toBe(400);
		expect(res.body).toBe('invalid url');
	});

	test('http: スキームは 400 (https 限定)', async () => {
		await startApp({
			embedConfig: { enabled: true, allowedPlugins: ['mock-embed'], frameAncestors: ['*'] },
		});
		const res = await app!.inject({ method: 'GET', url: '/embed?url=http://example.com/' });
		expect(res.statusCode).toBe(400);
		expect(res.body).toBe('https only');
	});

	test('javascript: スキームは 400', async () => {
		await startApp({
			embedConfig: { enabled: true, allowedPlugins: ['mock-embed'], frameAncestors: ['*'] },
		});
		const res = await app!.inject({ method: 'GET', url: '/embed?url=javascript:alert(1)' });
		expect(res.statusCode).toBe(400);
	});

	test('data: スキームは 400', async () => {
		await startApp({
			embedConfig: { enabled: true, allowedPlugins: ['mock-embed'], frameAncestors: ['*'] },
		});
		const res = await app!.inject({ method: 'GET', url: '/embed?url=data:text/html,<h1>x</h1>' });
		expect(res.statusCode).toBe(400);
	});

	test('対応プラグインが無い URL なら 404 (どの組み込みプラグインも test() にマッチしない URL)', async () => {
		// allowedPlugins に存在しないプラグイン名を指定 → 必ず dispatch 失敗 (組み込みプラグインから探しても見つからない)
		await startApp({
			embedConfig: { enabled: true, allowedPlugins: ['nonexistent-plugin'], frameAncestors: ['*'] },
		});
		const res = await app!.inject({ method: 'GET', url: '/embed?url=https://example.com/page' });
		expect(res.statusCode).toBe(404);
		expect(res.body).toBe('no plugin matched');
	});

	test('未知クエリ (autoplay=1 等) は静かに無視される', async () => {
		// Misskey transformPlayerUrl が autoplay=1 / auto_play=1 を勝手に追加する仕様への対応
		// (Step 0 調査結果): 厳密 query 検証で 400 を返さないこと
		await startApp({
			embedConfig: { enabled: true, allowedPlugins: ['nonexistent-plugin'], frameAncestors: ['*'] },
		});
		const res = await app!.inject({
			method: 'GET',
			url: '/embed?url=https://example.com/page&autoplay=1&auto_play=1',
		});
		// プラグイン無しで 404 が返るが、`autoplay` で 400 にはならないことが重要
		expect(res.statusCode).toBe(404);
	});
});
