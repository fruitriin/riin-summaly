import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

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
	resolve: {
		alias: {
			'@': fileURLToPath(new URL('./src', import.meta.url)),
		},
	},
	define: {
		_VERSION_: JSON.stringify(JSON.parse(readFileSync('./package.json', 'utf-8')).version),
		_GIT_COMMIT_: JSON.stringify(git.commit),
		_GIT_MESSAGE_: JSON.stringify(git.message),
	},
});
