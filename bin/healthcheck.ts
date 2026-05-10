/**
 * 起動時 healthcheck。
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
 * proxy の実 HTTP 疎通テスト (Worker が deploy されているか) は別タスクで対応 (TODO.md phase16.6)。
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
	// secret は config-loader 段で「未設定で起動失敗」を担保済だが、placeholder 文字列も検出
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
	let versionResult;
	try {
		versionResult = spawnSync(cfg.uvPath, ['--version'], { encoding: 'utf-8', timeout: 5000 });
	} catch (e) {
		throw new Error(
			`config: scraping.curl_cffi.uvPath での uv 実行で例外: ${cfg.uvPath}\n`
			+ `  詳細: ${e instanceof Error ? e.message : String(e)}\n`
			+ `  対処: \`which uv\` で実体パスを確認し、uvPath に設定してください`,
		);
	}
	if (versionResult.error || versionResult.status !== 0) {
		const msg = versionResult.error?.message ?? versionResult.stderr ?? `exit code ${versionResult.status}`;
		throw new Error(
			`config: scraping.curl_cffi.uvPath で uv が実行できません: ${cfg.uvPath}\n`
			+ `  詳細: ${msg}\n`
			+ `  対処: uv (https://docs.astral.sh/uv/) をインストールし、PATH 上の実体パスを uvPath に設定してください`,
		);
	}

	// **`uv run fetch --help` まで通るか確認** (phase18.1 強化)。
	// `uv --version` だけでは「curl_cffi 依存 install 済み + fetch script entry point 解決可能」を確認できない。
	// 本番診断: 「uv は通るが `uv run fetch` が即 error する」(本番 monotaro で curl_cffi 5153ms = 153ms 即 fail) パターンを起動時 fail-fast に。
	// `--help` なら fetch.py の `import curl_cffi` まで実行されるため、依存欠落 / venv 未初期化を catch できる。
	// timeout は 60s 余裕 (初回 `uv sync` で venv 構築から始まると数十秒かかる可能性、cold start を含めて運用者に挙動明示)
	let helpResult;
	try {
		helpResult = spawnSync(cfg.uvPath, ['run', 'fetch', '--help'], {
			encoding: 'utf-8',
			cwd: cfg.projectDir,
			timeout: 60000,
		});
	} catch (e) {
		throw new Error(
			`config: scraping.curl_cffi で \`uv run fetch --help\` 実行で例外: ${cfg.uvPath}\n`
			+ `  詳細: ${e instanceof Error ? e.message : String(e)}\n`
			+ `  cwd: ${cfg.projectDir}`,
		);
	}
	if (helpResult.error || helpResult.status !== 0) {
		const stderr = (helpResult.stderr ?? '').slice(0, 800);
		throw new Error(
			`config: scraping.curl_cffi で \`uv run fetch --help\` が失敗: cwd=${cfg.projectDir}\n`
			+ `  exit code: ${helpResult.status}\n`
			+ `  stderr (先頭 800 字): ${stderr}\n`
			+ `  対処の候補:\n`
			+ `    (a) \`cd ${cfg.projectDir} && uv sync\` で依存をインストール\n`
			+ `    (b) tools/curl-cffi-fetcher/pyproject.toml の \`[project.scripts]\` に fetch entry point があるか確認\n`
			+ `    (c) projectDir パスが本当に tools/curl-cffi-fetcher を指しているか確認`,
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
