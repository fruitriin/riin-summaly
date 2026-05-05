import type Summary from '@/summary.js';
import type { GeneralScrapingOptions } from '@/general.js';
import { getJson } from '@/utils/got.js';

export const name = 'npmjs';

const NPM_ICON = 'https://static-production.npmjs.com/58a19602036db1daee0d7863c94673a4.png';

export function test(url: URL): boolean {
	if (!/^(?:www\.)?npmjs\.com$/.test(url.hostname)) return false;
	return url.pathname.startsWith('/package/');
}

/**
 * `/package/<name>` または `/package/@scope/name` からパッケージ名を抽出する。
 * `/v/<ver>` や `/tutorial` 等のサブパスは無視（latest 固定で構わないため）。
 */
export function extractPackageName(pathname: string): string | null {
	const m = pathname.match(/^\/package\/(@[^/]+\/[^/]+|[^/]+)/);
	return m ? m[1] : null;
}

/**
 * Registry API URL を組み立てる。`@scope/name` は `@scope%2Fname` にエンコードする
 * （registry の慣例。`@` は生のまま受けてくれる）。
 *
 * `extractPackageName` が `@scope/name` か `name` のどちらかしか返さないため
 * `pkg` 内の `/` は最大 1 件。`replace`（非 global）で十分。
 * `encodeURIComponent` だと `@` まで `%40` になる（registry は受理するが慣例外）ので使わない。
 */
export function buildRegistryUrl(pkg: string): string {
	return `https://registry.npmjs.org/${pkg.replace('/', '%2F')}`;
}

/**
 * Registry API レスポンスから Summary を組み立てる。テストから直接呼べるよう export。
 *
 * `dist-tags.latest` が不在のときも `null` フォールバックで `topDescription` だけで
 * summary を組む（Plan の throw 案より許容的にした。description が取れれば十分なため）。
 */
export function buildSummaryFromRegistry(body: unknown): Summary | null {
	if (typeof body !== 'object' || body === null) return null;
	const b = body as Record<string, unknown>;

	const pkgName = typeof b.name === 'string' ? b.name : null;
	if (pkgName === null) return null;

	const distTags = (typeof b['dist-tags'] === 'object' && b['dist-tags'] !== null)
		? b['dist-tags'] as Record<string, unknown>
		: null;
	const latest = distTags !== null && typeof distTags.latest === 'string' ? distTags.latest : null;

	const versions = (typeof b.versions === 'object' && b.versions !== null)
		? b.versions as Record<string, unknown>
		: null;
	const latestVersion = (latest !== null && versions !== null && typeof versions[latest] === 'object' && versions[latest] !== null)
		? versions[latest] as Record<string, unknown>
		: null;

	const topDescription = typeof b.description === 'string' ? b.description : null;
	const versionDescription = (latestVersion !== null && typeof latestVersion.description === 'string')
		? latestVersion.description
		: null;
	const description = topDescription ?? versionDescription;

	return {
		title: pkgName,
		icon: NPM_ICON,
		description,
		thumbnail: NPM_ICON,
		player: {
			url: null,
			width: null,
			height: null,
			allow: [],
		},
		sitename: 'npm',
		sensitive: false,
		activityPub: null,
		fediverseCreator: null,
	};
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
	const pkg = extractPackageName(url.pathname);
	if (pkg === null) return null;

	const apiUrl = buildRegistryUrl(pkg);
	const body = await getJson(apiUrl, undefined, opts);
	const summary = buildSummaryFromRegistry(body);
	if (summary === null) {
		throw new Error('failed summarize: npm registry response missing required fields');
	}
	return summary;
}
