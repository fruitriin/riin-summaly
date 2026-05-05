#!/usr/bin/env node
/**
 * HMAC 署名生成ヘルパ。Worker のローカル動作確認用 (phase12.1 Step 1.2)。
 *
 * 使い方:
 *   export SHARED_SECRET="..."         # wrangler secret put SHARED_SECRET と同じ値
 *   node tools/cf-proxy-worker/sign.mjs "https://www.amazon.co.jp/dp/B0C4LRBFX6"
 *
 * 出力:
 *   curl -H "X-Summaly-Sig: <hex>" -H "X-Summaly-Ts: <ms>" \
 *        "https://summaly-proxy.<your>.workers.dev/?url=<encoded>"
 *
 * のように、curl コマンドそのものを生成する（コピペで実行可能）。
 */

import { createHmac } from 'node:crypto';
import process from 'node:process';

const target = process.argv[2];
const workerBase = process.argv[3] ?? 'https://summaly-proxy.<your>.workers.dev';
const secret = process.env.SHARED_SECRET;

if (target == null || target === '') {
	console.error('usage: node sign.mjs <target_url> [worker_base_url]');
	console.error('  env SHARED_SECRET (required)');
	process.exit(1);
}
if (secret == null || secret === '') {
	console.error('error: SHARED_SECRET environment variable is required');
	process.exit(1);
}

// 引数の URL 形式を検証（W-5: shell injection 対策）。
// 出力は `| bash` で実行されることを想定しているため、引数に `"` `;` `\n` 等が
// 含まれているとエスケープが破綻する。URL 構文に通らない引数は早期 reject。
function assertHttpsUrl(value, label) {
	let u;
	try { u = new URL(value); } catch {
		console.error(`error: ${label} is not a valid URL: ${value}`);
		process.exit(1);
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') {
		console.error(`error: ${label} must be http(s): ${value}`);
		process.exit(1);
	}
	// 制御文字 / 引用符が混入していないかも見る（URL parser 通った後でも念のため）
	if (/["';\n\r\\]/.test(value)) {
		console.error(`error: ${label} contains shell-unsafe characters`);
		process.exit(1);
	}
}
assertHttpsUrl(target, 'target_url');
assertHttpsUrl(workerBase, 'worker_base_url');

const ts = Date.now().toString();
const message = `${target}\n${ts}`;
const sig = createHmac('sha256', secret).update(message).digest('hex');

const encoded = encodeURIComponent(target);
const cmd = [
	'curl',
	'-sS',
	'-H', `"X-Summaly-Sig: ${sig}"`,
	'-H', `"X-Summaly-Ts: ${ts}"`,
	'-H', `"X-Summaly-Forward-UA: Mozilla/5.0 (compatible; SummalyBot/dev)"`,
	`"${workerBase}/?url=${encoded}"`,
].join(' ');

console.log(cmd);
