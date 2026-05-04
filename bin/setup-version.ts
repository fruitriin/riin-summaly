/**
 * `_VERSION_` は本来 tsdown / vitest の `define` で注入されるビルド時定数。
 * tsx で TS を直接実行する `bin/summaly-server.ts` ではビルドステップを通らないため、
 * `package.json` の version を読み込んで `globalThis._VERSION_` に手動で割り当てる。
 *
 * ESM の評価順は depth-first で、`bin/summaly-server.ts` 内の最初の import がこの side-effect import なら、
 * 後続の `../src/index.js` 経由で `src/utils/got.ts` が評価される時点で `_VERSION_` は定義済み。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const _dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(_dirname, '..', 'package.json'), 'utf-8')) as { version: string };

if ((globalThis as Record<string, unknown>)._VERSION_ === undefined) {
	(globalThis as Record<string, unknown>)._VERSION_ = pkg.version;
}
