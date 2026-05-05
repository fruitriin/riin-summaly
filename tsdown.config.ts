import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';

/**
 * git 情報をビルド時に取得する。`.git` が無い環境（npm install 経由でインストールされたソース等）では
 * 'unknown' フォールバックで build を止めない。
 */
function getGitInfo(): { commit: string; message: string } {
	try {
		return {
			commit: execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim(),
			message: execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim(),
		};
	} catch {
		return { commit: 'unknown', message: 'unknown' };
	}
}

const git = getGitInfo();

export default defineConfig({
	entry: './src/index.ts',
	outExtensions: (_) => ({ js: '.js', dts: '.d.ts' }),
	tsconfig: true,
	dts: true,
	deps: {
		skipNodeModulesBundle: true,
	},
	outDir: './built',
	define: {
		_VERSION_: JSON.stringify(JSON.parse(readFileSync('./package.json', 'utf-8')).version),
		_GIT_COMMIT_: JSON.stringify(git.commit),
		_GIT_MESSAGE_: JSON.stringify(git.message),
	},
});
