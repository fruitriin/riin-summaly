/**
 * summaly のスタンドアロン Fastify サーバ起動スクリプト。
 *
 * 使い方:
 *   pnpm serve [config.toml]
 *   pnpm serve                       # SUMMALY_CONFIG_PATH または ./config.toml をデフォルトに
 *   SUMMALY_CONFIG_PATH=/etc/summaly/config.toml pnpm serve
 *
 * fastify-cli の `--options config.json` を置き換える形で、TOML ベースの設定を読む。
 * `[server]` host / port、`[summaly]` / `[summaly.cache]` / `[summaly.pdf]` / `[plugins]` を
 * `SummalyOptions` にマップして `register(Summaly, opts)` する。
 */

// ビルド時定数 `_VERSION_` を tsx 実行環境向けに注入する（必ず src/ より前に import する）
import './setup-version.js';

import process from 'node:process';
import Fastify from 'fastify';
import Summaly from '../src/index.js';
import { parseTomlConfig } from './config-loader.js';
import { runConfigHealthchecks } from './healthcheck.js';

const configPath = process.argv[2] ?? process.env.SUMMALY_CONFIG_PATH ?? './config.toml';

let cfg;
try {
	cfg = parseTomlConfig(configPath);
} catch (e) {
	console.error(`[summaly-server] failed to load config: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
}

// 起動時 healthcheck (placeholder + 疎通検証)。
// `enabled = true` の各セクション設定値が placeholder のままだったり、uv が PATH に無い等を fail-fast。
try {
	runConfigHealthchecks(cfg);
} catch (e) {
	console.error(`[summaly-server] healthcheck failed:\n${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
}

const app = Fastify({ logger: true });
app.log.info(`summaly-server: loaded config from ${configPath}`);

// 想定外エラー (404 ハンドラ未登録 / register 失敗 / setErrorHandler に飛ぶ throw 等) の最終フォールバック。
// summaly プラグイン本体のエラー (try/catch して return しているもの) はこのハンドラには飛ばないが、
// 404 ハンドラ未マッチや plugin scope 外の throw を観測ログに残せる。
app.setErrorHandler((err, req, reply) => {
	req.log.error({ err, url: req.url }, 'unhandled fastify error');
	reply.status(500).send({
		error: { name: 'InternalServerError', message: 'unhandled error' },
	});
});

await app.register(Summaly, cfg.summaly);

const host = cfg.server.host ?? '127.0.0.1';
const port = cfg.server.port ?? 3000;

const shutdown = async (signal: string): Promise<void> => {
	app.log.info(`received ${signal}, closing...`);
	try {
		await app.close();
		process.exit(0);
	} catch (e) {
		app.log.error(e);
		process.exit(1);
	}
};
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

try {
	await app.listen({ host, port });
} catch (e) {
	app.log.error(e);
	process.exit(1);
}
