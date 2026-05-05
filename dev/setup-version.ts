/**
 * `_VERSION_` / `_GIT_COMMIT_` / `_GIT_MESSAGE_` は本来 tsdown / vitest の `define` で注入される
 * ビルド時定数。tsx で TS を直接実行する dev サーバではビルドステップを通らないため、
 * `package.json` の version と git の HEAD 情報を読み込んで `globalThis` に手動で割り当てる。
 *
 * ESM の評価順は depth-first で、`server.ts` 内の最初の import がこの side-effect import なら、
 * 後続の `../src/index.js` 経由で `src/utils/got.ts` や `/v` エンドポイントが評価される時点で
 * 全定数は定義済み。
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const _dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(_dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8')) as { version: string };

function safeGit(args: string[]): string {
	try {
		return execSync(`git ${args.join(' ')}`, { encoding: 'utf-8', cwd: projectRoot }).trim();
	} catch {
		return 'unknown';
	}
}

// 既に定義済みなら上書きしない（tsdown ビルド出力を import するルートでも安全）
const g = globalThis as Record<string, unknown>;
if (g._VERSION_ === undefined) g._VERSION_ = pkg.version;
if (g._GIT_COMMIT_ === undefined) g._GIT_COMMIT_ = safeGit(['rev-parse', '--short', 'HEAD']);
if (g._GIT_MESSAGE_ === undefined) g._GIT_MESSAGE_ = safeGit(['log', '-1', '--pretty=%s']);
