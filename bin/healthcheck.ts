/**
 * 起動時 healthcheck (phase16.4)。
 *
 * `[scraping.proxy]` / `[scraping.curl_cffi]` / `[embed]` の `enabled = true` 時、
 * 設定値が placeholder のままだったり実体が存在しない (uv が PATH に無い、projectDir が無い等)
 * 場合を起動時に fail-fast で検出する。
 *
 * **設計方針**:
 * - `config.example.toml` では `enabled = false` でも有効化時に必須なキー (`url` / `secret` /
 *   `projectDir` / `uvPath`) を **コメント無しの placeholder 値** で書いておく。
 *   これにより運用者が `enabled = true` にするだけで「次に何を埋めるべきか」が一目で分かる。
 * - placeholder のまま `enabled = true` にしても起動失敗 (DNS 解決失敗 / spawn 失敗を待たない)。
 * - エラーメッセージで具体的な対処を案内 (どこを直すか + 関連ドキュメントへのリンク)。
 *
 * library mode (= `summaly()` 直接呼び出し) では走らない。`bin/summaly-server.ts` の起動シーケンスで
 * `parseTomlConfig` 直後に 1 回呼ぶ。
 */

import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { ParsedConfig } from './config-loader.js';

/** placeholder と判定する文字列パターン (`<your>` / `<...>` / `<anything>` 形式) */
const PLACEHOLDER_PATTERN = /<[^>]+>/;

/**
 * `enabled = true` 時の各セクションの設定値を検証し、placeholder / 実体不在を fail-fast で検出する。
 * proxy の実 HTTP 疎通テスト (Worker が deploy されているか) は phase16.4 のスコープ外、別 phase で対応。
 */
export function runConfigHealthchecks(config: ParsedConfig): void {
	checkProxy(config);
	checkCurlCffi(config);
	checkEmbed(config);
}

function checkProxy(config: ParsedConfig): void {
	const cfg = config.summaly.proxyFallback;
	if (cfg === undefined || !cfg.enabled) return;

	if (PLACEHOLDER_PATTERN.test(cfg.url)) {
		throw new Error(
			`config: scraping.proxy.url が placeholder のままです: ${cfg.url}\n`
			+ `  対処: tools/cf-proxy-worker/README.md に従って Worker を deploy し、deploy 後の URL を `
			+ `[scraping.proxy].url または env SUMMALY_PROXY_URL に設定してください`,
		);
	}
	// secret は phase16.3 で既に「未設定で起動失敗」になっているが、placeholder 文字列も検出
	if (cfg.secret === '...' || PLACEHOLDER_PATTERN.test(cfg.secret)) {
		throw new Error(
			`config: scraping.proxy.secret が placeholder のままです\n`
			+ `  対処: env SUMMALY_PROXY_SECRET に Worker 側 SHARED_SECRET と同じ値を設定してください`,
		);
	}
}

function checkCurlCffi(config: ParsedConfig): void {
	const cfg = config.summaly.curlCffiFallback;
	if (cfg === undefined || !cfg.enabled) return;

	// placeholder 検出 (config.example.toml の `/path/to/...` を吸収)
	if (cfg.projectDir.includes('/path/to/') || PLACEHOLDER_PATTERN.test(cfg.projectDir)) {
		throw new Error(
			`config: scraping.curl_cffi.projectDir が placeholder のままです: ${cfg.projectDir}\n`
			+ `  対処: tools/curl-cffi-fetcher/ の絶対パス (例: /home/user/summaly/tools/curl-cffi-fetcher) を設定してください`,
		);
	}
	// 存在確認
	if (!existsSync(cfg.projectDir)) {
		throw new Error(
			`config: scraping.curl_cffi.projectDir が存在しません: ${cfg.projectDir}\n`
			+ `  対処: tools/curl-cffi-fetcher/ ディレクトリの絶対パスを設定し、`
			+ `\`cd <projectDir> && uv sync\` で依存をインストールしてください`,
		);
	}
	if (!statSync(cfg.projectDir).isDirectory()) {
		throw new Error(`config: scraping.curl_cffi.projectDir はディレクトリではありません: ${cfg.projectDir}`);
	}

	// uv 実行可能性チェック (`uv --version` が exit 0 で返るか)
	let result;
	try {
		result = spawnSync(cfg.uvPath, ['--version'], { encoding: 'utf-8', timeout: 5000 });
	} catch (e) {
		throw new Error(
			`config: scraping.curl_cffi.uvPath での uv 実行で例外: ${cfg.uvPath}\n`
			+ `  詳細: ${e instanceof Error ? e.message : String(e)}\n`
			+ `  対処: \`which uv\` で実体パスを確認し、uvPath に設定してください`,
		);
	}
	if (result.error || result.status !== 0) {
		const msg = result.error?.message ?? result.stderr ?? `exit code ${result.status}`;
		throw new Error(
			`config: scraping.curl_cffi.uvPath で uv が実行できません: ${cfg.uvPath}\n`
			+ `  詳細: ${msg}\n`
			+ `  対処: uv (https://docs.astral.sh/uv/) をインストールし、PATH 上の実体パスを uvPath に設定してください`,
		);
	}
}

function checkEmbed(config: ParsedConfig): void {
	const embed = config.summaly.embedConfig;
	if (embed === undefined || !embed.enabled) return;

	// placeholder URL 検出 (publicUrl が `https://summaly.example.com` 等の placeholder を含む場合)
	const baseUrl = config.summaly.embedBaseUrl;
	if (baseUrl !== undefined && PLACEHOLDER_PATTERN.test(baseUrl)) {
		throw new Error(
			`config: embed.publicUrl が placeholder のままです: ${baseUrl}\n`
			+ `  対処: summaly が外部公開されている https URL (Misskey から到達可能なもの) を設定してください`,
		);
	}
	// publicUrl 未設定だが enabled = true → 警告のみ (起動は通す。embed 機能は実質無効になるが、
	// `[embed].enabled = false` への切り替えを促す)
	if (baseUrl === undefined) {
		process.stderr.write(
			`[summaly][embed] enabled = true ですが publicUrl 未設定です。`
			+ `player.url が組み立てられないため embed 機能は実質無効です。\n`,
		);
	}
}
