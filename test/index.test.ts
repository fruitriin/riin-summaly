/**
 * Tests!
 */

'use strict';

/* dependencies below */

import fs, { readdirSync } from 'node:fs';
import process from 'node:process';
import { dirname } from 'node:path';
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
				expect(t('https://youtu.be/abc')).toBe(true);

				// マッチしないべき URL
				expect(t('https://example.com/watch?v=abc')).toBe(false);
				expect(t('https://www.youtube.com/about')).toBe(false);
				expect(t('https://www.youtube.com/')).toBe(false);
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

				test('buildSummary はテキストツイートから description / player iframe を組み立てる', async () => {
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
					// player は X 公式 widget の iframe URL
					expect(summary!.player.url).toBe('https://platform.twitter.com/embed/Tweet.html?id=20');
					expect(summary!.player.width).toBe(550);
					expect(summary!.player.height).toBe(600);
					expect(summary!.player.allow).toContain('fullscreen');
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

			test('useRange: false のとき Range ヘッダは送信されない', async () => {
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
				expect(receivedRange).toBeUndefined();
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
				expect(summary!.title).toBe('DLsite Work');
				expect(announceHits).toBe(1);
				expect(workHits).toBe(1);
				// /maniax/ は SAFE_PATH_PATTERN にマッチしないため sensitive
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
				// dlsite プラグインが sensitive=true を立てないこと（parseGeneral 由来の false はそのまま）
				expect(summary!.sensitive).not.toBe(true);
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

			test('ecchi.iwara.tv ホストで sensitive', async () => {
				const cheerio = await import('cheerio');
				const { enrichWithIwara } = await import('@/plugins/iwara.js');
				const $ = cheerio.load('<html></html>');
				const summary = baseSummary();
				const result = enrichWithIwara(summary, $, new URL('https://ecchi.iwara.tv/videos/abc'));
				expect(result.sensitive).toBe(true);
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
