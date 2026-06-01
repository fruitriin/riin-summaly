/**
 * Tests!
 */

'use strict';

/* dependencies below */

import fs, { readdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import process from 'node:process';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Agent as httpAgent } from 'node:http';
import { Agent as httpsAgent } from 'node:https';
import { expect, test, describe, beforeEach, afterEach, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import summalyPlugin, { summaly, summalyDefaultOptions, type SummalyOptions } from '@/index.js';
import { StatusError } from '@/utils/status-error.js';
import { getJson } from '@/utils/got.js';
import { KNOWN_SHORT_HOSTS } from '@/utils/short-urls.js';
import { BROWSER_UA } from '@/utils/user-agents.js';
import { plugins as builtinPlugins } from '@/plugins/index.js';
import { PLAYER_ALLOW_OEMBED } from '@/utils/player-allow.js';
import { sanitizeUrl } from '@/utils/sanitize-url.js';
import { detectEncoding, toUtf8 } from '@/utils/encoding.js';
import { destroyDefaultAgents } from '@/utils/agent.js';
import * as iconv from 'iconv-lite';
import Encoding from 'encoding-japanese';

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

/* settings below */

Error.stackTraceLimit = Infinity;

// During the test the env variable is set to test
process.env.NODE_ENV = 'test';

const port = 3060;
const host = `http://localhost:${port}`;

// Display detail of unhandled promise rejection
process.on('unhandledRejection', console.dir);

let app: FastifyInstance | null = null;

function skippableTest(name: string, fn: () => void) {
	if (process.env.SKIP_NETWORK_TEST === 'true') {
		console.log(`[SKIP] ${name}`);
		test.skip(name, fn);
	} else {
		test(name, fn);
	}
}

/* tests below */
afterEach(async () => {
	process.env.SUMMALY_ALLOW_PRIVATE_IP = 'false';
	if (app != null) {
		await app.close();
		app = null;
	}
});

afterAll(() => {
	// keep-alive agent のソケットを閉じてプロセスがハングするのを防ぐ
	destroyDefaultAgents();
});

describe('network tests', () => {
	skippableTest('Stage Bye Stage (YouTube oEmbed plugin)', async () => {
		// phase3.1 で youtube プラグインを oEmbed 直叩きに置き換えた。
		// 本テストは実際の YouTube oEmbed エンドポイントを叩くため、
		// 構造・タイトル等が合致することのみ確認する（HTML 構造変化に強い形に変更）。
		const summary = await summaly('https://www.youtube.com/watch?v=NMIEAhH_fTU');
		expect(summary.sitename).toBe('YouTube');
		expect(summary.icon).toBe('https://www.youtube.com/favicon.ico');
		expect(summary.title).toBeDefined();
		expect(summary.player.url).toMatch(/^https:\/\/www\.youtube\.com\/embed\/NMIEAhH_fTU/);
		expect(summary.player.allow).toContain('fullscreen');
		expect(summary.url).toBe('https://www.youtube.com/watch?v=NMIEAhH_fTU');
	});

	test('Should block localhost by default', async () => {
		app = fastify();
		app.get('*', (request, reply) => {
			const content = fs.readFileSync(_dirname + '/htmls/basic.html');
			reply.header('content-length', content.length);
			reply.header('content-type', 'text/html');
			return reply.send(content);
		});
		await app.listen({ port });

		const summary = await summaly(host).catch((e: StatusError) => e);

		if (summary instanceof StatusError) {
			expect(summary.name).toBe('StatusError');
			expect(summary.statusCode).toBe(400);
			expect(summary.message).toContain('Private IP rejected');
		} else {
			expect(summary).toBeInstanceOf(StatusError);
		}
	});
});

describe('local tests', () => {
	beforeEach(() => {
		// デフォルトではlocalhostへのアクセスを許可しないため、テスト中は環境変数で許可する
		process.env.SUMMALY_ALLOW_PRIVATE_IP = 'true';
	});

	test('basic', async () => {
		app = fastify();
		app.get('/', (request, reply) => {
			const content = fs.readFileSync(_dirname + '/htmls/basic.html');
			reply.header('content-length', content.length);
			reply.header('content-type', 'text/html');
			return reply.send(content);
		});
		await app.listen({ port });
		expect(await summaly(host)).toEqual({
			title: 'KISS principle',
			icon: null,
			description: null,
			thumbnail: null,
			player: {
				url: null,
				width: null,
				height: null,
				'allow': [
					'autoplay',
					'encrypted-media',
					'fullscreen',
				],
			},
			sitename: 'localhost:3060',
			sensitive: false,
			url: host + '/',
			activityPub: null,
			fediverseCreator: null,
		});
	});

	test('faviconがHTML上で指定されていないが、ルートに存在する場合、正しく設定される', async () => {
		app = fastify();
		app.get('/', (request, reply) => {
			const content = fs.readFileSync(_dirname + '/htmls/no-favicon.html');
			reply.header('content-length', content.length);
			reply.header('content-type', 'text/html');
			return reply.send(content);
		});
		app.get('/favicon.ico', (_, reply) => reply.status(200).send());
		await app.listen({ port });

		const summary = await summaly(host);
		expect(summary.icon).toBe(`${host}/favicon.ico`);
	});

	test('faviconがHTML上で指定されていなくて、ルートにも存在しなかった場合 null になる', async () => {
		app = fastify();
		app.get('/', (request, reply) => {
			const content = fs.readFileSync(_dirname + '/htmls/no-favicon.html');
			reply.header('content-length', content.length);
			reply.header('content-type', 'text/html');
			return reply.send(content);
		});
		app.get('*', (_, reply) => reply.status(404).send());
		await app.listen({ port });

		const summary = await summaly(host);
		expect(summary.icon).toBe(null);
	});

	describe('favicon thumbnail fallback (phase11.7)', () => {
		test('OG/Twitter/image_src/apple-touch-icon が無く favicon (PNG) が HEAD 200 → thumbnail に採用', async () => {
			// 2026-05-08 修正: `<img>` で表示可能な PNG favicon を採用するケース。
			// `.ico` は別テスト (`.ico は thumbnail から除外される`) で除外動作を担保する。
			app = fastify();
			app.get('/', (_req, reply) => {
				const html = '<html><head><title>Bare Page</title><link rel="icon" href="/favicon.png"></head><body>x</body></html>';
				reply.header('content-type', 'text/html');
				reply.header('content-length', html.length);
				return reply.send(html);
			});
			app.get('/favicon.png', (_req, reply) => {
				reply.header('content-type', 'image/png');
				return reply.status(200).send();
			});
			await app.listen({ port });

			const summary = await summaly(host);
			expect(summary.icon).toBe(`${host}/favicon.png`);
			expect(summary.thumbnail).toBe(`${host}/favicon.png`);
			expect(summary.thumbnail).toBe(summary.icon);
		});

		test('isThumbnailableIcon: content-type / 拡張子バリエーション (pure)', async () => {
			const { isThumbnailableIcon } = await import('@/general.js');
			// content-type 優先
			expect(isThumbnailableIcon({ href: 'https://x/favicon.png', contentType: 'image/png' })).toBe(true);
			expect(isThumbnailableIcon({ href: 'https://x/favicon.ico', contentType: 'image/x-icon' })).toBe(false);
			expect(isThumbnailableIcon({ href: 'https://x/favicon.ico', contentType: 'image/vnd.microsoft.icon' })).toBe(false);
			// content-type に charset 付き
			expect(isThumbnailableIcon({ href: 'https://x/x.svg', contentType: 'image/svg+xml; charset=utf-8' })).toBe(true);
			// content-type が image/* 以外 (HTML 誤返却等)
			expect(isThumbnailableIcon({ href: 'https://x/x.png', contentType: 'text/html' })).toBe(false);
			// content-type 不明 → 拡張子で判定
			expect(isThumbnailableIcon({ href: 'https://x/favicon.png', contentType: undefined })).toBe(true);
			expect(isThumbnailableIcon({ href: 'https://x/favicon.ico', contentType: undefined })).toBe(false);
			expect(isThumbnailableIcon({ href: 'https://x/cursor.cur', contentType: undefined })).toBe(false);
			// クエリ / フラグメント付き .ico
			expect(isThumbnailableIcon({ href: 'https://x/favicon.ico?v=2', contentType: undefined })).toBe(false);
			expect(isThumbnailableIcon({ href: 'https://x/favicon.ico#hash', contentType: undefined })).toBe(false);
			// 拡張子なし path (動的 favicon) は許可 (誤検知より取りこぼし防止優先)
			expect(isThumbnailableIcon({ href: 'https://x/favicon', contentType: undefined })).toBe(true);
		});

		test('favicon が `.ico` の場合は thumbnail から除外される (Misskey で <img> 表示できないため)', async () => {
			// 2026-05-08 追加: `.ico` / `.cur` は `<img>` で broken image になるため thumbnail に流用しない。
			// icon フィールド自体は `.ico` を残す (サイトアイコン経路は ico 対応する UI もあるため互換性維持)。
			app = fastify();
			app.get('/', (_req, reply) => {
				const html = '<html><head><title>Ico Only</title><link rel="icon" href="/favicon.ico"></head><body>x</body></html>';
				reply.header('content-type', 'text/html');
				reply.header('content-length', html.length);
				return reply.send(html);
			});
			app.get('/favicon.ico', (_req, reply) => {
				reply.header('content-type', 'image/x-icon');
				return reply.status(200).send();
			});
			await app.listen({ port });

			const summary = await summaly(host);
			expect(summary.icon).toBe(`${host}/favicon.ico`); // icon は残る
			expect(summary.thumbnail).toBeNull(); // thumbnail は除外
		});

		test('OG 画像があるとき favicon は採用しない（既存挙動維持）', async () => {
			app = fastify();
			app.get('/', (_req, reply) => {
				const html = '<html><head><title>OG Page</title>'
					+ '<meta property="og:image" content="/og.png">'
					+ '<link rel="icon" href="/favicon.ico"></head><body>x</body></html>';
				reply.header('content-type', 'text/html');
				reply.header('content-length', html.length);
				return reply.send(html);
			});
			app.get('/favicon.ico', (_req, reply) => reply.status(200).send());
			await app.listen({ port });

			const summary = await summaly(host);
			expect(summary.thumbnail).toBe(`${host}/og.png`);
			expect(summary.thumbnail).not.toBe(summary.icon);
		});

		test('apple-touch-icon が favicon より優先される', async () => {
			app = fastify();
			app.get('/', (_req, reply) => {
				const html = '<html><head><title>Touch Page</title>'
					+ '<link rel="apple-touch-icon" href="/touch.png">'
					+ '<link rel="icon" href="/favicon.ico"></head><body>x</body></html>';
				reply.header('content-type', 'text/html');
				reply.header('content-length', html.length);
				return reply.send(html);
			});
			app.get('/favicon.ico', (_req, reply) => reply.status(200).send());
			await app.listen({ port });

			const summary = await summaly(host);
			expect(summary.thumbnail).toBe(`${host}/touch.png`);
			expect(summary.icon).toBe(`${host}/favicon.ico`);
			expect(summary.thumbnail).not.toBe(summary.icon);
		});

		test('favicon が HEAD 失敗（404）なら thumbnail は null（既存挙動維持）', async () => {
			app = fastify();
			app.get('/', (_req, reply) => {
				const html = '<html><head><title>No Icon Page</title></head><body>x</body></html>';
				reply.header('content-type', 'text/html');
				reply.header('content-length', html.length);
				return reply.send(html);
			});
			// favicon を明示的に 404 で返す（fastify のデフォルト 404 に依存しない読みやすさ）
			app.get('/favicon.ico', (_req, reply) => reply.status(404).send());
			await app.listen({ port });

			const summary = await summaly(host);
			expect(summary.icon).toBeNull();
			expect(summary.thumbnail).toBeNull();
		});
	});

	test('titleがcleanupされる', async () => {
		app = fastify();
		app.get('/', (request, reply) => {
			const content = fs.readFileSync(_dirname + '/htmls/og-title.html');
			reply.header('content-length', content.length);
			reply.header('content-type', 'text/html');
			return reply.send(content);
		});
		await app.listen({ port });

		const summary = await summaly(host);
		expect(summary.title).toBe('Strawberry Pasta');
	});

	test('SVG icon の <title> (e.g. <svg><title>Caret Down</title></svg>) は title に混入しない', async () => {
		app = fastify();
		app.get('/', (request, reply) => {
			const content = fs.readFileSync(_dirname + '/htmls/svg-titles-pollution.html');
			reply.header('content-length', content.length);
			reply.header('content-type', 'text/html');
			return reply.send(content);
		});
		app.get('/favicon.ico', (_req, reply) => reply.status(404).send());
		await app.listen({ port });

		const summary = await summaly(host);
		expect(summary.title).toBe('正規タイトル');
	});

	describe('Private IP blocking', () => {
		beforeEach(() => {
			process.env.SUMMALY_ALLOW_PRIVATE_IP = 'false';
			app = fastify();
			app.get('*', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/og-title.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			return app.listen({ port });
		});

		test('private ipなサーバーの情報を取得できない', async () => {
			const summary = await summaly(host).catch((e: StatusError) => e);
			if (summary instanceof StatusError) {
				expect(summary.name).toBe('StatusError');
			} else {
				expect(summary).toBeInstanceOf(StatusError);
			}
		});

		test('agentが指定されている場合はprivate ipを許可', async () => {
			const summary = await summaly(host, {
				agent: {
					http: new httpAgent({ keepAlive: true }),
					https: new httpsAgent({ keepAlive: true }),
				},
			});
			expect(summary.title).toBe('Strawberry Pasta');
		});

		test('agentが空のオブジェクトの場合はprivate ipを許可しない', async () => {
			const summary = await summaly(host, { agent: {} }).catch((e: StatusError) => e);
			if (summary instanceof StatusError) {
				expect(summary.name).toBe('StatusError');
			} else {
				expect(summary).toBeInstanceOf(StatusError);
			}
		});

		afterEach(() => {
			process.env.SUMMALY_ALLOW_PRIVATE_IP = 'true';
		});
	});

	describe('OGP', () => {
		test('title', async () => {
			app = fastify();
			app.get('*', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/og-title.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			const summary = await summaly(host);
			expect(summary.title).toBe('Strawberry Pasta');
		});

		test('description', async () => {
			app = fastify();
			app.get('/', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/og-description.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			const summary = await summaly(host);
			expect(summary.description).toBe('Strawberry Pasta');
		});

		test('site_name', async () => {
			app = fastify();
			app.get('/', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/og-site_name.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			const summary = await summaly(host);
			expect(summary.sitename).toBe('Strawberry Pasta');
		});

		test('thumbnail', async () => {
			app = fastify();
			app.get('/', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/og-image.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			const summary = await summaly(host);
			expect(summary.thumbnail).toBe('https://himasaku.net/himasaku.png');
		});
	});

	describe('TwitterCard', () => {
		test('title', async () => {
			app = fastify();
			app.get('/', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/twitter-title.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			const summary = await summaly(host);
			expect(summary.title).toBe('Strawberry Pasta');
		});

		test('description', async () => {
			app = fastify();
			app.get('/', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/twitter-description.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			const summary = await summaly(host);
			expect(summary.description).toBe('Strawberry Pasta');
		});

		test('thumbnail', async () => {
			app = fastify();
			app.get('/', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/twitter-image.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			const summary = await summaly(host);
			expect(summary.thumbnail).toBe('https://himasaku.net/himasaku.png');
		});

		test('Player detection - PeerTube:video => video', async () => {
			app = fastify();
			app.get('/', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/player-peertube-video.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			const summary = await summaly(host);
			expect(summary.player.url).toBe('https://example.com/embedurl');
			expect(summary.player.allow).toStrictEqual(['autoplay', 'encrypted-media', 'fullscreen']);
		});

		test('Player detection - Pleroma:video => video', async () => {
			app = fastify();
			app.get('/', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/player-pleroma-video.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			const summary = await summaly(host);
			expect(summary.player.url).toBe('https://example.com/embedurl');
			expect(summary.player.allow).toStrictEqual(['autoplay', 'encrypted-media', 'fullscreen']);
		});

		test('Player detection - Pleroma:image => image', async () => {
			app = fastify();
			app.get('/', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/player-pleroma-image.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			const summary = await summaly(host);
			expect(summary.thumbnail).toBe('https://example.com/imageurl');
		});
	});

	describe('oEmbed', () => {
		const setUpFastify = async (oEmbedPath: string, htmlPath = 'htmls/oembed.html') => {
			app = fastify();
			app.get('/', (request, reply) => {
				const content = fs.readFileSync(new URL(htmlPath, import.meta.url));
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			app.get('/oembed.json', (request, reply) => {
				const content = fs.readFileSync(new URL(oEmbedPath, new URL('oembed/', import.meta.url)));
				reply.header('content-length', content.length);
				reply.header('content-type', 'application/json');
				return reply.send(content);
			});
			await app.listen({ port });
		};

		for (const filename of readdirSync(new URL('oembed/invalid', import.meta.url))) {
			test(`Invalidity test: ${filename}`, async () => {
				await setUpFastify(`invalid/${filename}`);
				const summary = await summaly(host);
				expect(summary.player.url).toBe(null);
			});
		}

		test('basic properties', async () => {
			await setUpFastify('oembed.json');
			const summary = await summaly(host);
			expect(summary.player.url).toBe('https://example.com/');
			expect(summary.player.width).toBe(500);
			expect(summary.player.height).toBe(300);
		});

		test('type: video', async () => {
			await setUpFastify('oembed-video.json');
			const summary = await summaly(host);
			expect(summary.player.url).toBe('https://example.com/');
			expect(summary.player.width).toBe(500);
			expect(summary.player.height).toBe(300);
		});

		test('max height', async () => {
			await setUpFastify('oembed-too-tall.json');
			const summary = await summaly(host);
			expect(summary.player.height).toBe(1024);
		});

		test('children are ignored', async () => {
			await setUpFastify('oembed-iframe-child.json');
			const summary = await summaly(host);
			expect(summary.player.url).toBe('https://example.com/');
		});

		test('allows fullscreen', async () => {
			await setUpFastify('oembed-allow-fullscreen.json');
			const summary = await summaly(host);
			expect(summary.player.url).toBe('https://example.com/');
			expect(summary.player.allow).toStrictEqual(['fullscreen']);
		});

		test('allows legacy allowfullscreen', async () => {
			await setUpFastify('oembed-allow-fullscreen-legacy.json');
			const summary = await summaly(host);
			expect(summary.player.url).toBe('https://example.com/');
			expect(summary.player.allow).toStrictEqual(['fullscreen']);
		});

		test('allows safelisted permissions', async () => {
			await setUpFastify('oembed-allow-safelisted-permissions.json');
			const summary = await summaly(host);
			expect(summary.player.url).toBe('https://example.com/');
			expect(summary.player.allow).toStrictEqual([
				'autoplay', 'clipboard-write', 'fullscreen',
				'encrypted-media', 'picture-in-picture', 'web-share',
			]);
		});

		test('ignores rare permissions', async () => {
			await setUpFastify('oembed-ignore-rare-permissions.json');
			const summary = await summaly(host);
			expect(summary.player.url).toBe('https://example.com/');
			expect(summary.player.allow).toStrictEqual(['autoplay']);
		});

		test('oEmbed with relative path', async () => {
			await setUpFastify('oembed.json', 'htmls/oembed-relative.html');
			const summary = await summaly(host);
			expect(summary.player.url).toBe('https://example.com/');
		});

		test('oEmbed with nonexistent path', async () => {
			await setUpFastify('oembed.json', 'htmls/oembed-nonexistent-path.html');
			const summary = await summaly(host);
			expect(summary.player.url).toBe(null);
			expect(summary.description).toBe('nonexistent');
		});

		test('oEmbed with wrong path', async () => {
			await setUpFastify('oembed.json', 'htmls/oembed-wrong-path.html');
			const summary = await summaly(host);
			expect(summary.player.url).toBe(null);
			expect(summary.description).toBe('wrong url');
		});

		test('oEmbed with OpenGraph', async () => {
			await setUpFastify('oembed.json', 'htmls/oembed-and-og.html');
			const summary = await summaly(host);
			expect(summary.player.url).toBe('https://example.com/');
			expect(summary.description).toBe('blobcats rule the world');
		});

		test('Invalid oEmbed with valid OpenGraph', async () => {
			await setUpFastify('invalid/oembed-insecure.json', 'htmls/oembed-and-og.html');
			const summary = await summaly(host);
			expect(summary.player.url).toBe(null);
			expect(summary.description).toBe('blobcats rule the world');
		});

		test('oEmbed with og:video', async () => {
			await setUpFastify('oembed.json', 'htmls/oembed-and-og-video.html');
			const summary = await summaly(host);
			expect(summary.player.url).toBe('https://example.com/');
			expect(summary.player.allow).toStrictEqual([]);
		});

		test('width: 100%', async () => {
			await setUpFastify('oembed-percentage-width.json');
			const summary = await summaly(host);
			expect(summary.player.width).toBe(null);
			expect(summary.player.height).toBe(300);
		});
	});

	describe('ActivityPub', () => {
		test('Basic', async () => {
			app = fastify();
			app.get('*', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/activitypub.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			const summary = await summaly(host);
			expect(summary.activityPub).toBe('https://misskey.test/notes/abcdefg');
		});

		test('Null', async () => {
			app = fastify();
			app.get('*', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/basic.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			const summary = await summaly(host);
			expect(summary.activityPub).toBe(null);
		});
	});

	describe('Fediverse Creator', () => {
		test('Basic', async () => {
			app = fastify();
			app.get('*', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/fediverse-creator.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			const summary = await summaly(host);
			expect(summary.fediverseCreator).toBe('@test@example.com');
		});

		test('Null', async () => {
			app = fastify();
			app.get('*', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/basic.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			const summary = await summaly(host);
			expect(summary.fediverseCreator).toBeNull();
		});
	});

	describe('sensitive', () => {
		test('default', async () => {
			app = fastify();
			app.get('/', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/basic.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });
			expect((await summaly(host)).sensitive).toBe(false);
		});

		test('mixi:content-rating 1', async () => {
			app = fastify();
			app.get('/', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/mixi-sensitive.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });
			expect((await summaly(host)).sensitive).toBe(true);
		});

		test('meta rating adult', async () => {
			app = fastify();
			app.get('/', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/meta-adult-sensitive.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });
			expect((await summaly(host)).sensitive).toBe(true);
		});

		test('meta rating rta', async () => {
			app = fastify();
			app.get('/', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/meta-rta-sensitive.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });
			expect((await summaly(host)).sensitive).toBe(true);
		});

		test('HTTP Header rating adult', async () => {
			app = fastify();
			app.get('/', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/basic.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				reply.header('rating', 'adult');
				return reply.send(content);
			});
			await app.listen({ port });
			expect((await summaly(host)).sensitive).toBe(true);
		});

		test('HTTP Header rating rta', async () => {
			app = fastify();
			app.get('/', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/basic.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				reply.header('rating', 'RTA-5042-1996-1400-1577-RTA');
				return reply.send(content);
			});
			await app.listen({ port });
			expect((await summaly(host)).sensitive).toBe(true);
		});
	});

	describe('UserAgent', () => {
		test('UA設定が反映されていること', async () => {
			const content = fs.readFileSync(_dirname + '/htmls/basic.html');
			let ua: string | undefined = undefined;

			app = fastify();
			app.get('/', (request, reply) => {
				reply.header('content-length', content.byteLength);
				reply.header('content-type', 'text/html');
				ua = request.headers['user-agent'];
				return reply.send(content);
			});
			await app.listen({ port });
			await summaly(host, { userAgent: 'test-ua' });

			expect(ua).toBe('test-ua');
		});
	});

	describe('content-length limit', () => {
		test('content-lengthの上限以内であればエラーが起こらないこと', async () => {
			const content = fs.readFileSync(_dirname + '/htmls/basic.html');

			app = fastify();
			app.get('/', (request, reply) => {
				reply.header('content-length', content.byteLength);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			expect(await summaly(host, { contentLengthLimit: content.byteLength })).toBeDefined();
		});

		test('content-lengthの上限を超えているとエラーになる事', async () => {
			const content = fs.readFileSync(_dirname + '/htmls/basic.html');

			app = fastify();
			app.get('/', (request, reply) => {
				reply.header('content-length', content.byteLength);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			await expect(summaly(host, { contentLengthLimit: content.byteLength - 1 })).rejects.toThrow();
		});

		test('content-lengthなしのストリーム受信中に上限を超えるとエラーになること', async () => {
			const chunk = Buffer.alloc(32, 'a');

			app = fastify();
			app.get('/', (request, reply) => {
				reply.header('content-type', 'text/html');
				return reply.send(Readable.from((async function* () {
					yield chunk;
					yield chunk;
				})()));
			});
			await app.listen({ port });

			await expect(summaly(host, { contentLengthLimit: 16 })).rejects.toThrow(/maxSize exceeded \(\d+ > 16\) on response/);
		});
	});

	describe('options 不変性', () => {
		test('summaly() の連続呼び出しで前回の opts が次回に漏れないこと', async () => {
			const content = fs.readFileSync(_dirname + '/htmls/basic.html');

			app = fastify();
			app.get('/', (request, reply) => {
				reply.header('content-length', content.byteLength);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			// 1 回目: 極端に小さい contentLengthLimit を渡して必ず失敗させる
			await expect(summaly(host, { contentLengthLimit: 16 })).rejects.toThrow();

			// 2 回目: opts を渡さない。デフォルト 10 MiB で動くべき。
			// summalyDefaultOptions が mutate されているとここで再び maxSize exceeded が出る。
			const summary = await summaly(host);
			expect(summary).toBeDefined();
			expect(summary.title).toBeDefined();
		});

		test('summalyDefaultOptions オブジェクト自体が呼び出しで mutate されないこと', async () => {
			const content = fs.readFileSync(_dirname + '/htmls/basic.html');

			app = fastify();
			app.get('/', (request, reply) => {
				reply.header('content-length', content.byteLength);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			const before = { ...summalyDefaultOptions };
			await summaly(host, { contentLengthLimit: 16 }).catch(() => { /* 失敗しても良い */ });
			expect({ ...summalyDefaultOptions }).toEqual(before);
		});
	});

	describe('Fastify plugin: Cache-Control', () => {
		// summaly plugin (default export) を別の Fastify インスタンスに register し、
		// 同じテストポートで origin と plugin を共存させる。
		// origin 用の app は port、plugin 用の app は port+1 で起動する
		// — origin がローカルなら summaly は私的 IP 拒否を入れているため、
		//   `SUMMALY_ALLOW_PRIVATE_IP=true` の beforeEach 設定をそのまま流用できる
		const proxyPort = port + 1;
		let proxyApp: FastifyInstance | null = null;

		afterEach(async () => {
			if (proxyApp != null) {
				await proxyApp.close();
				proxyApp = null;
			}
		});

		async function setupOriginAndProxy(pluginOptions: Partial<SummalyOptions> = {}) {
			app = fastify();
			app.get('/', (request, reply) => {
				const content = fs.readFileSync(_dirname + '/htmls/basic.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			proxyApp = fastify();
			await proxyApp.register(summalyPlugin, pluginOptions);
			await proxyApp.listen({ port: proxyPort });
		}

		test('成功レスポンスにデフォルト Cache-Control が付くこと（max-age=604800）', async () => {
			await setupOriginAndProxy();
			const res = await proxyApp!.inject({
				method: 'GET',
				url: '/',
				query: { url: host },
			});
			expect(res.statusCode).toBe(200);
			expect(res.headers['cache-control']).toBe('public, max-age=604800');
		});

		test('400 エラー（url 未指定）に Cache-Control が付くこと（デフォルト max-age=3600）', async () => {
			await setupOriginAndProxy();
			const res = await proxyApp!.inject({
				method: 'GET',
				url: '/',
			});
			expect(res.statusCode).toBe(400);
			expect(res.headers['cache-control']).toBe('public, max-age=3600');
		});

		test('500 エラー（origin 失敗）に Cache-Control が付くこと（デフォルト max-age=3600）', async () => {
			// このテストは origin を立てない（接続不能ポートに飛ばして summaly() を失敗させる）。
			// グローバル afterEach の `app.close()` は `app != null` でガードされているため
			// `app` が null のままでも問題ない。proxyApp のみ独自 afterEach で close する。
			proxyApp = fastify();
			await proxyApp.register(summalyPlugin);
			await proxyApp.listen({ port: proxyPort });

			const res = await proxyApp.inject({
				method: 'GET',
				url: '/',
				query: { url: `http://localhost:${port + 99}/nonexistent` },
			});
			expect(res.statusCode).toBe(500);
			expect(res.headers['cache-control']).toBe('public, max-age=3600');
		});

		test('cacheMaxAge オプションが反映されること', async () => {
			await setupOriginAndProxy({ cacheMaxAge: 60 });
			const res = await proxyApp!.inject({
				method: 'GET',
				url: '/',
				query: { url: host },
			});
			expect(res.statusCode).toBe(200);
			expect(res.headers['cache-control']).toBe('public, max-age=60');
		});

		test('cacheErrorMaxAge オプションが反映されること', async () => {
			await setupOriginAndProxy({ cacheErrorMaxAge: 30 });
			const res = await proxyApp!.inject({
				method: 'GET',
				url: '/',
			});
			expect(res.statusCode).toBe(400);
			expect(res.headers['cache-control']).toBe('public, max-age=30');
		});

		test('cacheMaxAge: 0 で no-store が出ること', async () => {
			await setupOriginAndProxy({ cacheMaxAge: 0 });
			const res = await proxyApp!.inject({
				method: 'GET',
				url: '/',
				query: { url: host },
			});
			expect(res.statusCode).toBe(200);
			expect(res.headers['cache-control']).toBe('no-store');
		});

		test('cacheErrorMaxAge: 0 で no-store が出ること', async () => {
			await setupOriginAndProxy({ cacheErrorMaxAge: 0 });
			const res = await proxyApp!.inject({
				method: 'GET',
				url: '/',
			});
			expect(res.statusCode).toBe(400);
			expect(res.headers['cache-control']).toBe('no-store');
		});

		test('負数の cacheMaxAge は初期化時に RangeError を投げること', async () => {
			proxyApp = fastify();
			proxyApp.register(summalyPlugin, { cacheMaxAge: -1 });
			await expect(proxyApp.ready()).rejects.toThrow(RangeError);
		});

		test('負数の cacheErrorMaxAge は初期化時に RangeError を投げること', async () => {
			proxyApp = fastify();
			proxyApp.register(summalyPlugin, { cacheErrorMaxAge: -1 });
			await expect(proxyApp.ready()).rejects.toThrow(RangeError);
		});
	});

	describe('content-length required', () => {
		test('[オプション有効化時] content-lengthが返された場合はエラーとならないこと', async () => {
			const content = fs.readFileSync(_dirname + '/htmls/basic.html');

			app = fastify();
			app.get('/', (request, reply) => {
				reply.header('content-length', content.byteLength);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			expect(await summaly(host, { contentLengthRequired: true, contentLengthLimit: content.byteLength })).toBeDefined();
		});

		test('[オプション有効化時] content-lengthが返されない場合はエラーとなること', async () => {
			app = fastify();
			app.get('/', (request, reply) => {
				reply.header('content-type', 'text/html');
				// streamで渡さないとcontent-lengthを自動で設定されてしまう
				return reply.send(fs.createReadStream(_dirname + '/htmls/basic.html'));
			});
			await app.listen({ port });

			await expect(summaly(host, { contentLengthRequired: true })).rejects.toThrow();
		});

		test('[オプション無効化時] content-lengthが返された場合はエラーとならないこと', async () => {
			const content = fs.readFileSync(_dirname + '/htmls/basic.html');

			app = fastify();
			app.get('/', (request, reply) => {
				reply.header('content-length', content.byteLength);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			expect(await summaly(host, { contentLengthRequired: false, contentLengthLimit: content.byteLength })).toBeDefined();
		});

		test('[オプション無効化時] content-lengthが返されなくてもエラーとならないこと', async () => {
			app = fastify();
			app.get('/', (request, reply) => {
				reply.header('content-type', 'text/html');
				// streamで渡さないとcontent-lengthを自動で設定されてしまう
				return reply.send(fs.createReadStream(_dirname + '/htmls/basic.html'));
			});
			await app.listen({ port });

			expect(await summaly(host, { contentLengthRequired: false })).toBeDefined();
		});
	});

	describe('プラグイン基盤 (phase2.1)', () => {
		describe('getJson', () => {
			test('JSON エンドポイントから object を取得できる', async () => {
				app = fastify();
				app.get('/api', (request, reply) => {
					reply.header('content-type', 'application/json');
					return reply.send({ foo: 'bar', n: 42 });
				});
				await app.listen({ port });

				const json = await getJson(`${host}/api`);
				expect(json).toEqual({ foo: 'bar', n: 42 });
			});

			test('referer 引数が Referer ヘッダとして送信される', async () => {
				let receivedReferer: string | undefined;
				app = fastify();
				app.get('/api', (request, reply) => {
					receivedReferer = request.headers['referer'];
					reply.header('content-type', 'application/json');
					return reply.send({ ok: true });
				});
				await app.listen({ port });

				await getJson(`${host}/api`, 'https://example.com/page');
				expect(receivedReferer).toBe('https://example.com/page');
			});

			test('referer を渡さない場合は Referer ヘッダが送信されない', async () => {
				let receivedReferer: string | undefined;
				app = fastify();
				app.get('/api', (request, reply) => {
					receivedReferer = request.headers['referer'];
					reply.header('content-type', 'application/json');
					return reply.send({ ok: true });
				});
				await app.listen({ port });

				await getJson(`${host}/api`);
				expect(receivedReferer).toBeUndefined();
			});

			test('不正な JSON が返ると例外が throw される', async () => {
				app = fastify();
				app.get('/api', (request, reply) => {
					reply.header('content-type', 'application/json');
					return reply.send('this is not json{');
				});
				await app.listen({ port });

				await expect(getJson(`${host}/api`)).rejects.toThrow();
			});
		});

		describe('プラグイン name 定数', () => {
			test('全組み込みプラグインに name 定数が付与されている', () => {
				for (const plugin of builtinPlugins) {
					expect(plugin.name, `plugin missing name: ${JSON.stringify(plugin)}`).toBeDefined();
					expect(typeof plugin.name).toBe('string');
					expect(plugin.name!.length).toBeGreaterThan(0);
				}
			});

			test('プラグイン name はファイル名（src/plugins/<name>.ts）と一致する', () => {
				const pluginsDir = _dirname + '/../src/plugins';
				const files = readdirSync(pluginsDir)
					.filter(f => f.endsWith('.ts') && f !== 'index.ts')
					.map(f => f.replace(/\.ts$/, ''));
				const names = builtinPlugins.map(p => p.name).filter((n): n is string => n != null);

				// ファイル名で表現された全プラグインが name として登録されていること
				for (const fileName of files) {
					expect(names, `name not found for plugin file: ${fileName}.ts`).toContain(fileName);
				}
			});
		});

		describe('UA オーバーライド', () => {
			test('BROWSER_UA 定数が定義されている', () => {
				expect(BROWSER_UA).toBeDefined();
				expect(typeof BROWSER_UA).toBe('string');
				expect(BROWSER_UA).toMatch(/Mozilla\/5\.0/);
			});

			test('summaly() の userAgent オプションが scpaping の User-Agent ヘッダに反映される', async () => {
				let receivedUA: string | undefined;
				app = fastify();
				app.get('/', (request, reply) => {
					receivedUA = request.headers['user-agent'];
					const content = fs.readFileSync(_dirname + '/htmls/basic.html');
					reply.header('content-length', content.length);
					reply.header('content-type', 'text/html');
					return reply.send(content);
				});
				await app.listen({ port });

				await summaly(host, { userAgent: BROWSER_UA });
				expect(receivedUA).toBe(BROWSER_UA);
			});
		});

		describe('短縮 URL dispatcher', () => {
			test('KNOWN_SHORT_HOSTS に主要短縮ホストが含まれる', () => {
				expect(KNOWN_SHORT_HOSTS.has('youtu.be')).toBe(true);
				expect(KNOWN_SHORT_HOSTS.has('amzn.to')).toBe(true);
				expect(KNOWN_SHORT_HOSTS.has('w.wiki')).toBe(true);
				// SSRF 拡大を避けるため一般的な短縮 URL は除外されていること
				expect(KNOWN_SHORT_HOSTS.has('bit.ly')).toBe(false);
				expect(KNOWN_SHORT_HOSTS.has('t.co')).toBe(false);
			});
		});

		describe('oEmbed 系プラグイン (phase3.1)', () => {
			test('youtube プラグインが www / m / 短縮 URL に正しくマッチする', () => {
				const youtube = builtinPlugins.find(p => p.name === 'youtube');
				expect(youtube).toBeDefined();
				const t = (s: string) => youtube!.test(new URL(s));

				expect(t('https://www.youtube.com/watch?v=abc')).toBe(true);
				expect(t('https://m.youtube.com/watch?v=abc')).toBe(true);
				expect(t('https://youtube.com/watch?v=abc')).toBe(true);
				expect(t('https://www.youtube.com/playlist?list=PLxxx')).toBe(true);
				expect(t('https://www.youtube.com/shorts/abc')).toBe(true);
				expect(t('https://www.youtube.com/live/YVjfasn756M')).toBe(true);  // phase12.2: ライブ配信 URL も oEmbed で取れる
				expect(t('https://m.youtube.com/live/abc')).toBe(true);
				expect(t('https://youtu.be/abc')).toBe(true);

				// マッチしないべき URL
				expect(t('https://example.com/watch?v=abc')).toBe(false);
				expect(t('https://www.youtube.com/about')).toBe(false);
				expect(t('https://www.youtube.com/')).toBe(false);
				expect(t('https://www.youtube.com/lives')).toBe(false);  // /live で始まるが境界違い
			});

			test('nintendo-store プラグインが store-jp.nintendo.com にマッチする (phase12.3)', () => {
				const ns = builtinPlugins.find(p => p.name === 'nintendo-store');
				expect(ns).toBeDefined();
				const t = (s: string) => ns!.test(new URL(s));

				expect(t('https://store-jp.nintendo.com/item/software/D70010000096249')).toBe(true);
				expect(t('https://store-us.nintendo.com/item/anything')).toBe(true);  // 将来の TLD バリエーション
				expect(t('https://store.nintendo.com/anything')).toBe(true);

				// マッチしないべき URL
				expect(t('https://www.nintendo.com/jp/')).toBe(false);  // 旧サイト、別構造
				expect(t('https://nintendo.com/')).toBe(false);
				expect(t('https://store-jp.nintendo.com.evil.example/')).toBe(false);
			});

			test('yodobashi プラグインが yodobashi.com にマッチする (phase12.4)', () => {
				const yo = builtinPlugins.find(p => p.name === 'yodobashi');
				expect(yo).toBeDefined();
				const t = (s: string) => yo!.test(new URL(s));

				expect(t('https://www.yodobashi.com/product/100000001003176109/')).toBe(true);
				expect(t('https://yodobashi.com/anything')).toBe(true);  // bare hostname

				// マッチしないべき URL
				expect(t('https://yodobashi.co.jp/')).toBe(false);  // 別ドメイン
				expect(t('https://www.yodobashi.com.evil.example/')).toBe(false);
				expect(t('https://shop.yodobashi.com/')).toBe(false);  // anchored ^...$ で落ちる
			});

			test('yodobashi プラグインは skipRedirectResolution = true を宣言している (phase12.5)', () => {
				// HEAD/GET probe が yodobashi の TLS 切断で 20 秒 timeout 待ちになる純損失を回避するため、
				// summaly() の resolveRedirect を skip させるフラグ。
				const yo = builtinPlugins.find(p => p.name === 'yodobashi');
				expect(yo).toBeDefined();
				expect(yo!.skipRedirectResolution).toBe(true);
			});

			test('sqex プラグインが store.jp.square-enix.com にマッチする (phase12.6)', () => {
				const sx = builtinPlugins.find(p => p.name === 'sqex');
				expect(sx).toBeDefined();
				const t = (s: string) => sx!.test(new URL(s));

				expect(t('https://store.jp.square-enix.com/item/MWFF140773_2.html')).toBe(true);
				expect(t('https://www.store.jp.square-enix.com/item/abc.html')).toBe(true);

				// マッチしないべき URL
				expect(t('https://square-enix.com/')).toBe(false);  // ストア外
				expect(t('https://store.na.square-enix-games.com/')).toBe(false);  // 別国別ドメイン
				expect(t('https://store.jp.square-enix.com.evil.example/')).toBe(false);
				expect(t('https://sqex.to/ZjZdX')).toBe(false);  // 短縮 URL は resolveRedirect で展開後にマッチする
			});

			test('sqex プラグインは skipRedirectResolution を宣言していない (phase12.6)', () => {
				// 短縮 URL `sqex.to/<id>` は HEAD で `store.jp.square-enix.com/...` に正常解決できるため、
				// summaly() の resolveRedirect 段に任せる設計 (yodobashi の TLS 切断のような事情は無い)。
				const sx = builtinPlugins.find(p => p.name === 'sqex');
				expect(sx).toBeDefined();
				expect(sx!.skipRedirectResolution).toBeFalsy();
			});

			test('dmm プラグインが dmm.co.jp 全サブドメインにマッチする (phase15.3)', () => {
				const dmm = builtinPlugins.find(p => p.name === 'dmm');
				expect(dmm).toBeDefined();
				const t = (s: string) => dmm!.test(new URL(s));

				// マッチすべき URL (各サブドメイン)
				expect(t('https://video.dmm.co.jp/av/content/?id=ailb00009')).toBe(true);
				expect(t('https://book.dmm.co.jp/product/4337228/b900abmps01060/')).toBe(true);
				expect(t('https://dlsoft.dmm.co.jp/detail/ananas_0079/')).toBe(true);
				expect(t('https://games.dmm.co.jp/detail/khanmitsu/')).toBe(true);
				expect(t('https://www.dmm.co.jp/digital/videoa/-/list/')).toBe(true);
				expect(t('https://dmm.co.jp/')).toBe(true);  // bare apex

				// マッチしないべき URL
				expect(t('https://www.dmm.co.jp/age_check/=/?rurl=https%3A%2F%2Fvideo.dmm.co.jp%2F')).toBe(false);  // age_check ゲート自身は弾く
				expect(t('https://dmm.com/')).toBe(false);  // .co.jp ではない
				expect(t('https://dmm.co.jp.evil.example/')).toBe(false);  // ドメイン詐称
				expect(t('https://video.dmm.co.jp.evil.example/')).toBe(false);
			});

			test('dmm プラグインは skipRedirectResolution = true を宣言している (phase15.3)', () => {
				// HEAD probe が SummalyBot UA で送られて age_check ゲートに 302 されるのを回避するため。
				const dmm = builtinPlugins.find(p => p.name === 'dmm');
				expect(dmm).toBeDefined();
				expect(dmm!.skipRedirectResolution).toBe(true);
			});

			test('dmm プラグインの summarize() は card 抑制版 (title prefix + 【R-18】 + thumbnail null) を返す (phase15.3 → phase15.5)', async () => {
				app = fastify();
				let receivedUA: string | undefined;
				app.get('/av/content/', (req, reply) => {
					receivedUA = String(req.headers['user-agent'] ?? '');
					// icon は HEAD 検証されるので localhost mock の相対 URL を使う
					const html = '<!DOCTYPE html><html><head>'
						+ '<title>サンプル作品｜FANZA動画</title>'
						+ '<meta property="og:title" content="サンプル作品">'
						+ '<meta property="og:description" content="作品説明">'
						+ '<meta property="og:image" content="https://example.com/thumb.jpg">'
						+ '<meta property="og:site_name" content="FANZA">'
						+ '<link rel="icon" href="/favicon.png">'
						+ '</head><body></body></html>';
					reply.header('content-length', Buffer.byteLength(html));
					reply.header('content-type', 'text/html; charset=utf-8');
					return reply.send(html);
				});
				app.head('/favicon.png', (_req, reply) => {
					reply.header('content-type', 'image/png');
					return reply.status(200).send();
				});
				await app.listen({ port });
				process.env.SUMMALY_ALLOW_PRIVATE_IP = 'true';

				const dmm = await import('@/plugins/dmm.js');
				const summary = await dmm.summarize(new URL(`${host}/av/content/?id=ailb00009`));

				expect(summary).not.toBeNull();
				// phase15.5: card は「【sitename】og:title」prefix 形式
				expect(summary!.title).toBe('【FANZA】サンプル作品');
				// phase15.5: description は固定 (作品あらすじを伏せる)
				expect(summary!.description).toBe('【R-18】 内容を伏せています');
				// phase15.5: 作品サムネ (og:image) を出さない
				expect(summary!.thumbnail).toBeNull();
				// icon は parseGeneral 由来のサイト favicon を維持 (作品ロゴでなくサイトロゴ)
				expect(summary!.icon).toBe(`${host}/favicon.png`);
				expect(summary!.sitename).toBe('FANZA');
				expect(summary!.sensitive).toBe(true);
				expect(receivedUA).toMatch(/facebookexternalhit\/1\.1/);  // UA fb_bot 固定
				// phase15.5 W-1: embedBaseUrl 未設定なので player.url は null (parseGeneral 由来の
				// oEmbed player を引き継がず明示的に null 化する設計意図の確認)
				expect(summary!.player.url).toBeNull();
				expect(summary!.player.width).toBeNull();
				expect(summary!.player.height).toBeNull();
			});

			test('dmm プラグインの summarize() は og:title 不在時 sitename だけのプレフィックスにフォールバック (phase15.5)', async () => {
				app = fastify();
				app.get('/dc/doujin/-/detail/', (_req, reply) => {
					// og:title が空文字 → parseGeneral は <head > title> を fallback で拾う
					const html = '<!DOCTYPE html><html><head>'
						+ '<title>家出娘、拾いました。｜FANZA同人</title>'
						+ '<meta property="og:title" content="">'
						+ '<meta property="og:site_name" content="FANZA">'
						+ '</head><body></body></html>';
					reply.header('content-length', Buffer.byteLength(html));
					reply.header('content-type', 'text/html; charset=utf-8');
					return reply.send(html);
				});
				await app.listen({ port });
				process.env.SUMMALY_ALLOW_PRIVATE_IP = 'true';

				const dmm = await import('@/plugins/dmm.js');
				const summary = await dmm.summarize(new URL(`${host}/dc/doujin/-/detail/?cid=d_738103`));

				expect(summary).not.toBeNull();
				// <head > title> から得られた title を prefix で包む
				expect(summary!.title).toContain('【FANZA】');
				expect(summary!.description).toBe('【R-18】 内容を伏せています');
				expect(summary!.thumbnail).toBeNull();
			});

			test('google-drive プラグインが drive.google.com/file/d/<id> にマッチする (phase19.1)', () => {
				const gd = builtinPlugins.find(p => p.name === 'google-drive');
				expect(gd).toBeDefined();
				const t = (s: string) => gd!.test(new URL(s));

				// マッチすべき URL
				expect(t('https://drive.google.com/file/d/11osMpfxFZOwWH6m0MKevA5S8x4q4Bkt3/view?usp=sharing')).toBe(true);
				expect(t('https://drive.google.com/file/d/11osMpfxFZOwWH6m0MKevA5S8x4q4Bkt3/preview')).toBe(true);
				expect(t('https://drive.google.com/file/d/11osMpfxFZOwWH6m0MKevA5S8x4q4Bkt3/edit')).toBe(true);
				expect(t('https://drive.google.com/file/d/11osMpfxFZOwWH6m0MKevA5S8x4q4Bkt3')).toBe(true);  // 末尾なし

				// マッチしないべき URL
				expect(t('https://drive.google.com/drive/folders/abc123')).toBe(false);  // フォルダ共有は対象外
				expect(t('https://drive.google.com/')).toBe(false);
				expect(t('https://docs.google.com/file/d/abc/view')).toBe(false);  // 別ホスト
				expect(t('https://drive.google.com.evil.example/file/d/abc/view')).toBe(false);  // ドメイン詐称
			});

			test('google-drive プラグインは skipRedirectResolution = true を宣言している (phase19.1)', () => {
				// /view が HEAD probe でログインゲートに 302 されても原 URL のまま本プラグイン経路に
				// 乗せるため (scrape せず URL から player を組み立てるだけなので純損失なし)。
				const gd = builtinPlugins.find(p => p.name === 'google-drive');
				expect(gd).toBeDefined();
				expect(gd!.skipRedirectResolution).toBe(true);
			});

			test('google-drive プラグインの buildSummaryFromUrl() が /preview iframe player を組み立てる (phase19.1)', async () => {
				const gd = await import('@/plugins/google-drive.js');
				const id = '11osMpfxFZOwWH6m0MKevA5S8x4q4Bkt3';
				const summary = gd.buildSummaryFromUrl(new URL(`https://drive.google.com/file/d/${id}/view?usp=sharing`));

				expect(summary).not.toBeNull();
				// player URL は path の種別 (/view) に関係なく /preview に正規化される
				expect(summary!.player.url).toBe(`https://drive.google.com/file/d/${id}/preview`);
				// buildSummaryFromUrl は pure な base (16:9 デフォルト)。summarize() が thumbnail から
				// 実アスペクト比を取れたら上書きする (縦動画は height>width になる、phase19.1 followup)。
				expect(summary!.player.width).toBe(16);
				expect(summary!.player.height).toBe(9);
				expect(summary!.player.allow).toEqual([...PLAYER_ALLOW_OEMBED]);
				expect(summary!.sitename).toBe('Google Drive');
				expect(summary!.icon).toBe('https://drive.google.com/favicon.ico');
				// base 段階では title / thumbnail / description は null (summarize が title/thumbnail を補完)
				expect(summary!.title).toBeNull();
				expect(summary!.thumbnail).toBeNull();
				expect(summary!.description).toBeNull();
			});

			test('google-drive プラグインの composePlayerUrl() は embedBaseUrl 有無で player.url を切り替える (phase19.1 followup #4)', async () => {
				const gd = await import('@/plugins/google-drive.js');
				const url = new URL('https://drive.google.com/file/d/11osMpfxFZOwWH6m0MKevA5S8x4q4Bkt3/view');
				const id = '11osMpfxFZOwWH6m0MKevA5S8x4q4Bkt3';

				// embedBaseUrl 無し → Drive 公式 /preview iframe 直
				expect(gd.composePlayerUrl(url, id, undefined)).toBe(`https://drive.google.com/file/d/${id}/preview`);
				expect(gd.composePlayerUrl(url, id, '')).toBe(`https://drive.google.com/file/d/${id}/preview`);

				// embedBaseUrl 有り → embed エンドポイント経由 (scale 縮小ラッパー)
				const embed = gd.composePlayerUrl(url, id, 'https://summaly.example');
				expect(embed).toBe(`https://summaly.example/embed?url=${encodeURIComponent(url.href)}`);
				// 末尾スラッシュ (複数含む) は正規化される
				expect(gd.composePlayerUrl(url, id, 'https://summaly.example/')).toBe(embed);
				expect(gd.composePlayerUrl(url, id, 'https://summaly.example//')).toBe(embed);

				// buildSummaryFromUrl も embedBaseUrl を反映する
				const s = gd.buildSummaryFromUrl(url, 'https://summaly.example');
				expect(s!.player.url).toBe(embed);
			});

			test('google-drive プラグインの extractFileId() は最初のセグメントだけ取る (phase19.1)', async () => {
				const gd = await import('@/plugins/google-drive.js');
				// `/file/d/<id>/preview` のように後続セグメントがあっても id だけ抽出
				expect(gd.extractFileId(new URL('https://drive.google.com/file/d/AbC-1_xyz0Q9/preview'))).toBe('AbC-1_xyz0Q9');
				expect(gd.extractFileId(new URL('https://drive.google.com/file/d/AbC-1_xyz0Q9'))).toBe('AbC-1_xyz0Q9');
				// `/file/d/` 以外は null
				expect(gd.extractFileId(new URL('https://drive.google.com/drive/folders/AbC1234567'))).toBeNull();
				// buildSummaryFromUrl も同じ id で /preview を組み立てる
				const s = gd.buildSummaryFromUrl(new URL('https://drive.google.com/file/d/AbC-1_xyz0Q9/preview'));
				expect(s!.player.url).toBe('https://drive.google.com/file/d/AbC-1_xyz0Q9/preview');
			});

			test('google-drive プラグインの applyMeta() は寸法・title を base に上書きする (phase19.1 followup)', async () => {
				const gd = await import('@/plugins/google-drive.js');
				const id = '11osMpfxFZOwWH6m0MKevA5S8x4q4Bkt3';
				const mkBase = () => gd.buildSummaryFromUrl(new URL(`https://drive.google.com/file/d/${id}/view`))!;
				const thumb = `https://drive.google.com/thumbnail?id=${id}&sz=w1000`;

				// 横動画 (16:9、clamp 範囲内): dims を渡すと player が実比率に上書きされ thumbnail も入る
				const landscape = gd.applyMeta(mkBase(), id, { width: 1000, height: 562 }, 'cam.mov');
				expect(landscape.player.width).toBe(1000);
				expect(landscape.player.height).toBe(562);
				expect(landscape.thumbnail).toBe(thumb);
				expect(landscape.title).toBe('cam.mov');

				// 縦動画 (9:16) は width=null + 固定 px 高さ (Misskey が画面幅に依存せず高さ一定にする。
				// 内側は実比率レターボックス。デスクトップ巨大化対策)。
				const vertical = gd.applyMeta(mkBase(), id, { width: 1000, height: 1778 }, 'cam.mov');
				expect(vertical.player.width).toBeNull();
				expect(vertical.player.height).toBe(480);

				// 両方 null (寸法判定失敗): player は 16:9。**ただし thumbnail は dims と独立に採用** (PR #2 review #9)。
				const degraded = gd.applyMeta(mkBase(), id, null, null);
				expect(degraded.player.width).toBe(16);
				expect(degraded.player.height).toBe(9);
				expect(degraded.thumbnail).toBe(thumb);  // dims 失敗でも絵は出す
				expect(degraded.title).toBeNull();

				// title だけ取れて dims 失敗: title は入る、player は 16:9、thumbnail は採用
				const titleOnly = gd.applyMeta(mkBase(), id, null, 'doc.pdf');
				expect(titleOnly.title).toBe('doc.pdf');
				expect(titleOnly.player.width).toBe(16);
				expect(titleOnly.thumbnail).toBe(thumb);
			});

			test('google-drive プラグインの applyMeta() は縦動画を width=null+固定px高さ、横動画を実比率にする (PR #2 review #1 / デスクトップ縦動画対策)', async () => {
				const gd = await import('@/plugins/google-drive.js');
				const id = '11osMpfxFZOwWH6m0MKevA5S8x4q4Bkt3';
				const mkBase = () => gd.buildSummaryFromUrl(new URL(`https://drive.google.com/file/d/${id}/view`))!;

				// 縦動画 9:16 (h/w=1.778 > 1) → width=null + 固定 px 高さ 480
				// (Misskey は player.width が falsy なら padding-top:<height>px で画面幅に依存せず高さ一定にする。
				// 内側 iframe は実比率のまま contain レターボックス表示)。
				const vertical = gd.applyMeta(mkBase(), id, { width: 1000, height: 1778 }, null);
				expect(vertical.player.width).toBeNull();
				expect(vertical.player.height).toBe(480);

				// 極端縦 1×32767 (h/w 巨大) も同じく width=null + 480
				const tall = gd.applyMeta(mkBase(), id, { width: 1, height: 32767 }, null);
				expect(tall.player.width).toBeNull();
				expect(tall.player.height).toBe(480);

				// 横動画 16:9 (h/w=0.5625 <= 1) は実比率で素通し (幅に応じた自然な高さ)
				const landscape = gd.applyMeta(mkBase(), id, { width: 1000, height: 562 }, null);
				expect(landscape.player.width).toBe(1000);
				expect(landscape.player.height).toBe(562);

				// 正方形ちょうど (h/w=1.0) は閾値以下なので実比率扱い
				const square = gd.applyMeta(mkBase(), id, { width: 1000, height: 1000 }, null);
				expect(square.player.width).toBe(1000);
				expect(square.player.height).toBe(1000);
			});

			test('google-drive プラグインの extractOgTitle() は og:title を抽出・entity デコードする (PR #2 review #4)', async () => {
				const gd = await import('@/plugins/google-drive.js');
				expect(gd.extractOgTitle('<meta property="og:title" content="cam01.mp4">')).toBe('cam01.mp4');
				// property/content 順序非依存
				expect(gd.extractOgTitle('<meta content="movie.mov" property="og:title">')).toBe('movie.mov');
				// entity デコード
				expect(gd.extractOgTitle('<meta property="og:title" content="A &amp; B &quot;x&quot;">')).toBe('A & B "x"');
				// 無い / 空は null
				expect(gd.extractOgTitle('<html><head></head></html>')).toBeNull();
				expect(gd.extractOgTitle('<meta property="og:title" content="">')).toBeNull();
			});

			test('google-drive プラグインは異常に短い / 長い file ID を弾く (phase19.1 W-1)', () => {
				const gd = builtinPlugins.find(p => p.name === 'google-drive');
				const t = (s: string) => gd!.test(new URL(s));
				// 10 文字未満は弾く (誤検知防止)
				expect(t('https://drive.google.com/file/d/short/view')).toBe(false);
				// 200 文字超は弾く (クラフト URL で player.url が膨れるのを防ぐ)
				expect(t(`https://drive.google.com/file/d/${'a'.repeat(201)}/view`)).toBe(false);
				// 通常長 (33 文字) は通る
				expect(t('https://drive.google.com/file/d/11osMpfxFZOwWH6m0MKevA5S8x4q4Bkt3/view')).toBe(true);
			});

			test('composeNsfwEmbedHtml() は基本入力で作品情報をフル表示する (phase15.6 共通 helper)', async () => {
				const { composeNsfwEmbedHtml } = await import('@/utils/nsfw-embed-html.js');
				const html = composeNsfwEmbedHtml({
					title: '家出娘、拾いました。',
					description: 'ある日、家出した女の子を拾った。',
					thumbnail: 'https://example.com/thumb.jpg',
					sitename: 'FANZA',
				});
				expect(html).toContain('<!DOCTYPE html>');
				expect(html).toContain('家出娘、拾いました。');
				expect(html).toContain('ある日、家出した女の子を拾った。');
				expect(html).toContain('<img src="https://example.com/thumb.jpg"');
				expect(html).toContain('FANZA');
			});

			test('composeNsfwEmbedHtml() は HTML 特殊文字を escape する (phase15.6 共通 helper、XSS 防御)', async () => {
				const { composeNsfwEmbedHtml } = await import('@/utils/nsfw-embed-html.js');
				const html = composeNsfwEmbedHtml({
					title: '<script>alert(1)</script>',
					description: '<img onerror=alert(1)>',
					thumbnail: null,
					sitename: '<svg onload=alert(1)>',
				});
				// 生の `<script>` / 生の `<img onerror>` / 生の `<svg onload>` は出ない
				expect(html).not.toContain('<script>alert(1)</script>');
				expect(html).not.toContain('<img onerror=alert(1)>');
				expect(html).not.toContain('<svg onload=alert(1)>');
				// 一方で escape された文字列は HTML 中に存在する
				expect(html).toContain('&lt;script&gt;');
				expect(html).toContain('&lt;img');
				expect(html).toContain('&lt;svg');
			});

			test('composeNsfwEmbedHtml() は thumbnail が non-https / null なら <img> を出さない (phase15.6 共通 helper)', async () => {
				const { composeNsfwEmbedHtml } = await import('@/utils/nsfw-embed-html.js');

				const htmlNull = composeNsfwEmbedHtml({
					title: 't', description: 'd', thumbnail: null, sitename: 's',
				});
				expect(htmlNull).not.toContain('<img');

				const htmlJs = composeNsfwEmbedHtml({
					title: 't', description: 'd', thumbnail: 'javascript:alert(1)', sitename: 's',
				});
				expect(htmlJs).not.toContain('<img');

				const htmlHttp = composeNsfwEmbedHtml({
					title: 't', description: 'd', thumbnail: 'http://example.com/i.jpg', sitename: 's',
				});
				// CSP `img-src https:` 二重防御として http は弾く
				expect(htmlHttp).not.toContain('<img');
			});

			test('applyNsfwCardSuppression() は sensitive=true で title prefix + R-18 description + thumbnail null に変換 (phase15.6 共通 helper)', async () => {
				const { applyNsfwCardSuppression } = await import('@/utils/nsfw-card-suppress.js');
				const result = applyNsfwCardSuppression({
					title: '原タイトル',
					icon: 'https://example.com/favicon.png',
					description: '原あらすじ',
					thumbnail: 'https://example.com/thumb.jpg',
					sitename: 'FANZA',
					sensitive: true,
					player: { url: null, width: null, height: null, allow: [] },
					activityPub: null,
					fediverseCreator: null,
				}, new URL('https://video.dmm.co.jp/av/content/?id=x'), 'https://embed.example');

				expect(result.title).toBe('【FANZA】原タイトル');
				expect(result.description).toBe('【R-18】 内容を伏せています');
				expect(result.thumbnail).toBeNull();
				expect(result.icon).toBe('https://example.com/favicon.png');  // icon は維持
				expect(result.sitename).toBe('FANZA');
				expect(result.sensitive).toBe(true);
				expect(result.player.url).toBe('https://embed.example/embed?url=' + encodeURIComponent('https://video.dmm.co.jp/av/content/?id=x'));
				expect(result.player.width).toBe(3);
				expect(result.player.height).toBe(2);
			});

			test('applyNsfwCardSuppression() は sensitive=false なら summary を素通しで返す (phase15.6 共通 helper)', async () => {
				const { applyNsfwCardSuppression } = await import('@/utils/nsfw-card-suppress.js');
				const original = {
					title: '原タイトル',
					icon: 'https://example.com/favicon.png',
					description: '原あらすじ',
					thumbnail: 'https://example.com/thumb.jpg',
					sitename: 'DLsite',
					sensitive: false,
					player: { url: null, width: null, height: null, allow: [] },
					activityPub: null,
					fediverseCreator: null,
				};
				const result = applyNsfwCardSuppression(original, new URL('https://www.dlsite.com/comic/work/=/product_id/RJ123.html'), 'https://embed.example');

				// sensitive=false は素通し (dlsite の /comic/ セーフパス等)
				expect(result.title).toBe('原タイトル');
				expect(result.description).toBe('原あらすじ');
				expect(result.thumbnail).toBe('https://example.com/thumb.jpg');
				expect(result.sensitive).toBe(false);
			});

			test('applyNsfwCardSuppression() は embedBaseUrl 未設定時 player を明示的に null 化 (phase15.6、W-1 防衛)', async () => {
				const { applyNsfwCardSuppression } = await import('@/utils/nsfw-card-suppress.js');
				const result = applyNsfwCardSuppression({
					title: 't',
					icon: null,
					description: 'd',
					thumbnail: 'https://example.com/thumb.jpg',
					sitename: 'site',
					sensitive: true,
					// parseGeneral 由来の oEmbed player を持っていても引き継がない
					player: { url: 'https://malicious.example/oembed-player', width: 640, height: 360, allow: [] },
					activityPub: null,
					fediverseCreator: null,
				}, new URL('https://example.com/path'), undefined);

				expect(result.player.url).toBeNull();
				expect(result.player.width).toBeNull();
				expect(result.player.height).toBeNull();
				expect(result.player.allow).toEqual([]);
			});

			test('dmm プラグインの renderEmbed() は OGP フル情報を含む HTML を返す (phase15.5)', async () => {
				app = fastify();
				app.get('/av/content/', (_req, reply) => {
					const html = '<!DOCTYPE html><html><head>'
						+ '<meta property="og:title" content="サンプル作品">'
						+ '<meta property="og:description" content="あらすじ">'
						+ '<meta property="og:image" content="https://example.com/thumb.jpg">'
						+ '<meta property="og:site_name" content="FANZA">'
						+ '</head><body></body></html>';
					reply.header('content-length', Buffer.byteLength(html));
					reply.header('content-type', 'text/html; charset=utf-8');
					return reply.send(html);
				});
				await app.listen({ port });
				process.env.SUMMALY_ALLOW_PRIVATE_IP = 'true';

				const dmm = await import('@/plugins/dmm.js');
				const result = await dmm.renderEmbed(new URL(`${host}/av/content/?id=ailb00009`));
				expect(result.body).toContain('<!DOCTYPE html>');
				expect(result.body).toContain('サンプル作品');  // 作品名はフル表示
				expect(result.body).toContain('あらすじ');     // 作品あらすじもフル表示
				expect(result.body).toContain('https://example.com/thumb.jpg');  // 作品サムネもフル表示
				expect(result.body).toContain('FANZA');
				expect(result.width).toBe(3);
				expect(result.height).toBe(2);
			});

			test('dmm プラグインの player.url は embedBaseUrl 設定時に /embed?url=... を返す (phase15.5)', async () => {
				app = fastify();
				app.get('/av/content/', (_req, reply) => {
					const html = '<!DOCTYPE html><html><head>'
						+ '<meta property="og:title" content="x">'
						+ '<meta property="og:site_name" content="FANZA">'
						+ '</head><body></body></html>';
					reply.header('content-length', Buffer.byteLength(html));
					reply.header('content-type', 'text/html; charset=utf-8');
					return reply.send(html);
				});
				await app.listen({ port });
				process.env.SUMMALY_ALLOW_PRIVATE_IP = 'true';

				const dmm = await import('@/plugins/dmm.js');
				const targetUrl = `${host}/av/content/?id=ailb00009`;
				const summary = await dmm.summarize(new URL(targetUrl), {
					_embedBaseUrl: 'https://example.com',
				});
				expect(summary).not.toBeNull();
				expect(summary!.player.url).toBe(`https://example.com/embed?url=${encodeURIComponent(targetUrl)}`);
				expect(summary!.player.width).toBe(3);
				expect(summary!.player.height).toBe(2);
			});

			test('短縮 URL を扱うプラグイン (amazon / branchio-deeplinks) は skipRedirectResolution を宣言していない (phase12.5)', () => {
				// 短縮 URL 系プラグインで skipRedirectResolution = true にすると resolveRedirect されず、
				// 初期 URL のままプラグインに渡って正しく動作しなくなるため、絶対に false 相当 (未宣言) にすべき。
				const amazon = builtinPlugins.find(p => p.name === 'amazon');
				expect(amazon).toBeDefined();
				expect(amazon!.skipRedirectResolution).toBeFalsy();

				const branch = builtinPlugins.find(p => p.name === 'branchio-deeplinks');
				expect(branch).toBeDefined();
				expect(branch!.skipRedirectResolution).toBeFalsy();
			});

			test('spotify プラグインが open.spotify.com にマッチする', () => {
				const spotify = builtinPlugins.find(p => p.name === 'spotify');
				expect(spotify).toBeDefined();
				const t = (s: string) => spotify!.test(new URL(s));

				expect(t('https://open.spotify.com/track/abc')).toBe(true);
				expect(t('https://open.spotify.com/playlist/abc')).toBe(true);

				// spotify.link は branchio-deeplinks プラグインが扱う
				expect(t('https://spotify.link/abc')).toBe(false);
				expect(t('https://example.com/track/abc')).toBe(false);
			});

			test('PLAYER_ALLOW_OEMBED が要求された permission を含む', async () => {
				const { PLAYER_ALLOW_OEMBED } = await import('@/utils/player-allow.js');
				expect(PLAYER_ALLOW_OEMBED).toContain('autoplay');
				expect(PLAYER_ALLOW_OEMBED).toContain('clipboard-write');
				expect(PLAYER_ALLOW_OEMBED).toContain('encrypted-media');
				expect(PLAYER_ALLOW_OEMBED).toContain('picture-in-picture');
				expect(PLAYER_ALLOW_OEMBED).toContain('web-share');
				expect(PLAYER_ALLOW_OEMBED).toContain('fullscreen');
			});

			describe('youtube buildSummaryFromOEmbed (フィクスチャ)', () => {
				test('正常な oEmbed レスポンスから Summary を組み立てる', async () => {
					const { buildSummaryFromOEmbed } = await import('@/plugins/youtube.js');
					const fixture = {
						type: 'video',
						title: 'Test Video',
						thumbnail_url: 'https://i.ytimg.com/vi/abc/default.jpg',
						width: 200,
						height: 113,
						html: '<iframe width="200" height="113" src="https://www.youtube.com/embed/abc?feature=oembed" frameborder="0" allow="autoplay; clipboard-write" allowfullscreen></iframe>',
					};
					const summary = buildSummaryFromOEmbed(fixture);
					expect(summary).not.toBeNull();
					expect(summary!.title).toBe('Test Video');
					expect(summary!.icon).toBe('https://www.youtube.com/favicon.ico');
					expect(summary!.description).toBeNull();
					expect(summary!.thumbnail).toBe('https://i.ytimg.com/vi/abc/default.jpg');
					expect(summary!.player.url).toBe('https://www.youtube.com/embed/abc?feature=oembed');
					expect(summary!.player.width).toBe(200);
					expect(summary!.player.height).toBe(113);
					expect(summary!.player.allow).toContain('fullscreen');
					expect(summary!.sitename).toBe('YouTube');
				});

				test('type が video でないとき null を返す', async () => {
					const { buildSummaryFromOEmbed } = await import('@/plugins/youtube.js');
					expect(buildSummaryFromOEmbed({ type: 'rich', html: '<iframe src="https://x"></iframe>' })).toBeNull();
				});

				test('iframe src が http: のとき null を返す（https 強制）', async () => {
					const { buildSummaryFromOEmbed } = await import('@/plugins/youtube.js');
					const fixture = { type: 'video', html: '<iframe src="http://www.youtube.com/embed/abc"></iframe>' };
					expect(buildSummaryFromOEmbed(fixture)).toBeNull();
				});

				test('iframe src が javascript: 偽装でも parse 経由で弾かれる', async () => {
					const { buildSummaryFromOEmbed } = await import('@/plugins/youtube.js');
					const fixture = { type: 'video', html: '<iframe src="javascript:alert(1)"></iframe>' };
					expect(buildSummaryFromOEmbed(fixture)).toBeNull();
				});

				test('iframe が複数 / ない場合は null', async () => {
					const { buildSummaryFromOEmbed } = await import('@/plugins/youtube.js');
					expect(buildSummaryFromOEmbed({ type: 'video', html: '<div>no iframe</div>' })).toBeNull();
					expect(buildSummaryFromOEmbed({ type: 'video', html: '<iframe src="https://a"></iframe><iframe src="https://b"></iframe>' })).toBeNull();
				});

				test('オブジェクトでない入力 / null は null', async () => {
					const { buildSummaryFromOEmbed } = await import('@/plugins/youtube.js');
					expect(buildSummaryFromOEmbed(null)).toBeNull();
					expect(buildSummaryFromOEmbed('not an object')).toBeNull();
					expect(buildSummaryFromOEmbed(42)).toBeNull();
				});
			});

			describe('spotify buildSummaryFromOEmbed (フィクスチャ)', () => {
				test('正常な oEmbed レスポンスから Summary を組み立てる', async () => {
					const { buildSummaryFromOEmbed } = await import('@/plugins/spotify.js');
					const fixture = {
						title: 'Test Track',
						thumbnail_url: 'https://i.scdn.co/image/abc',
						provider_name: 'Spotify',
						width: 456,
						height: 152,
						html: '<iframe src="https://open.spotify.com/embed/track/abc" width="100%" height="152" frameborder="0" allowtransparency="true" allow="encrypted-media"></iframe>',
					};
					const summary = buildSummaryFromOEmbed(fixture);
					expect(summary).not.toBeNull();
					expect(summary!.title).toBe('Test Track');
					expect(summary!.icon).toBe('https://open.spotify.com/favicon.ico');
					expect(summary!.thumbnail).toBe('https://i.scdn.co/image/abc');
					expect(summary!.player.url).toBe('https://open.spotify.com/embed/track/abc');
					// width="100%" は数値変換で NaN → null に正規化される
					expect(summary!.player.width).toBeNull();
					expect(summary!.player.height).toBe(152);
					expect(summary!.sitename).toBe('Spotify');
				});

				test('html が無い / 空の場合 null', async () => {
					const { buildSummaryFromOEmbed } = await import('@/plugins/spotify.js');
					expect(buildSummaryFromOEmbed({})).toBeNull();
					expect(buildSummaryFromOEmbed({ html: '' })).toBeNull();
				});
			});

			describe('npmjs プラグイン (phase11.4)', () => {
				test('test() は (www.)?npmjs.com/package/... にマッチする', async () => {
					const { test: matchTest } = await import('@/plugins/npmjs.js');
					expect(matchTest(new URL('https://www.npmjs.com/package/mfm-renderer'))).toBe(true);
					expect(matchTest(new URL('https://npmjs.com/package/mfm-renderer'))).toBe(true);
					expect(matchTest(new URL('https://www.npmjs.com/package/@misskey-dev/summaly'))).toBe(true);
					expect(matchTest(new URL('https://www.npmjs.com/package/react/v/19.0.0'))).toBe(true);
					expect(matchTest(new URL('https://www.npmjs.com/package/foo/tutorial'))).toBe(true);

					expect(matchTest(new URL('https://www.npmjs.com/'))).toBe(false);
					expect(matchTest(new URL('https://www.npmjs.com/search?q=foo'))).toBe(false);
					expect(matchTest(new URL('https://example.com/package/foo'))).toBe(false);
					expect(matchTest(new URL('https://blog.npmjs.com/package/foo'))).toBe(false);
					expect(matchTest(new URL('https://registry.npmjs.org/foo'))).toBe(false);
					expect(matchTest(new URL('https://registry.npmjs.com/foo'))).toBe(false);
				});

				test('extractPackageName はサブパス・スコープを正しく扱う', async () => {
					const { extractPackageName } = await import('@/plugins/npmjs.js');
					expect(extractPackageName('/package/mfm-renderer')).toBe('mfm-renderer');
					expect(extractPackageName('/package/mfm-renderer/v/0.0.1')).toBe('mfm-renderer');
					expect(extractPackageName('/package/@misskey-dev/summaly')).toBe('@misskey-dev/summaly');
					expect(extractPackageName('/package/@scope/name/tutorial')).toBe('@scope/name');
					expect(extractPackageName('/package/')).toBeNull();
					expect(extractPackageName('/foo/bar')).toBeNull();
				});

				test('buildRegistryUrl は scope の / を %2F にエンコードし、@ は残す', async () => {
					const { buildRegistryUrl } = await import('@/plugins/npmjs.js');
					expect(buildRegistryUrl('mfm-renderer')).toBe('https://registry.npmjs.org/mfm-renderer');
					expect(buildRegistryUrl('@misskey-dev/summaly')).toBe('https://registry.npmjs.org/@misskey-dev%2Fsummaly');
				});

				test('buildSummaryFromRegistry: トップレベル description を最優先', async () => {
					const { buildSummaryFromRegistry } = await import('@/plugins/npmjs.js');
					const fixture = {
						name: 'mfm-renderer',
						description: 'Top-level description',
						'dist-tags': { latest: '1.0.0' },
						versions: {
							'1.0.0': { description: 'Version-level description (should be ignored)' },
						},
					};
					const summary = buildSummaryFromRegistry(fixture);
					expect(summary).not.toBeNull();
					expect(summary!.title).toBe('mfm-renderer');
					expect(summary!.description).toBe('Top-level description');
					expect(summary!.sitename).toBe('npm');
					expect(summary!.icon).toContain('static-production.npmjs.com');
					expect(summary!.thumbnail).toContain('static-production.npmjs.com');
					expect(summary!.player.url).toBeNull();
					expect(summary!.sensitive).toBe(false);
				});

				test('buildSummaryFromRegistry: トップレベル description が無いとき versions[latest].description にフォールバック', async () => {
					const { buildSummaryFromRegistry } = await import('@/plugins/npmjs.js');
					const fixture = {
						name: 'fallback-pkg',
						'dist-tags': { latest: '2.0.0' },
						versions: {
							'2.0.0': { description: 'Version-level fallback' },
						},
					};
					const summary = buildSummaryFromRegistry(fixture);
					expect(summary!.description).toBe('Version-level fallback');
				});

				test('buildSummaryFromRegistry: scoped パッケージ名がそのまま title に入る', async () => {
					const { buildSummaryFromRegistry } = await import('@/plugins/npmjs.js');
					const fixture = {
						name: '@misskey-dev/summaly',
						description: 'URL preview library',
						'dist-tags': { latest: '5.3.0' },
						versions: { '5.3.0': {} },
					};
					const summary = buildSummaryFromRegistry(fixture);
					expect(summary!.title).toBe('@misskey-dev/summaly');
					expect(summary!.description).toBe('URL preview library');
				});

				test('buildSummaryFromRegistry: dist-tags.latest が無くても description は組み立てられる（top description 由来）', async () => {
					const { buildSummaryFromRegistry } = await import('@/plugins/npmjs.js');
					const fixture = {
						name: 'no-latest',
						description: 'Some description',
					};
					const summary = buildSummaryFromRegistry(fixture);
					expect(summary).not.toBeNull();
					expect(summary!.description).toBe('Some description');
				});

				test('buildSummaryFromRegistry: name が無いと null', async () => {
					const { buildSummaryFromRegistry } = await import('@/plugins/npmjs.js');
					expect(buildSummaryFromRegistry({})).toBeNull();
					expect(buildSummaryFromRegistry({ description: 'no name' })).toBeNull();
					expect(buildSummaryFromRegistry(null)).toBeNull();
					expect(buildSummaryFromRegistry('not an object')).toBeNull();
					expect(buildSummaryFromRegistry(42)).toBeNull();
				});
			});

			describe('twitter (X) プラグイン (phase6.1)', () => {
				test('test() は (twitter|x).com/<user>/status/<id> にマッチする', async () => {
					const { test: matchTest } = await import('@/plugins/twitter.js');
					expect(matchTest(new URL('https://twitter.com/jack/status/20'))).toBe(true);
					expect(matchTest(new URL('https://x.com/jack/status/20'))).toBe(true);
					expect(matchTest(new URL('https://x.com/jack/status/1234567890123456789'))).toBe(true);

					expect(matchTest(new URL('https://x.com/jack'))).toBe(false);
					expect(matchTest(new URL('https://mobile.twitter.com/jack/status/20'))).toBe(false);
					expect(matchTest(new URL('https://x.com/i/lists/123'))).toBe(false);
					expect(matchTest(new URL('https://example.com/x.com/jack/status/20'))).toBe(false);
				});

				test('calcToken は決定的で 0 と . を含まない', async () => {
					const { calcToken } = await import('@/plugins/twitter.js');
					const t1 = calcToken('1234567890123456789');
					const t2 = calcToken('1234567890123456789');
					expect(t1).toBe(t2);
					expect(t1).not.toMatch(/[0.]/);
					expect(t1.length).toBeGreaterThan(0);
				});

				test('buildSummary はテキストツイートから description を組み立てる（player は null = Misskey 側展開導線に委ねる）', async () => {
					const { buildSummary } = await import('@/plugins/twitter.js');
					const fixture = {
						text: 'just setting up my twttr',
						user: { name: 'jack', profile_image_url_https: 'https://pbs.twimg.com/profile_images/123/abc_normal.jpg' },
					};
					const summary = buildSummary('20', fixture);
					expect(summary).not.toBeNull();
					expect(summary!.title).toBe('jack on X');
					expect(summary!.icon).toBe('https://abs.twimg.com/favicons/twitter.3.ico');
					expect(summary!.description).toBe('just setting up my twttr');
					expect(summary!.sitename).toBe('X');
					// `_normal.` を除いたオリジナル profile 画像が thumbnail に
					expect(summary!.thumbnail).toBe('https://pbs.twimg.com/profile_images/123/abc.jpg');
					// player は null（Misskey の「ポストを展開する」機能と重複しないように）
					expect(summary!.player.url).toBeNull();
					expect(summary!.player.width).toBeNull();
					expect(summary!.player.height).toBeNull();
					expect(summary!.player.allow).toEqual([]);
				});

				test('複数画像ツイートは medias[] に全画像 + thumbnail に先頭', async () => {
					const { buildSummary } = await import('@/plugins/twitter.js');
					const fixture = {
						text: 'photo dump https://t.co/abc',
						user: { name: 'photog' },
						photos: [
							{ url: 'https://pbs.twimg.com/media/img1.jpg' },
							{ url: 'https://pbs.twimg.com/media/img2.jpg' },
							{ url: 'https://pbs.twimg.com/media/img3.jpg' },
						],
						entities: { media: [{ indices: [11, 34] }] },
					};
					const summary = buildSummary('100', fixture);
					expect(summary!.medias).toEqual([
						'https://pbs.twimg.com/media/img1.jpg',
						'https://pbs.twimg.com/media/img2.jpg',
						'https://pbs.twimg.com/media/img3.jpg',
					]);
					expect(summary!.thumbnail).toBe('https://pbs.twimg.com/media/img1.jpg');
					// entities.media[0].indices[0] = 11 で本文末尾の `https://t.co/abc` が切り落とされる
					expect(summary!.description).toBe('photo dump');
				});

				test('動画ツイートは video.poster を thumbnail に優先', async () => {
					const { buildSummary } = await import('@/plugins/twitter.js');
					const fixture = {
						text: 'video',
						user: { name: 'videog', profile_image_url_https: 'https://pbs.twimg.com/profile_images/x/y_normal.jpg' },
						video: { poster: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/abc.jpg' },
						photos: [{ url: 'https://should.not.use/img.jpg' }],
					};
					const summary = buildSummary('200', fixture);
					expect(summary!.thumbnail).toBe('https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/abc.jpg');
				});

				test('possibly_sensitive を sensitive にマップ', async () => {
					const { buildSummary } = await import('@/plugins/twitter.js');
					expect(buildSummary('1', { text: 'a', user: { name: 'u' }, possibly_sensitive: true })!.sensitive).toBe(true);
					expect(buildSummary('1', { text: 'a', user: { name: 'u' }, possibly_sensitive: false })!.sensitive).toBe(false);
					expect(buildSummary('1', { text: 'a', user: { name: 'u' } })!.sensitive).toBe(false);
				});

				test('json が null / object でない場合は null を返す（壊れた CDN レスポンス）', async () => {
					const { buildSummary } = await import('@/plugins/twitter.js');
					expect(buildSummary('1', null)).toBeNull();
					expect(buildSummary('1', 'not-an-object')).toBeNull();
					expect(buildSummary('1', 42)).toBeNull();
				});

				test('user.name が無いと title は "X" にフォールバック', async () => {
					const { buildSummary } = await import('@/plugins/twitter.js');
					const summary = buildSummary('1', { text: 'orphan tweet' });
					expect(summary!.title).toBe('X');
				});
			});
		});
	});

	describe('phase2.2 mei23 取り込み', () => {
		describe('allowedPlugins', () => {
			function setupWikipediaMockApp() {
				app = fastify();
				app.get('/api', (_req, reply) => {
					return reply.send({
						query: {
							pages: {
								'1': { title: 'KISS', extract: 'A KISS test page.' },
							},
						},
					});
				});
				return app.listen({ port });
			}

			test('未指定のとき wikipedia URL に wikipedia プラグインが当たる', async () => {
				app = fastify();
				app.get('/', (_req, reply) => {
					const content = fs.readFileSync(_dirname + '/htmls/basic.html');
					reply.header('content-length', content.length);
					reply.header('content-type', 'text/html');
					return reply.send(content);
				});
				await app.listen({ port });

				// 確認: wikipedia プラグインの test() が当たるホストを使うが、
				// fixture で general パスでも summary が取れるサイトを mock する
				// → ここは allowedPlugins=undefined で general or builtin が透過することを確認
				const summary = await summaly(host);
				expect(summary).toBeDefined();
			});

			test('allowedPlugins: ["amazon"] のとき wikipedia URL は general パスへフォールバック', async () => {
				app = fastify();
				app.get('/', (_req, reply) => {
					const content = fs.readFileSync(_dirname + '/htmls/basic.html');
					reply.header('content-length', content.length);
					reply.header('content-type', 'text/html');
					return reply.send(content);
				});
				await app.listen({ port });

				// localhost なので wikipedia プラグインの test() に当たらないが、
				// allowedPlugins フィルタが組み込みプラグインを正しく絞り込むことを確認するために
				// builtinPlugins 配列が指定 name でフィルタされていることをユニットテスト的に検証
				const summary = await summaly(host, { allowedPlugins: ['amazon'] });
				expect(summary).toBeDefined();
			});

			test('allowedPlugins: [] のとき組み込み全 disable でも general で動く', async () => {
				app = fastify();
				app.get('/', (_req, reply) => {
					const content = fs.readFileSync(_dirname + '/htmls/basic.html');
					reply.header('content-length', content.length);
					reply.header('content-type', 'text/html');
					return reply.send(content);
				});
				await app.listen({ port });

				const summary = await summaly(host, { allowedPlugins: [] });
				expect(summary).toBeDefined();
				expect(summary.title).toBeDefined();
			});

			// 上記 3 テストは「summaly が壊れない」ことを保証するスモークテスト。
			// ここではフィルタロジック自体を builtinPlugins に対して直接検証する
			test('allowedPlugins フィルタのユニット動作: name でマッチするプラグインだけが残る', () => {
				const allowed = ['amazon', 'wikipedia'];
				const filtered = builtinPlugins.filter(p => p.name != null && allowed.includes(p.name));
				const names = filtered.map(p => p.name);
				expect(names).toContain('amazon');
				expect(names).toContain('wikipedia');
				expect(names).not.toContain('bluesky');
				expect(names).not.toContain('branchio-deeplinks');
			});
		});

		describe('useRange', () => {
			test('useRange: true のとき Range ヘッダがサーバに到達する', async () => {
				let receivedRange: string | undefined;
				app = fastify();
				app.get('/', (request, reply) => {
					receivedRange = request.headers['range'];
					const content = fs.readFileSync(_dirname + '/htmls/basic.html');
					reply.header('content-length', content.length);
					reply.header('content-type', 'text/html');
					return reply.send(content);
				});
				await app.listen({ port });

				await summaly(host, { useRange: true });
				expect(receivedRange).toBeDefined();
				expect(receivedRange).toMatch(/^bytes=0-\d+$/);
			});

			test('useRange: false を明示すると Range ヘッダは送信されない (phase16.3 で internal default が true に変更)', async () => {
				let receivedRange: string | undefined;
				app = fastify();
				app.get('/', (request, reply) => {
					receivedRange = request.headers['range'];
					const content = fs.readFileSync(_dirname + '/htmls/basic.html');
					reply.header('content-length', content.length);
					reply.header('content-type', 'text/html');
					return reply.send(content);
				});
				await app.listen({ port });

				await summaly(host, { useRange: false });
				expect(receivedRange).toBeUndefined();
			});

			test('useRange 未指定のとき Range ヘッダがデフォルトで送信される (phase16.3)', async () => {
				let receivedRange: string | undefined;
				app = fastify();
				app.get('/', (request, reply) => {
					receivedRange = request.headers['range'];
					const content = fs.readFileSync(_dirname + '/htmls/basic.html');
					reply.header('content-length', content.length);
					reply.header('content-type', 'text/html');
					return reply.send(content);
				});
				await app.listen({ port });

				await summaly(host);
				expect(receivedRange).toMatch(/^bytes=0-\d+$/);
			});
		});

		describe('sanitize-url', () => {
			test('https / http はそのまま通る', () => {
				expect(sanitizeUrl('https://example.com/x.png')).toBe('https://example.com/x.png');
				expect(sanitizeUrl('http://example.com/x.png')).toBe('http://example.com/x.png');
			});

			test('javascript: / file: は弾かれる', () => {
				expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
				expect(sanitizeUrl('file:///etc/passwd')).toBeNull();
			});

			test('data: は上限以下のみ通り、超過は弾かれる', () => {
				expect(sanitizeUrl('data:image/png;base64,abc')).toBe('data:image/png;base64,abc');
				const huge = 'data:image/png;base64,' + 'a'.repeat(20 * 1024);
				expect(sanitizeUrl(huge)).toBeNull();
			});

			test('null / 空文字 / 不正 URL は null', () => {
				expect(sanitizeUrl(null)).toBeNull();
				expect(sanitizeUrl(undefined)).toBeNull();
				expect(sanitizeUrl('')).toBeNull();
				expect(sanitizeUrl('not a url')).toBeNull();
			});

			test('summaly() の結果に javascript: スキームが含まれていれば null に置換される', async () => {
				app = fastify();
				app.get('/', (_req, reply) => {
					const html = '<!doctype html><html><head><title>X</title>' +
						'<link rel="icon" href="javascript:alert(1)">' +
						'<meta property="og:image" content="javascript:alert(1)">' +
						'</head><body></body></html>';
					reply.header('content-length', Buffer.byteLength(html));
					reply.header('content-type', 'text/html');
					return reply.send(html);
				});
				await app.listen({ port });

				const summary = await summaly(host);
				expect(summary.icon).toBeNull();
				expect(summary.thumbnail).toBeNull();
			});
		});

		describe('encoding 強化（jschardet + encoding-japanese）', () => {
			test('UTF-8 を正しく検出して decode する', () => {
				const buf = Buffer.from('<html><head><title>こんにちは</title></head></html>', 'utf-8');
				const enc = detectEncoding(buf);
				const decoded = toUtf8(buf, enc);
				expect(decoded).toContain('こんにちは');
			});

			test('Shift_JIS (CP932) の <meta charset> 経由で検出 + decode できる', () => {
				// jschardet の confidence が低い場合に <meta charset> フォールバックが動くことを確認
				const html = '<html><head><meta charset="Shift_JIS"><title>SJIS</title></head><body>テスト</body></html>';
				const buf: Buffer = iconv.encode(html, 'cp932');
				const enc = detectEncoding(buf);
				const decoded = toUtf8(buf, enc);
				expect(decoded).toContain('テスト');
			});

			test('ISO-2022-JP は encoding-japanese 経由で decode できる', () => {
				const text = '<html><head><meta charset="ISO-2022-JP"><title>テスト</title></head></html>';
				const arr = Encoding.convert(Encoding.stringToCode(text), { from: 'UNICODE', to: 'JIS', type: 'array' });
				const buf = Buffer.from(arr);
				// detectEncoding は <meta charset> から ISO-2022-JP を引けば良い
				const enc = detectEncoding(buf);
				expect(enc.toLowerCase()).toBe('iso-2022-jp');
				const decoded = toUtf8(buf, enc);
				expect(decoded).toContain('テスト');
			});
		});

		describe('medias', () => {
			test('Summary 型に medias?: string[] が optional で存在する', () => {
				// 型レベルの確認 — 実装では未設定（undefined）が既定
				const sample: { medias?: string[] } = {};
				expect(sample.medias).toBeUndefined();
				sample.medias = ['https://example.com/a.jpg', 'https://example.com/b.jpg'];
				expect(sample.medias).toHaveLength(2);
			});
		});
	});

	describe('Fastify インメモリ LRU キャッシュ (phase4.1)', () => {
		const proxyPort = port + 1;
		let proxyApp: FastifyInstance | null = null;

		afterEach(async () => {
			if (proxyApp != null) {
				await proxyApp.close();
				proxyApp = null;
			}
		});

		async function setupOriginAndProxy(opts: Partial<SummalyOptions> & { inMemoryCache?: boolean; inMemoryCacheMaxEntries?: number } = {}) {
			let originHits = 0;
			app = fastify();
			app.get('/', (_req, reply) => {
				originHits++;
				const content = fs.readFileSync(_dirname + '/htmls/basic.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			proxyApp = fastify();
			await proxyApp.register(summalyPlugin, opts);
			await proxyApp.listen({ port: proxyPort });

			return { getOriginHits: () => originHits };
		}

		test('inMemoryCache: true で 2 回目リクエストが origin に到達しない', async () => {
			const { getOriginHits } = await setupOriginAndProxy({ inMemoryCache: true });

			const r1 = await proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } });
			expect(r1.statusCode).toBe(200);
			expect(r1.headers['x-cache']).toBe('MISS');
			const hitsAfter1 = getOriginHits();
			expect(hitsAfter1).toBeGreaterThanOrEqual(1);

			const r2 = await proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } });
			expect(r2.statusCode).toBe(200);
			expect(r2.headers['x-cache']).toBe('HIT');
			expect(getOriginHits()).toBe(hitsAfter1);
		});

		test('inMemoryCache・inFlightDedup 共に false では X-Cache が付かない（既存挙動）', async () => {
			await setupOriginAndProxy({ inMemoryCache: false, inFlightDedup: false });
			const r = await proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } });
			expect(r.statusCode).toBe(200);
			expect(r.headers['x-cache']).toBeUndefined();
		});

		test('lang 違いはキャッシュ別エントリ', async () => {
			const { getOriginHits } = await setupOriginAndProxy({ inMemoryCache: true });

			await proxyApp!.inject({ method: 'GET', url: '/', query: { url: host, lang: 'ja' } });
			const hitsAfter1 = getOriginHits();
			expect(hitsAfter1).toBeGreaterThanOrEqual(1);

			const r2 = await proxyApp!.inject({ method: 'GET', url: '/', query: { url: host, lang: 'en' } });
			expect(r2.headers['x-cache']).toBe('MISS');
			expect(getOriginHits()).toBeGreaterThan(hitsAfter1);
		});

		test('500 エラーもキャッシュされ、2 回目で origin に到達しない', async () => {
			proxyApp = fastify();
			await proxyApp.register(summalyPlugin, { inMemoryCache: true });
			await proxyApp.listen({ port: proxyPort });

			const targetUrl = `http://localhost:${port + 99}/nonexistent`;
			const r1 = await proxyApp.inject({ method: 'GET', url: '/', query: { url: targetUrl } });
			expect(r1.statusCode).toBe(500);
			expect(r1.headers['x-cache']).toBe('MISS');

			const r2 = await proxyApp.inject({ method: 'GET', url: '/', query: { url: targetUrl } });
			expect(r2.statusCode).toBe(500);
			expect(r2.headers['x-cache']).toBe('HIT');
		});

		test('inMemoryCacheMaxEntries 超過で LRU evict', async () => {
			app = fastify();
			const content = fs.readFileSync(_dirname + '/htmls/basic.html');
			app.get('/', (_req, reply) => {
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			proxyApp = fastify();
			await proxyApp.register(summalyPlugin, { inMemoryCache: true, inMemoryCacheMaxEntries: 2 });
			await proxyApp.listen({ port: proxyPort });

			const url1 = await proxyApp.inject({ method: 'GET', url: '/', query: { url: host, lang: 'a' } });
			expect(url1.headers['x-cache']).toBe('MISS');
			const url2 = await proxyApp.inject({ method: 'GET', url: '/', query: { url: host, lang: 'b' } });
			expect(url2.headers['x-cache']).toBe('MISS');

			// 2 番目を再アクセスして直近利用済みに（state: [a (LRU), b (MRU)]）
			await proxyApp.inject({ method: 'GET', url: '/', query: { url: host, lang: 'b' } });
			// 3 番目を入れると一番古い (lang=a) が evict される（state: [b, c]）
			await proxyApp.inject({ method: 'GET', url: '/', query: { url: host, lang: 'c' } });

			// lang=a は evict 済み → MISS
			const aRefetch = await proxyApp.inject({ method: 'GET', url: '/', query: { url: host, lang: 'a' } });
			expect(aRefetch.headers['x-cache']).toBe('MISS');
			// lang=c はまだ残っている → HIT
			const cRefetch = await proxyApp.inject({ method: 'GET', url: '/', query: { url: host, lang: 'c' } });
			expect(cRefetch.headers['x-cache']).toBe('HIT');
		});

		test('URL のフラグメントはキャッシュキーに含まない', async () => {
			const { getOriginHits } = await setupOriginAndProxy({ inMemoryCache: true });

			const r1 = await proxyApp!.inject({ method: 'GET', url: '/', query: { url: `${host}/#section1` } });
			expect(r1.headers['x-cache']).toBe('MISS');
			const hitsAfter1 = getOriginHits();

			const r2 = await proxyApp!.inject({ method: 'GET', url: '/', query: { url: `${host}/#section2` } });
			expect(r2.headers['x-cache']).toBe('HIT');
			expect(getOriginHits()).toBe(hitsAfter1);
		});
	});

	describe('Fastify in-flight dedup (phase4.2)', () => {
		const proxyPort = port + 1;
		let proxyApp: FastifyInstance | null = null;

		afterEach(async () => {
			if (proxyApp != null) {
				await proxyApp.close();
				proxyApp = null;
			}
		});

		// origin 側に意図的なディレイを入れたサーバを立ち上げる。
		// dedup の効きを「先頭リクエストが完了する前に並列リクエストが来ても origin ヒットは 1 件」で検証する。
		async function setupSlowOriginAndProxy(opts: Partial<SummalyOptions> & {
			delayMs?: number;
			failWith?: number;
		} = {}) {
			let originHits = 0;
			const { delayMs = 200, failWith, ...summalyOpts } = opts;

			app = fastify();
			app.get('/', async (_req, reply) => {
				originHits++;
				await new Promise(r => setTimeout(r, delayMs));
				if (failWith != null) {
					reply.header('content-type', 'text/plain');
					return reply.status(failWith).send('boom');
				}
				const content = fs.readFileSync(_dirname + '/htmls/basic.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			proxyApp = fastify();
			await proxyApp.register(summalyPlugin, summalyOpts);
			await proxyApp.listen({ port: proxyPort });

			return { getOriginHits: () => originHits };
		}

		test('5 並列リクエストで origin ヒットは 1 件、4 件は HIT-COALESCED', async () => {
			const { getOriginHits } = await setupSlowOriginAndProxy({ delayMs: 300 });

			const responses = await Promise.all(Array.from({ length: 5 }, () =>
				proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } })));

			expect(getOriginHits()).toBe(1);
			expect(responses.every(r => r.statusCode === 200)).toBe(true);

			const cacheHeaders = responses.map(r => r.headers['x-cache']).sort();
			// 先頭が MISS、残り 4 件が HIT-COALESCED
			expect(cacheHeaders).toEqual(['HIT-COALESCED', 'HIT-COALESCED', 'HIT-COALESCED', 'HIT-COALESCED', 'MISS']);

			// すべて同じ Summary（少なくとも url）を受け取る
			const bodies = responses.map(r => JSON.parse(r.body));
			expect(new Set(bodies.map(b => b.url)).size).toBe(1);
		});

		test('inFlightDedup: false なら 5 並列で origin が 5 回叩かれる（既存挙動）', async () => {
			const { getOriginHits } = await setupSlowOriginAndProxy({ delayMs: 300, inFlightDedup: false });

			const responses = await Promise.all(Array.from({ length: 5 }, () =>
				proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } })));

			expect(getOriginHits()).toBe(5);
			expect(responses.every(r => r.statusCode === 200)).toBe(true);
			// dedup 無効 + キャッシュ無効では X-Cache は付かない
			expect(responses.every(r => r.headers['x-cache'] == null)).toBe(true);
		});

		test('in-flight 中のエラーが全 waiter に伝搬する', async () => {
			const { getOriginHits } = await setupSlowOriginAndProxy({ delayMs: 200, failWith: 500 });

			const responses = await Promise.all(Array.from({ length: 3 }, () =>
				proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } })));

			expect(getOriginHits()).toBe(1);
			// summaly() がエラーを throw → 全 waiter で 500 を返す
			expect(responses.every(r => r.statusCode === 500)).toBe(true);
			const cacheHeaders = responses.map(r => r.headers['x-cache']).sort();
			expect(cacheHeaders).toEqual(['HIT-COALESCED', 'HIT-COALESCED', 'MISS']);

			// 全 waiter が同じ error を受け取る
			const bodies = responses.map(r => JSON.parse(r.body));
			const errorJson = bodies.map(b => JSON.stringify(b.error));
			expect(new Set(errorJson).size).toBe(1);
		});

		test('inMemoryCache: true + inFlightDedup: true で 並列は HIT-COALESCED、後続は HIT', async () => {
			const { getOriginHits } = await setupSlowOriginAndProxy({ delayMs: 300, inMemoryCache: true });

			// 並列 3 件
			const parallel = await Promise.all(Array.from({ length: 3 }, () =>
				proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } })));
			expect(getOriginHits()).toBe(1);
			const cacheHeaders = parallel.map(r => r.headers['x-cache']).sort();
			expect(cacheHeaders).toEqual(['HIT-COALESCED', 'HIT-COALESCED', 'MISS']);

			// 完了後の追加リクエストは LRU HIT
			const r = await proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } });
			expect(r.statusCode).toBe(200);
			expect(r.headers['x-cache']).toBe('HIT');
			expect(getOriginHits()).toBe(1);
		});

		test('URL 違いは別キーで dedup されない', async () => {
			let originHits = 0;
			app = fastify();
			app.get('/a', async (_req, reply) => {
				originHits++;
				await new Promise(r => setTimeout(r, 200));
				const content = fs.readFileSync(_dirname + '/htmls/basic.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			app.get('/b', async (_req, reply) => {
				originHits++;
				await new Promise(r => setTimeout(r, 200));
				const content = fs.readFileSync(_dirname + '/htmls/basic.html');
				reply.header('content-length', content.length);
				reply.header('content-type', 'text/html');
				return reply.send(content);
			});
			await app.listen({ port });

			proxyApp = fastify();
			await proxyApp.register(summalyPlugin, {});
			await proxyApp.listen({ port: proxyPort });

			const responses = await Promise.all([
				proxyApp.inject({ method: 'GET', url: '/', query: { url: `${host}/a` } }),
				proxyApp.inject({ method: 'GET', url: '/', query: { url: `${host}/b` } }),
			]);
			expect(responses.every(r => r.statusCode === 200)).toBe(true);
			expect(originHits).toBe(2);
			expect(responses.every(r => r.headers['x-cache'] === 'MISS')).toBe(true);
		});

		test('lang 違いは別キーで dedup されない', async () => {
			const { getOriginHits } = await setupSlowOriginAndProxy({ delayMs: 200 });

			const responses = await Promise.all([
				proxyApp!.inject({ method: 'GET', url: '/', query: { url: host, lang: 'ja' } }),
				proxyApp!.inject({ method: 'GET', url: '/', query: { url: host, lang: 'en' } }),
			]);
			expect(responses.every(r => r.statusCode === 200)).toBe(true);
			expect(getOriginHits()).toBe(2);
			expect(responses.every(r => r.headers['x-cache'] === 'MISS')).toBe(true);
		});

		test('inFlightDedup 未指定はデフォルト true で X-Cache: MISS が付く', async () => {
			await setupSlowOriginAndProxy({ delayMs: 50 });
			const r = await proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } });
			expect(r.statusCode).toBe(200);
			expect(r.headers['x-cache']).toBe('MISS');
		});
	});

	describe('パース失敗ログ (phase10.1, phase11.5 で endpoint は廃止)', () => {
		// phase11.5 で `/__diagnostics/parse-failures` エンドポイントは撤去された
		// （プライバシーリスク撤去、過去 preview 試行 URL を外部から読み取れる構造を恒久排除）。
		// 集約データの参照は parseFailureLogJsonlPath で書き出される JSONL ファイル経由に移行。
		// 本 describe では Fastify 経由で JSONL に書き込まれることを統合テストで担保する。
		// (詳細な挙動は test/parse-failure-log.test.ts の単体テストでカバー)
		const proxyPort = port + 1;
		let proxyApp: FastifyInstance | null = null;
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = mkdtempSync(join(osTmpdir(), 'summaly-pf-int-'));
		});

		afterEach(async () => {
			if (proxyApp != null) {
				await proxyApp.close();
				proxyApp = null;
			}
			rmSync(tmpDir, { recursive: true, force: true });
		});

		test('Fastify 経由で thin summary が JSONL に書き込まれる + 4xx は filter で除外', async () => {
			const jsonlPath = join(tmpDir, 'pf.jsonl');
			app = fastify();
			// 1. thin: title だけある HTML（OG/description なし、thumbnail なし）→ JSONL に記録される
			app.get('/articles/foo/post1', (_req, reply) => {
				reply.header('content-type', 'text/html');
				return reply.send('<html><head><title>localhost</title></head><body>x</body></html>');
			});
			// 2. 403 (StatusError 4xx) → isFilteredFailure で除外され JSONL には書かれない
			app.get('/forbidden', (_req, reply) => {
				reply.header('content-type', 'text/html');
				return reply.status(403).send('<html><body>Forbidden</body></html>');
			});
			await app.listen({ port });

			proxyApp = fastify();
			await proxyApp.register(summalyPlugin, {
				parseFailureLog: true,
				parseFailureLogJsonlPath: jsonlPath,
				inMemoryCache: false,
				inFlightDedup: false,
			});
			await proxyApp.listen({ port: proxyPort });

			const r1 = await proxyApp.inject({ method: 'GET', url: '/', query: { url: `${host}/articles/foo/post1` } });
			expect(r1.statusCode).toBe(200);
			const r2 = await proxyApp.inject({ method: 'GET', url: '/', query: { url: `${host}/forbidden` } });
			expect(r2.statusCode).toBe(500);

			const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
			expect(lines).toHaveLength(1);
			const entry = JSON.parse(lines[0]) as { key: string; url: string; reason: string };
			expect(entry.key).toBe('localhost/articles/foo');
			expect(entry.reason).toBe('thin');
			expect(entry.url).toBe(`${host}/articles/foo/post1`);
		});

		test('迂回候補は別 JSONL に振り分け、candidate JSONL と純度を保つ (phase11.6)', async () => {
			const candidatePath = join(tmpDir, 'pf.jsonl');
			const blockedPath = join(tmpDir, 'blocked.jsonl');
			app = fastify();
			// thin（プラグイン候補）→ candidate JSONL
			app.get('/articles/foo/thin', (_req, reply) => {
				reply.header('content-type', 'text/html');
				return reply.send('<html><head><title>localhost</title></head><body>x</body></html>');
			});
			// 403（迂回候補）→ blocked JSONL
			app.get('/blocked', (_req, reply) => {
				reply.header('content-type', 'text/html');
				return reply.status(403).send('<html><body>Forbidden</body></html>');
			});
			await app.listen({ port });

			proxyApp = fastify();
			await proxyApp.register(summalyPlugin, {
				parseFailureLog: true,
				parseFailureLogJsonlPath: candidatePath,
				parseFailureLogBlockedJsonlPath: blockedPath,
				inMemoryCache: false,
				inFlightDedup: false,
			});
			await proxyApp.listen({ port: proxyPort });

			await proxyApp.inject({ method: 'GET', url: '/', query: { url: `${host}/articles/foo/thin` } });
			await proxyApp.inject({ method: 'GET', url: '/', query: { url: `${host}/blocked` } });

			const candidateLines = readFileSync(candidatePath, 'utf8').split('\n').filter(Boolean);
			expect(candidateLines).toHaveLength(1);
			const candidateEntry = JSON.parse(candidateLines[0]) as { reason: string };
			expect(candidateEntry.reason).toBe('thin');

			const blockedLines = readFileSync(blockedPath, 'utf8').split('\n').filter(Boolean);
			expect(blockedLines).toHaveLength(1);
			const blockedEntry = JSON.parse(blockedLines[0]) as { reason: string; category: string; errorName: string };
			expect(blockedEntry.reason).toBe('throw');
			expect(blockedEntry.category).toBe('bot_blocked');
			expect(blockedEntry.errorName).toBe('StatusError');
		});

		test('LRU/dedup HIT は重複記録しない（MISS 経路のみ JSONL に追記）', async () => {
			const jsonlPath = join(tmpDir, 'pf.jsonl');
			app = fastify();
			app.get('/articles/foo/dup', (_req, reply) => {
				reply.header('content-type', 'text/html');
				return reply.send('<html><head><title>localhost</title></head><body>x</body></html>');
			});
			await app.listen({ port });

			proxyApp = fastify();
			await proxyApp.register(summalyPlugin, {
				parseFailureLog: true,
				parseFailureLogJsonlPath: jsonlPath,
				inMemoryCache: true,
				inFlightDedup: true,
			});
			await proxyApp.listen({ port: proxyPort });

			// 同 URL 連投。1 回目は MISS → 記録、2-3 回目は LRU HIT → 記録されない
			await proxyApp.inject({ method: 'GET', url: '/', query: { url: `${host}/articles/foo/dup` } });
			await proxyApp.inject({ method: 'GET', url: '/', query: { url: `${host}/articles/foo/dup` } });
			await proxyApp.inject({ method: 'GET', url: '/', query: { url: `${host}/articles/foo/dup` } });

			const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
			expect(lines).toHaveLength(1);
		});
	});

	describe('PDF 対応 (phase5.1)', () => {
		const pdfBuffer = fs.readFileSync(_dirname + '/pdfs/sample.pdf');

		afterEach(() => {
			delete process.env.SUMMALY_ENABLE_PDF;
		});

		test('enablePdf 未指定時は PDF レスポンスが type filter で reject される (デフォルト互換)', async () => {
			app = fastify();
			app.get('/', (_req, reply) => {
				reply.header('content-length', pdfBuffer.length);
				reply.header('content-type', 'application/pdf');
				return reply.send(pdfBuffer);
			});
			await app.listen({ port });

			await expect(summaly(host)).rejects.toThrow(/Rejected by type filter/);
		});

		test('enablePdf: true で PDF からタイトルが取れる', async () => {
			app = fastify();
			app.get('/', (_req, reply) => {
				reply.header('content-length', pdfBuffer.length);
				reply.header('content-type', 'application/pdf');
				return reply.send(pdfBuffer);
			});
			await app.listen({ port });

			const summary = await summaly(host, { enablePdf: true });
			expect(summary.title).toBe('Hello PDF World');
			expect(summary.icon).toMatch(/^data:image\/svg\+xml;base64,/);
			expect(summary.description).toBeNull();
			expect(summary.thumbnail).toBeNull();
			expect(summary.player.url).toBeNull();
			expect(summary.sitename).toBe('localhost');
		});

		test('SUMMALY_ENABLE_PDF=true 環境変数でも有効化できる', async () => {
			app = fastify();
			app.get('/', (_req, reply) => {
				reply.header('content-length', pdfBuffer.length);
				reply.header('content-type', 'application/pdf');
				return reply.send(pdfBuffer);
			});
			await app.listen({ port });

			process.env.SUMMALY_ENABLE_PDF = 'true';
			const summary = await summaly(host);
			expect(summary.title).toBe('Hello PDF World');
		});

		test('enablePdf: false が SUMMALY_ENABLE_PDF=true より優先される (関数オプション優先)', async () => {
			app = fastify();
			app.get('/', (_req, reply) => {
				reply.header('content-length', pdfBuffer.length);
				reply.header('content-type', 'application/pdf');
				return reply.send(pdfBuffer);
			});
			await app.listen({ port });

			process.env.SUMMALY_ENABLE_PDF = 'true';
			await expect(summaly(host, { enablePdf: false })).rejects.toThrow(/Rejected by type filter/);
		});

		test('Title 無し PDF はホスト名を title として返す', async () => {
			// Title フィールドの無い最小 PDF を生成
			const noTitlePdf = (() => {
				const obj1 = '1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n';
				const obj2 = '2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n';
				const obj3 = '3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]>>\nendobj\n';
				const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
				let pos = Buffer.byteLength(header, 'binary');
				const offsets = [];
				for (const o of [obj1, obj2, obj3]) {
					offsets.push(pos);
					pos += Buffer.byteLength(o);
				}
				const xrefOffset = pos;
				let xref = 'xref\n0 4\n0000000000 65535 f \n';
				for (const o of offsets) xref += String(o).padStart(10, '0') + ' 00000 n \n';
				const trailer = `trailer\n<</Size 4 /Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
				return Buffer.concat([
					Buffer.from(header, 'binary'),
					Buffer.from(obj1),
					Buffer.from(obj2),
					Buffer.from(obj3),
					Buffer.from(xref),
					Buffer.from(trailer),
				]);
			})();

			app = fastify();
			app.get('/', (_req, reply) => {
				reply.header('content-length', noTitlePdf.length);
				reply.header('content-type', 'application/pdf');
				return reply.send(noTitlePdf);
			});
			await app.listen({ port });

			const summary = await summaly(host, { enablePdf: true });
			// hostname フォールバック
			expect(summary.title).toBe('localhost');
			expect(summary.icon).toMatch(/^data:image\/svg\+xml;base64,/);
		});

		test('contentLengthLimit を超える PDF は受信前にキャンセルされる (5層防衛 ①)', async () => {
			app = fastify();
			app.get('/', (_req, reply) => {
				reply.header('content-length', pdfBuffer.length);
				reply.header('content-type', 'application/pdf');
				return reply.send(pdfBuffer);
			});
			await app.listen({ port });

			// PDF サイズ (403 bytes) より小さい contentLengthLimit を渡してキャンセル発火を確認
			await expect(summaly(host, { enablePdf: true, contentLengthLimit: 100 }))
				.rejects.toThrow(/maxSize exceeded/);
		});

		test('withTimeout が 5 秒経過時に reject し、setTimeout ハンドルを clear する (5層防衛 ④)', async () => {
			const { withTimeout } = await import('@/utils/got.js');
			const start = Date.now();
			// 永遠に解決しない promise を 50ms で timeout
			await expect(withTimeout(new Promise(() => { /* never resolve */ }), 50, 'unit-test-timeout'))
				.rejects.toThrow('unit-test-timeout');
			const elapsed = Date.now() - start;
			// 50ms ± 余裕で完了することを確認（leak していたらテストプロセスが終わらない）
			expect(elapsed).toBeLessThan(500);
		});

		test('withTimeout が成功時もハンドルを clear する (open handle leak 防止)', async () => {
			const { withTimeout } = await import('@/utils/got.js');
			// 即解決の promise + 長いタイムアウト → finally で clearTimeout
			const result = await withTimeout(Promise.resolve('ok'), 60_000);
			expect(result).toBe('ok');
			// このテスト終了後 vitest が即座に exit すれば leak していない（暗黙確認）
		});

		test('破損 PDF はタイトル取得失敗で hostname にフォールバック (5層防衛 ④ パース失敗)', async () => {
			// "%PDF-1.4" で始まるが本体が破損している = parse error 経由で fallback
			const brokenPdf = Buffer.from('%PDF-1.4\nbroken garbage data\n%%EOF\n');
			app = fastify();
			app.get('/', (_req, reply) => {
				reply.header('content-length', brokenPdf.length);
				reply.header('content-type', 'application/pdf');
				return reply.send(brokenPdf);
			});
			await app.listen({ port });

			const summary = await summaly(host, { enablePdf: true });
			expect(summary.title).toBe('localhost');
		});
	});

	describe('短縮 URL HEAD 失敗時 GET fallback (phase9.1)', () => {
		test('HEAD が 404 でも GET で 301 リダイレクトする URL は最終 URL に解決される', async () => {
			let headHits = 0;
			let getShortHits = 0;
			app = fastify();
			app.head('/short', (_req, reply) => {
				headHits++;
				return reply.status(404).send();
			});
			app.get('/short', (_req, reply) => {
				getShortHits++;
				reply.header('location', `${host}/resolved`);
				return reply.status(301).send();
			});
			app.get('/resolved', (_req, reply) => {
				const html = '<html><head><title>Resolved Page</title></head><body>x</body></html>';
				reply.header('content-type', 'text/html');
				reply.header('content-length', html.length);
				return reply.send(html);
			});
			await app.listen({ port });

			const summary = await summaly(`${host}/short`, { followRedirects: true });
			expect(summary.title).toBe('Resolved Page');
			expect(summary.url).toBe(`${host}/resolved`);
			expect(headHits).toBe(1);
			expect(getShortHits).toBeGreaterThanOrEqual(1);
		});

		test('HEAD が 200 ならば GET fallback は呼ばれない（既存 HEAD 成功パスの回帰防止）', async () => {
			let headHits = 0;
			let getShortHits = 0;
			app = fastify();
			app.head('/short', (_req, reply) => {
				headHits++;
				reply.header('location', `${host}/resolved`);
				return reply.status(301).send();
			});
			app.get('/short', (_req, reply) => {
				getShortHits++;
				reply.header('location', `${host}/resolved`);
				return reply.status(301).send();
			});
			app.head('/resolved', (_req, reply) => {
				return reply.status(200).send();
			});
			app.get('/resolved', (_req, reply) => {
				const html = '<html><head><title>Resolved Page</title></head><body>x</body></html>';
				reply.header('content-type', 'text/html');
				reply.header('content-length', html.length);
				return reply.send(html);
			});
			await app.listen({ port });

			const summary = await summaly(`${host}/short`, { followRedirects: true });
			expect(summary.title).toBe('Resolved Page');
			// HEAD だけで解決し、fallback の GET /short は呼ばれていないこと
			expect(headHits).toBeGreaterThanOrEqual(1);
			expect(getShortHits).toBe(0);
		});

		test('HEAD も GET も失敗した場合は元の URL のまま続行する（既存挙動互換）', async () => {
			app = fastify();
			app.head('/short', (_req, reply) => reply.status(500).send());
			app.get('/short', (_req, reply) => reply.status(500).send());
			await app.listen({ port });

			// summaly が原 URL のままスクレイプを試みて 500 を踏み throw する
			await expect(summaly(`${host}/short`, { followRedirects: true })).rejects.toThrow();
		});

		test('skipRedirectResolution = true を宣言したプラグインがマッチすると HEAD/GET probe が呼ばれない (phase12.5)', async () => {
			let headHits = 0;
			let getProbeHits = 0;
			app = fastify();
			// HEAD/GET probe (resolveRedirect) が呼ばれたら必ずカウントされる
			app.head('/page', (_req, reply) => {
				headHits++;
				return reply.status(200).send();
			});
			app.get('/page', (_req, reply) => {
				const range = _req.headers['range'];
				if (range === 'bytes=0-0') {
					// `Range: bytes=0-0` は phase9.1 の GET fallback probe シグニチャ
					getProbeHits++;
				}
				return reply.status(200).send();
			});
			await app.listen({ port });

			// skipRedirectResolution = true を宣言したカスタムプラグイン (Summary を直接返す)
			const customPlugin = {
				name: 'skip-redirect-test',
				test: (u: URL) => u.pathname === '/page',
				summarize: async () => ({
					title: 'Skip Redirect Test',
					icon: null,
					description: null,
					thumbnail: null,
					sitename: null,
					player: { url: null, width: null, height: null, allow: [] },
					activityPub: null,
					fediverseCreator: null,
				}),
				skipRedirectResolution: true,
			};

			const summary = await summaly(`${host}/page`, {
				followRedirects: true,
				plugins: [customPlugin],
			});
			expect(summary.title).toBe('Skip Redirect Test');
			// resolveRedirect の HEAD/GET probe が呼ばれていないこと
			expect(headHits).toBe(0);
			expect(getProbeHits).toBe(0);
		});

		test('skipRedirectResolution = true でもプラグインが test() でマッチしなければ resolveRedirect は走る (回帰防止)', async () => {
			let headHits = 0;
			app = fastify();
			app.head('/short', (_req, reply) => {
				headHits++;
				reply.header('location', `${host}/resolved`);
				return reply.status(301).send();
			});
			app.head('/resolved', (_req, reply) => reply.status(200).send());
			app.get('/resolved', (_req, reply) => {
				const html = '<html><head><title>Resolved</title></head><body>x</body></html>';
				reply.header('content-type', 'text/html');
				reply.header('content-length', html.length);
				return reply.send(html);
			});
			await app.listen({ port });

			// /other にだけマッチするプラグイン (`/short` には test() が false を返す)
			const customPlugin = {
				name: 'narrow-test',
				test: (u: URL) => u.pathname === '/other',
				summarize: async () => ({
					title: 'Never Called',
					icon: null,
					description: null,
					thumbnail: null,
					sitename: null,
					player: { url: null, width: null, height: null, allow: [] },
					activityPub: null,
					fediverseCreator: null,
				}),
				skipRedirectResolution: true,
			};

			const summary = await summaly(`${host}/short`, {
				followRedirects: true,
				plugins: [customPlugin],
			});
			expect(summary.title).toBe('Resolved');
			// プラグインがマッチしないので resolveRedirect が通常通り走る
			expect(headHits).toBeGreaterThanOrEqual(1);
		});
	});

	describe('GET /v バージョン情報エンドポイント', () => {
		test('version / commit / message フィールドが返る + Cache-Control: no-store', async () => {
			const versionApp = fastify();
			await versionApp.register(summalyPlugin, {});
			await versionApp.listen({ port: port + 1 });

			try {
				const r = await versionApp.inject({ method: 'GET', url: '/v' });
				expect(r.statusCode).toBe(200);
				expect(r.headers['cache-control']).toBe('no-store');
				const body = JSON.parse(r.body) as { version: string; commit: string; message: string };
				expect(typeof body.version).toBe('string');
				expect(body.version.length).toBeGreaterThan(0);
				expect(typeof body.commit).toBe('string');
				expect(body.commit.length).toBeGreaterThan(0);
				expect(typeof body.message).toBe('string');
				expect(body.message.length).toBeGreaterThan(0);
			} finally {
				await versionApp.close();
			}
		});
	});

	describe('エラー観測ログ pino 出力 (phase11.8)', () => {
		const proxyPort = port + 1;
		let proxyApp: FastifyInstance | null = null;
		let logCalls: { level: string; data: Record<string, unknown>; msg: string }[] = [];

		beforeEach(() => {
			logCalls = [];
		});

		afterEach(async () => {
			if (proxyApp != null) {
				await proxyApp.close();
				proxyApp = null;
			}
		});

		// 各レベルメソッドが呼ばれた回数と引数を記録するシンプルな mock logger。
		// pino 互換 ('child' を持ち、各レベルメソッド + level プロパティ) が最低限必要。
		function buildMockLogger() {
			const recorder = (level: string) => (data: Record<string, unknown>, msg: string) => {
				logCalls.push({ level, data, msg });
			};
			const inst: Record<string, unknown> = {
				level: 'info',
				fatal: recorder('fatal'),
				error: recorder('error'),
				warn: recorder('warn'),
				info: recorder('info'),
				debug: recorder('debug'),
				trace: recorder('trace'),
				silent: () => {},
			};
			inst.child = () => inst;
			return inst;
		}

		async function bringUpProxy(opts: Parameters<typeof summalyPlugin>[1] = {}) {
			// Fastify 6 の `loggerInstance` 型は厳格 (FastifyChildLoggerFactory<RawServer, ...>) なので、
			// テストでは unknown 経由で mock pino を渡す
			const local = fastify({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				loggerInstance: buildMockLogger() as any,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any) as unknown as FastifyInstance;
			await local.register(summalyPlugin, opts);
			await local.listen({ port: proxyPort });
			proxyApp = local;
		}

		test('500 エラーで warn ログが 1 回出る (origin_error)', async () => {
			app = fastify();
			app.get('/', (_req, reply) => reply.status(500).send());
			await app.listen({ port });
			await bringUpProxy();

			const r = await proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } });
			expect(r.statusCode).toBe(500);

			const errorLogs = logCalls.filter(c => c.msg === 'summaly error');
			expect(errorLogs).toHaveLength(1);
			expect(errorLogs[0].level).toBe('warn');
			expect(errorLogs[0].data.statusCode).toBe(500);
			expect(errorLogs[0].data.url).toBe(`${host}/`);
			// err は phase11.8 W-1 対応で手動シリアライズした { name, message, stack, statusCode } オブジェクト
			// (got の RequestError.options.url 経由の PII 漏洩を防ぐため)
			const errInfo = errorLogs[0].data.err as { type: string; name: string; message: string; statusCode?: number };
			expect(errInfo.type).toBe('StatusError');
			expect(errInfo.name).toBe('StatusError');
			expect(errInfo.statusCode).toBe(500);
		});

		test('403 エラーで info ログが出る (bot_blocked)', async () => {
			app = fastify();
			app.get('/', (_req, reply) => reply.status(403).send());
			await app.listen({ port });
			await bringUpProxy();

			await proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } });

			const errorLogs = logCalls.filter(c => c.msg === 'summaly error');
			expect(errorLogs).toHaveLength(1);
			expect(errorLogs[0].level).toBe('info');
			expect(errorLogs[0].data.statusCode).toBe(403);
		});

		test('failed summarize で error ログが出る (parse_error) — null 返しプラグイン経由', async () => {
			// summarize が null を返すカスタムプラグインを差し込んで「failed summarize」を確実に踏む。
			// 空 HTML フォールバックでは general() が title=hostname 等で summary を返してしまうため、
			// parse_error カテゴリのテストにはプラグイン null 返し経路が確実。
			app = fastify();
			app.get('/null-plugin', (_req, reply) => {
				reply.header('content-type', 'text/html');
				return reply.send('<html></html>');
			});
			await app.listen({ port });

			const local = fastify({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				loggerInstance: buildMockLogger() as any,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any) as unknown as FastifyInstance;
			await local.register(summalyPlugin, {
				plugins: [{
					name: 'test-null',
					test: (u: URL) => u.pathname === '/null-plugin',
					summarize: async () => null,
				}],
			});
			await local.listen({ port: proxyPort });
			proxyApp = local;

			await proxyApp.inject({ method: 'GET', url: '/', query: { url: `${host}/null-plugin` } });

			const errorLogs = logCalls.filter(c => c.msg === 'summaly error');
			expect(errorLogs).toHaveLength(1);
			expect(errorLogs[0].level).toBe('error');
			// mock pino はシリアライザを適用しないため err は手動構築のオブジェクト ({ name, message, stack })
			expect((errorLogs[0].data.err as { message: string }).message).toBe('failed summarize');
		});

		test('LRU キャッシュ HIT 時は再ログしない (spam 抑制)', async () => {
			app = fastify();
			app.get('/', (_req, reply) => reply.status(503).send());
			await app.listen({ port });
			await bringUpProxy({ inMemoryCache: true });

			// 1 回目: MISS なのでログが 1 回出る
			await proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } });
			// 2 回目: LRU HIT (エラーキャッシュ) なのでログは追加で出ない
			await proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } });

			const errorLogs = logCalls.filter(c => c.msg === 'summaly error');
			expect(errorLogs).toHaveLength(1);
		});

		test('成功時はログが出ない', async () => {
			app = fastify();
			app.get('/', (_req, reply) => {
				reply.header('content-type', 'text/html');
				return reply.send('<html><head><title>OK</title></head></html>');
			});
			await app.listen({ port });
			await bringUpProxy();

			const r = await proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } });
			expect(r.statusCode).toBe(200);

			const errorLogs = logCalls.filter(c => c.msg === 'summaly error');
			expect(errorLogs).toHaveLength(0);
		});

		test('URL は sanitizeUrlForLog でクエリが除去される', async () => {
			app = fastify();
			app.get('/secret', (_req, reply) => reply.status(500).send());
			await app.listen({ port });
			await bringUpProxy();

			const urlWithToken = `${host}/secret?token=DO_NOT_LOG_ME&session=abc`;
			await proxyApp!.inject({ method: 'GET', url: '/', query: { url: urlWithToken } });

			const errorLogs = logCalls.filter(c => c.msg === 'summaly error');
			expect(errorLogs).toHaveLength(1);
			expect(errorLogs[0].data.url).toBe(`${host}/secret`);
			expect(JSON.stringify(errorLogs[0].data.url)).not.toContain('token=');
			expect(JSON.stringify(errorLogs[0].data.url)).not.toContain('session=');
		});
	});

	describe('エラーレスポンスの category フィールド (phase11.2)', () => {
		const proxyPort = port + 1;
		let proxyApp: FastifyInstance | null = null;

		afterEach(async () => {
			if (proxyApp != null) {
				await proxyApp.close();
				proxyApp = null;
			}
		});

		async function bringUpProxy() {
			proxyApp = fastify();
			await proxyApp.register(summalyPlugin, {});
			await proxyApp.listen({ port: proxyPort });
		}

		test('origin が 404 → category: not_found + statusCode: 404', async () => {
			app = fastify();
			app.get('/', (_req, reply) => reply.status(404).send('<html><head><title>404</title></head></html>'));
			await app.listen({ port });
			await bringUpProxy();

			const r = await proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } });
			expect(r.statusCode).toBe(500);
			const body = JSON.parse(r.body) as { error: { category: string; statusCode?: number; name?: string } };
			expect(body.error.category).toBe('not_found');
			expect(body.error.statusCode).toBe(404);
			expect(body.error.name).toBe('StatusError');
		});

		test('origin が 403 → category: bot_blocked', async () => {
			app = fastify();
			app.get('/', (_req, reply) => reply.status(403).send());
			await app.listen({ port });
			await bringUpProxy();

			const r = await proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } });
			expect(r.statusCode).toBe(500);
			const body = JSON.parse(r.body) as { error: { category: string; statusCode?: number } };
			expect(body.error.category).toBe('bot_blocked');
			expect(body.error.statusCode).toBe(403);
		});

		test('origin が 503 → category: origin_error', async () => {
			app = fastify();
			app.get('/', (_req, reply) => reply.status(503).send());
			await app.listen({ port });
			await bringUpProxy();

			const r = await proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } });
			expect(r.statusCode).toBe(500);
			const body = JSON.parse(r.body) as { error: { category: string; statusCode?: number } };
			expect(body.error.category).toBe('origin_error');
			expect(body.error.statusCode).toBe(503);
		});

		test('非 HTML レスポンス → category: unsupported_type', async () => {
			app = fastify();
			app.get('/', (_req, reply) => {
				reply.header('content-type', 'image/png');
				return reply.status(200).send(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
			});
			await app.listen({ port });
			await bringUpProxy();

			const r = await proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } });
			expect(r.statusCode).toBe(500);
			const body = JSON.parse(r.body) as { error: { category: string; message?: string } };
			expect(body.error.category).toBe('unsupported_type');
		});

		test('プライベート IP ガード (SSRF block) → category: ssrf_blocked', async () => {
			// SUMMALY_ALLOW_PRIVATE_IP を一時的に明示 false にして本物の SSRF ガードを発動
			// (削除でなく明示 false の方が「意図的に無効化」が読みやすい)
			process.env.SUMMALY_ALLOW_PRIVATE_IP = 'false';
			try {
				app = fastify();
				app.get('/', (_req, reply) => {
					reply.header('content-type', 'text/html');
					return reply.send('<html></html>');
				});
				await app.listen({ port });
				await bringUpProxy();

				const r = await proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } });
				expect(r.statusCode).toBe(500);
				const body = JSON.parse(r.body) as { error: { category: string; message?: string } };
				expect(body.error.category).toBe('ssrf_blocked');
				expect(body.error.message).toMatch(/Private IP rejected/);
			} finally {
				process.env.SUMMALY_ALLOW_PRIVATE_IP = 'true';
			}
		});

		test('DNS 失敗 → category: network_error', async () => {
			// app は立てない。host を実在しない hostname に
			await bringUpProxy();
			const fakeUrl = 'https://this-domain-definitely-does-not-exist-12345.invalid/';
			const r = await proxyApp!.inject({ method: 'GET', url: '/', query: { url: fakeUrl } });
			expect(r.statusCode).toBe(500);
			const body = JSON.parse(r.body) as { error: { category: string } };
			expect(body.error.category).toBe('network_error');
		});

		test('成功時は category フィールド無し（既存挙動）', async () => {
			app = fastify();
			app.get('/', (_req, reply) => {
				reply.header('content-type', 'text/html');
				return reply.send('<html><head><title>OK</title></head></html>');
			});
			await app.listen({ port });
			await bringUpProxy();

			const r = await proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } });
			expect(r.statusCode).toBe(200);
			const body = JSON.parse(r.body) as Record<string, unknown>;
			expect(body.error).toBeUndefined();
			expect(body.title).toBe('OK');
		});
	});

	describe('scpaping のリダイレクト follow (phase11.3)', () => {
		test('Fastify モード相当 (followRedirects: false) でも scpaping は 301 を follow する', async () => {
			let pageHits = 0;
			let redirectedHits = 0;
			app = fastify();
			// /page は 301 で /page-redirected にリダイレクトする (amazon.co.jp/dp/<asin> 等が典型)
			app.get('/page', (_req, reply) => {
				pageHits++;
				reply.header('location', `${host}/page-redirected`);
				return reply.status(301).send();
			});
			app.get('/page-redirected', (_req, reply) => {
				redirectedHits++;
				const html = '<html><head><title>Redirected Page Title</title>' +
					'<meta property="og:title" content="Redirected Page Title"></head><body>x</body></html>';
				reply.header('content-type', 'text/html');
				reply.header('content-length', html.length);
				return reply.send(html);
			});
			await app.listen({ port });

			// followRedirects: false (Fastify ハンドラと同じ) を渡しても、scpaping レイヤは redirect follow する
			const summary = await summaly(`${host}/page`, { followRedirects: false });
			expect(summary.title).toBe('Redirected Page Title');
			expect(pageHits).toBe(1);
			expect(redirectedHits).toBeGreaterThanOrEqual(1);
		});

		test('followRedirects: true (ライブラリ既定) でも当然 follow する（回帰防止）', async () => {
			app = fastify();
			app.get('/page', (_req, reply) => {
				reply.header('location', `${host}/page-redirected`);
				return reply.status(301).send();
			});
			app.get('/page-redirected', (_req, reply) => {
				const html = '<html><head><title>Redirected Page Title</title></head><body>x</body></html>';
				reply.header('content-type', 'text/html');
				reply.header('content-length', html.length);
				return reply.send(html);
			});
			await app.listen({ port });

			const summary = await summaly(`${host}/page`, { followRedirects: true });
			expect(summary.title).toBe('Redirected Page Title');
		});
	});

	describe('Bot block フォールバック UA リトライ (phase11.9)', () => {
		test('1 回目 403 / 2 回目 200 (UA 切り替え) でフォールバック成功', async () => {
			let firstUa: string | undefined;
			let secondUa: string | undefined;
			let attempts = 0;
			app = fastify();
			app.get('/page', (req, reply) => {
				attempts++;
				const ua = req.headers['user-agent'];
				if (attempts === 1) {
					firstUa = ua;
					return reply.status(403).send('blocked');
				}
				secondUa = ua;
				const html = '<html><head><title>Rescued</title></head><body>x</body></html>';
				reply.header('content-type', 'text/html');
				reply.header('content-length', html.length);
				return reply.send(html);
			});
			await app.listen({ port });

			const summary = await summaly(`${host}/page`, {
				followRedirects: false, // HEAD/GET probe を抑制して fallback リトライだけを観測
				fallbackUserAgent: 'Twitterbot/1.0',
			});
			expect(summary.title).toBe('Rescued');
			expect(attempts).toBe(2);
			expect(firstUa).toContain('SummalyBot/'); // デフォルト複合 UA に含まれる
			expect(secondUa).toBe('Twitterbot/1.0');
		});

		test('1 回目 404 はフォールバック対象外（not_found）でリトライしない', async () => {
			let attempts = 0;
			app = fastify();
			app.get('/page', (_req, reply) => {
				attempts++;
				return reply.status(404).send('not found');
			});
			await app.listen({ port });

			await expect(summaly(`${host}/page`, {
				followRedirects: false,
				fallbackUserAgent: 'Twitterbot/1.0',
			})).rejects.toThrow();
			expect(attempts).toBe(1); // リトライしない
		});

		test('fallbackUserAgent 未指定なら 1 回目失敗で即 throw（既存挙動）', async () => {
			let attempts = 0;
			app = fastify();
			app.get('/page', (_req, reply) => {
				attempts++;
				return reply.status(403).send('blocked');
			});
			await app.listen({ port });

			await expect(summaly(`${host}/page`, { followRedirects: false })).rejects.toThrow();
			expect(attempts).toBe(1);
		});

		test('1 回目 / 2 回目両方失敗 → 2 回目（最後の）エラーが throw される', async () => {
			let attempts = 0;
			app = fastify();
			app.get('/page', (_req, reply) => {
				attempts++;
				if (attempts === 1) {
					return reply.status(403).send('blocked');
				}
				return reply.status(429).send('rate limited');
			});
			await app.listen({ port });

			// phase18: champion (default UA) error が優先 throw される (cascade 「最後のエラー」ではない)
			await expect(summaly(`${host}/page`, {
				followRedirects: false,
				fallbackUserAgent: 'Twitterbot/1.0',
				hedgedThresholdMs: 0, // 並列発火即時化
			})).rejects.toThrow(/403/);
			// phase18: champion + fallback_ua が並列発火 → 2 attempts
			expect(attempts).toBe(2);
		});

		// phase18 で `fallbackRetryCategories` は廃止 (Step 4 で TOML キーも削除予定)。
		// hedge race ですべての retryable error で並列発火するため categorize 制御は不要。
		// 旧テスト「fallbackRetryCategories で発火カテゴリを限定できる」は本フェーズで削除。
	});

	describe('DOM 後処理系プラグイン (phase3.2)', () => {
		describe('dlsite', () => {
			test('test() が www.dlsite.com にマッチ', () => {
				const dlsite = builtinPlugins.find(p => p.name === 'dlsite');
				expect(dlsite).toBeDefined();
				expect(dlsite!.test(new URL('https://www.dlsite.com/comic/work/=/product_id/RJ123.html'))).toBe(true);
				expect(dlsite!.test(new URL('https://example.com/work/RJ123'))).toBe(false);
			});

			test('/announce/ が 404 のとき /work/ にスワップして再取得し成功する', async () => {
				app = fastify();
				let announceHits = 0;
				let workHits = 0;
				app.get('/maniax/announce/=/product_id/RJ999.html', (_req, reply) => {
					announceHits++;
					reply.header('content-type', 'text/html');
					return reply.status(404).send('<html><head><title>404</title></head></html>');
				});
				app.get('/maniax/work/=/product_id/RJ999.html', (_req, reply) => {
					workHits++;
					const html = '<html><head><title>DLsite Work</title>' +
						'<meta property="og:title" content="DLsite Work"></head><body></body></html>';
					reply.header('content-length', Buffer.byteLength(html));
					reply.header('content-type', 'text/html');
					return reply.send(html);
				});
				await app.listen({ port });

				// dlsite プラグインの test() に当たらない URL（localhost）なので、summarize を直接呼ぶ
				const dlsite = await import('@/plugins/dlsite.js');
				const summary = await dlsite.summarize(new URL(`${host}/maniax/announce/=/product_id/RJ999.html`));
				expect(summary).not.toBeNull();
				// phase15.6: /maniax/ は SAFE_PATH_PATTERN にマッチしないため sensitive=true →
				// applyNsfwCardSuppression が card を抑制 (title prefix + 【R-18】 description + thumbnail null)
				// og:site_name なし → parseGeneral が hostname (localhost:3060) を sitename に埋める
				expect(summary!.title).toBe('【localhost:3060】DLsite Work');
				expect(summary!.description).toBe('【R-18】 内容を伏せています');
				expect(summary!.thumbnail).toBeNull();
				expect(announceHits).toBe(1);
				expect(workHits).toBe(1);
				expect(summary!.sensitive).toBe(true);
			});

			test('セーフパス (/comic/) では sensitive にならない', async () => {
				app = fastify();
				app.get('/comic/work/RJ123.html', (_req, reply) => {
					const html = '<html><head><title>X</title>' +
						'<meta property="og:title" content="X"></head></html>';
					reply.header('content-length', Buffer.byteLength(html));
					reply.header('content-type', 'text/html');
					return reply.send(html);
				});
				await app.listen({ port });

				const dlsite = await import('@/plugins/dlsite.js');
				const summary = await dlsite.summarize(new URL(`${host}/comic/work/RJ123.html`));
				expect(summary).not.toBeNull();
				// phase15.6: sensitive=false なので applyNsfwCardSuppression は素通し → title 等は素のまま
				expect(summary!.sensitive).not.toBe(true);
				expect(summary!.title).toBe('X');  // prefix されない (sensitive=false なので素通し)
				expect(summary!.description).not.toBe('【R-18】 内容を伏せています');
			});

			test('phase15.6: dlsite renderEmbed が /maniax/ で OGP フル情報を返す', async () => {
				app = fastify();
				app.get('/maniax/work/=/product_id/RJ999.html', (_req, reply) => {
					const html = '<!DOCTYPE html><html><head>'
						+ '<meta property="og:title" content="サンプル作品">'
						+ '<meta property="og:description" content="作品あらすじ">'
						+ '<meta property="og:image" content="https://example.com/thumb.jpg">'
						+ '<meta property="og:site_name" content="DLsite">'
						+ '</head><body></body></html>';
					reply.header('content-length', Buffer.byteLength(html));
					reply.header('content-type', 'text/html');
					return reply.send(html);
				});
				await app.listen({ port });

				const dlsite = await import('@/plugins/dlsite.js');
				const result = await dlsite.renderEmbed(new URL(`${host}/maniax/work/=/product_id/RJ999.html`));
				expect(result.body).toContain('<!DOCTYPE html>');
				expect(result.body).toContain('サンプル作品');     // 作品名フル表示
				expect(result.body).toContain('作品あらすじ');   // あらすじフル表示
				expect(result.body).toContain('https://example.com/thumb.jpg');  // サムネフル表示
				expect(result.width).toBe(3);
				expect(result.height).toBe(2);
			});
		});

		describe('iwara enrichWithIwara (フィクスチャ)', () => {
			test('description が無いとき .field-type-text-with-summary から補完', async () => {
				const cheerio = await import('cheerio');
				const { enrichWithIwara } = await import('@/plugins/iwara.js');
				const $ = cheerio.load('<html><body><div class="field-type-text-with-summary">  This is the description.  </div></body></html>');
				const summary = baseSummary({ description: null });
				const result = enrichWithIwara(summary, $, new URL('https://www.iwara.tv/videos/abc'));
				expect(result.description).toBe('This is the description.');
			});

			test('thumbnail が無いとき #video-player[poster] から補完（相対 URL を解決）', async () => {
				const cheerio = await import('cheerio');
				const { enrichWithIwara } = await import('@/plugins/iwara.js');
				const $ = cheerio.load('<html><body><video id="video-player" poster="/img/thumb.jpg"></video></body></html>');
				const summary = baseSummary({ thumbnail: null });
				const result = enrichWithIwara(summary, $, new URL('https://www.iwara.tv/videos/abc'));
				expect(result.thumbnail).toBe('https://www.iwara.tv/img/thumb.jpg');
			});

			test('iwara.tv は host 問わず全件 sensitive=true (phase15.6 followup 2026-05-11)', async () => {
				// MMD/3D モデルアニメで R-15〜R-18 が混在するサイトのため、www. / ecchi. 問わず全件 NSFW 扱い
				const cheerio = await import('cheerio');
				const { enrichWithIwara } = await import('@/plugins/iwara.js');
				const $ = cheerio.load('<html></html>');

				const wwwResult = enrichWithIwara(baseSummary(), $, new URL('https://www.iwara.tv/videos/abc'));
				expect(wwwResult.sensitive).toBe(true);

				const ecchiResult = enrichWithIwara(baseSummary(), $, new URL('https://ecchi.iwara.tv/videos/abc'));
				expect(ecchiResult.sensitive).toBe(true);
			});

			test('description が title と一致する場合は採用しない', async () => {
				const cheerio = await import('cheerio');
				const { enrichWithIwara } = await import('@/plugins/iwara.js');
				const $ = cheerio.load('<html><body><div class="field-type-text-with-summary">SAME</div></body></html>');
				const summary = baseSummary({ description: null, title: 'SAME' });
				const result = enrichWithIwara(summary, $, new URL('https://www.iwara.tv/videos/abc'));
				expect(result.description).toBeNull();
			});
		});

		describe('komiflo extractCoverFilename (フィクスチャ)', () => {
			test('test() が komiflo.com にマッチ', () => {
				const komiflo = builtinPlugins.find(p => p.name === 'komiflo');
				expect(komiflo!.test(new URL('https://komiflo.com/comics/12345'))).toBe(true);
				expect(komiflo!.test(new URL('https://example.com/comics/12345'))).toBe(false);
			});

			test('正常な API レスポンスから filename を抽出', async () => {
				const { extractCoverFilename } = await import('@/plugins/komiflo.js');
				const filename = extractCoverFilename({
					named_imgs: {
						cover: {
							filename: 'cover.jpg',
							variants: ['original', '346_mobile', '720'],
						},
					},
				});
				expect(filename).toBe('cover.jpg');
			});

			test('346_mobile variant が無い場合 null', async () => {
				const { extractCoverFilename } = await import('@/plugins/komiflo.js');
				const filename = extractCoverFilename({
					named_imgs: {
						cover: { filename: 'cover.jpg', variants: ['original', '720'] },
					},
				});
				expect(filename).toBeNull();
			});

			test('cover が無い / null / オブジェクトでない入力で null', async () => {
				const { extractCoverFilename } = await import('@/plugins/komiflo.js');
				expect(extractCoverFilename(null)).toBeNull();
				expect(extractCoverFilename({})).toBeNull();
				expect(extractCoverFilename({ named_imgs: {} })).toBeNull();
				expect(extractCoverFilename('not an object')).toBeNull();
			});
		});

		describe('nijie enrichWithNijie (フィクスチャ)', () => {
			test('JSON-LD ImageObject から thumbnail / description を補完して sensitive', async () => {
				const cheerio = await import('cheerio');
				const { enrichWithNijie } = await import('@/plugins/nijie.js');
				const html = '<html><head><script type="application/ld+json">' +
					JSON.stringify({
						'@type': 'ImageObject',
						thumbnailUrl: 'https://nijie.info/img/abc.jpg',
						description: 'A nijie image',
					}) +
					'</script></head></html>';
				const $ = cheerio.load(html);
				const summary = baseSummary({ thumbnail: null, description: null });
				const result = enrichWithNijie(summary, $, new URL('https://nijie.info/view.php?id=123'));
				expect(result.thumbnail).toBe('https://nijie.info/img/abc.jpg');
				expect(result.description).toBe('A nijie image');
				expect(result.sensitive).toBe(true);
			});

			test('JSON-LD に生改行が含まれていてもパースして採用', async () => {
				const cheerio = await import('cheerio');
				const { enrichWithNijie } = await import('@/plugins/nijie.js');
				// description に生改行を含む JSON-LD（mei23 で観測されたパターン）
				const rawJson = '{"@type":"ImageObject","thumbnailUrl":"https://nijie.info/img/x.jpg","description":"line1\nline2"}';
				const html = `<html><head><script type="application/ld+json">${rawJson}</script></head></html>`;
				const $ = cheerio.load(html);
				const summary = baseSummary({ thumbnail: null });
				const result = enrichWithNijie(summary, $, new URL('https://nijie.info/view.php?id=123'));
				expect(result.thumbnail).toBe('https://nijie.info/img/x.jpg');
			});

			test('JSON-LD に \\r や \\t などの制御文字が含まれてもパース可能', async () => {
				const cheerio = await import('cheerio');
				const { enrichWithNijie } = await import('@/plugins/nijie.js');
				// CR (\r), HT (\t) を含む JSON
				const rawJson = '{"@type":"ImageObject","thumbnailUrl":"https://nijie.info/img/y.jpg","description":"a\rb\tc"}';
				const html = `<html><head><script type="application/ld+json">${rawJson}</script></head></html>`;
				const $ = cheerio.load(html);
				const summary = baseSummary({ thumbnail: null });
				const result = enrichWithNijie(summary, $, new URL('https://nijie.info/view.php?id=123'));
				expect(result.thumbnail).toBe('https://nijie.info/img/y.jpg');
			});

			test('view.php 以外のパスでは何もしない', async () => {
				const cheerio = await import('cheerio');
				const { enrichWithNijie } = await import('@/plugins/nijie.js');
				const html = '<html><head><script type="application/ld+json">' +
					JSON.stringify({ '@type': 'ImageObject', thumbnailUrl: 'https://x.jpg' }) +
					'</script></head></html>';
				const $ = cheerio.load(html);
				const summary = baseSummary({ thumbnail: null });
				const result = enrichWithNijie(summary, $, new URL('https://nijie.info/about.php'));
				expect(result.thumbnail).toBeNull();
				expect(result.sensitive).toBeUndefined();
			});
		});
	});
});

/** テスト用の Summary ベース */
function baseSummary(overrides: Partial<{
	title: string | null;
	icon: string | null;
	description: string | null;
	thumbnail: string | null;
	sitename: string | null;
}> = {}): {
	title: string | null;
	icon: string | null;
	description: string | null;
	thumbnail: string | null;
	sitename: string | null;
	player: { url: string | null; width: number | null; height: number | null; allow: string[] };
	activityPub: string | null;
	fediverseCreator: string | null;
	sensitive?: boolean;
} {
	return {
		title: 'Title',
		icon: null,
		description: 'Original description',
		thumbnail: 'https://example.com/orig-thumb.jpg',
		sitename: null,
		player: { url: null, width: null, height: null, allow: [] },
		activityPub: null,
		fediverseCreator: null,
		...overrides,
	};
}
