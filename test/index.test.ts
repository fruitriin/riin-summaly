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
import { expect, test, describe, beforeEach, afterEach } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import summalyPlugin, { summaly, summalyDefaultOptions } from '@/index.js';
import { StatusError } from '@/utils/status-error.js';
import { getJson } from '@/utils/got.js';
import { KNOWN_SHORT_HOSTS } from '@/utils/short-urls.js';
import { BROWSER_UA } from '@/utils/user-agents.js';
import { plugins as builtinPlugins } from '@/plugins/index.js';

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

describe('network tests', () => {
	skippableTest('Stage Bye Stage', async () => {
		// If this test fails, you must rewrite the result data and the example in README.md.
		const summary = await summaly('https://www.youtube.com/watch?v=NMIEAhH_fTU');
		expect(summary).toEqual(
			{
				'title': '【アイドルマスター】「Stage Bye Stage」(歌：島村卯月、渋谷凛、本田未央)',
				'icon': 'https://www.youtube.com/s/desktop/78bc1359/img/logos/favicon.ico',
				'description': 'Website▶https://columbia.jp/idolmaster/Playlist▶https://www.youtube.com/playlist?list=PL83A2998CF3BBC86D2018年7月18日発売予定THE IDOLM@STER CINDERELLA GIRLS CG STAR...',
				'thumbnail': 'https://i.ytimg.com/vi/NMIEAhH_fTU/maxresdefault.jpg',
				'player': {
					'url': 'https://www.youtube.com/embed/NMIEAhH_fTU?feature=oembed',
					'width': 200,
					'height': 113,
					'allow': [
						'autoplay',
						'clipboard-write',
						'encrypted-media',
						'picture-in-picture',
						'web-share',
						'fullscreen',
					],
				},
				'sitename': 'YouTube',
				'sensitive': false,
				'activityPub': null,
				'fediverseCreator': null,
				'url': 'https://www.youtube.com/watch?v=NMIEAhH_fTU',
			},
		);
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
	});
});
