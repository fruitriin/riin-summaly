# tsx で TS を直接実行する dev サーバの構築パターン

> phase7.1 で導入。本番ビルドを通さずに `pnpm dev` で TS を直接走らせる開発サーバを作るときの設計知見。

## 課題: ビルド時定数（define）が tsx ランタイムでは未定義

summaly は `_VERSION_` を tsdown / vitest の `define` で `package.json` の version 値に置き換えている（`src/utils/got.ts` の `DEFAULT_BOT_UA` で参照）。tsx は build を介さず TS を直接実行するため、`_VERSION_` が `ReferenceError` で落ちる。

### 解決: side-effect import で `globalThis` に注入

`dev/setup-version.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const _dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(_dirname, '..', 'package.json'), 'utf-8')) as { version: string };

if ((globalThis as Record<string, unknown>)._VERSION_ === undefined) {
	(globalThis as Record<string, unknown>)._VERSION_ = pkg.version;
}
```

`dev/server.ts` の最初で side-effect import:

```ts
import './setup-version.js';   // 必ず src/ より前
import { summaly } from '../src/index.js';
```

### なぜこれで動くか — ESM 評価順

ESM はモジュールグラフを構築後、**depth-first post-order** でモジュールを評価する。`server.ts` の最初の import が `./setup-version.js` なら:

1. `setup-version.ts` のサブグラフ評価（`node:fs` 等のビルトイン → `setup-version.ts` の本体実行 → `globalThis._VERSION_` 設定）
2. その後 `../src/index.ts` のサブグラフ評価が始まり、`src/utils/got.ts` の `DEFAULT_BOT_UA = \`SummalyBot/${_VERSION_}\`` が評価されるときには既に `_VERSION_` が global にある

ポイント: side-effect import は **コードに見えなくても評価順序を保証する**。`globalThis._VERSION_ = ...` をインライン文として `server.ts` の冒頭に書いても、import 文がホイストされて `src/index.ts` の評価が先に走るため動かない。**必ず別ファイルに切り出して import する**。

## 課題: 本番ビルドを汚染しない構造

`dev/` 配下のコードが本番 bundle や本番 typecheck の対象になると、devDependency への意図しない依存が混入する。

### 設計

| ファイル | 設定 |
|---|---|
| `tsdown.config.ts` | `entry: ./src/index.ts` のまま（dev/ は bundle されない） |
| `tsconfig.json` | `include: ["./src/**/*"]` のまま（本番 typecheck で dev/ を見ない） |
| `tsconfig.dev.json` | `extends: ./tsconfig.json` + `include: ["./src/**/*", "./dev/**/*.ts"]` で別途 typecheck 用 |
| `package.json` | `typecheck` script に `tsc --noEmit -p tsconfig.dev.json` を追記 |
| `eslint.config.js` | `ignores: [..., "dev"]` を追加（test と同じ扱い） |
| `package.json` `files` | `["built", "LICENSE"]` のまま（npm 公開物に dev/ は含まれない） |

### 結果

- `pnpm build`: dev/ を bundle しない
- `pnpm typecheck`: src + test + dev の 3 構成すべて検証
- `pnpm eslint`: dev を lint 対象外（dev は素早く書き換える Vanilla JS なので lint 縛りを外す）
- `npm publish`: dev は配布物に含まれない

## 課題: Fastify プラグインモードは register 時に options が固定される

summaly の Fastify プラグイン（`src/index.ts` の default export）は register 時に options が決定するため、dev UI のチェックボックス操作（`useRange` / `enablePdf` / `allowedPlugins`）を即時反映できない。

### 解決: dev サーバは `summaly()` 関数を直接叩く

dev では Fastify プラグイン mount を使わず、`summaly()` をリクエスト単位で呼ぶ薄いハンドラを書く:

```ts
app.get<{ Querystring: SummalyQuery }>('/api/summaly', async (req, reply) => {
	const opts: SummalyOptions = {
		lang: req.query.lang || null,
		useRange: req.query.useRange === '1',
		enablePdf: req.query.enablePdf === '1',
		followRedirects: true,
	};
	if (req.query.allowedPlugins) {
		opts.allowedPlugins = req.query.allowedPlugins.split(',').map(s => s.trim()).filter(Boolean);
	}
	try {
		return await summaly(req.query.url!, opts);
	} catch (e) {
		reply.status(500);
		return { error: e instanceof Error ? { message: e.message, name: e.name } : String(e) };
	}
});
```

これで UI のチェックボックスを切り替えるたびにオプション挙動の変化を検証できる。本番のプラグインモードと dev サーバはルートが違うだけで結果は同じ summaly 関数を通る。

## SSRF / 環境変数まわりの注意点

### `SUMMALY_ALLOW_PRIVATE_IP` の設定スコープ

ローカル URL をプレビューできるよう dev サーバは `SUMMALY_ALLOW_PRIVATE_IP=true` を有効にしたいが、シェル env を汚染すると `pnpm serve`（本番）にも漏れる。

```ts
process.env.SUMMALY_ALLOW_PRIVATE_IP = 'true';   // dev/server.ts 冒頭
```

プロセス内で設定する形なら、**dev サーバプロセスの寿命だけ有効** で、シェルや他のプロセスに漏れない。

### `HOST` / `PORT` の defensive validation

```ts
// 悪い例: HOST='' だと Fastify が ::（IPv6 全インターフェース）にバインド → SSRF リレー化
const host = process.env.HOST ?? '127.0.0.1';

// 良い例: 空文字列も fallback 対象にする
const rawHost = process.env.HOST;
const host = (rawHost != null && rawHost.trim() !== '') ? rawHost.trim() : '127.0.0.1';

// PORT も `Number('')` が 0、`Number('abc')` が NaN になるためサイレント誤動作
const rawPort = process.env.PORT;
const port = (rawPort != null && /^\d+$/.test(rawPort)) ? parseInt(rawPort, 10) : 3000;
```

dev サーバが LAN に意図せず公開されると、`SUMMALY_ALLOW_PRIVATE_IP=true` の状態で外部から SSRF レイテンシ計測等に使われるリスクがある。`??` ではなく明示的な空文字検証を入れる。

## embed iframe を dev サーバで動作確認する 3 点セット

本番 Fastify モード (`pnpm serve`) には `/embed` ルートが組み込まれているが、`pnpm dev` の dev サーバには **embed 機能が組み込まれていない**。`renderEmbed` 対応プラグイン (syosetu / kakuyomu 等) の動作確認をローカルで行うには、以下の **3 箇所同時修正** が必要。

### (1) `embedBaseUrl` を `summaly()` の opts に渡す

これがないと `Summary.player.url` が `null` になり、UI 上で「player.url が null」エラーになる:

```typescript
// dev/server.ts
const embedBaseUrl = process.env.EMBED_PUBLIC_URL ?? `http://localhost:${port}`;

const opts: SummalyOptions = {
  // ...
  embedBaseUrl,  // ← renderEmbed 対応プラグインが Summary.player.url を組み立てる
};
```

`composePlayerUrl` (各プラグイン) は `embedBaseUrl == null || embedBaseUrl === ''` のとき `null` を返す設計なので、env で明示的に上書きしない限り `http://localhost:<port>/embed?url=...` が使われる。

### (2) dev サーバに `/embed` ルートを最小再実装

本番 (`src/index.ts` L904-) のロジックを dev 用に簡略化して登録する:

```typescript
// dev/server.ts
import { plugins as builtinPlugins } from '../src/plugins/index.js';

app.get<{ Querystring: { url?: string } }>('/embed', async (req, reply) => {
  const rawUrl = req.query.url;
  if (rawUrl == null || rawUrl === '') return reply.code(400).type('text/plain; charset=utf-8').send('url query required');
  let parsedUrl: URL;
  try { parsedUrl = new URL(rawUrl); } catch { return reply.code(400).send('invalid url'); }
  if (parsedUrl.protocol !== 'https:') return reply.code(400).send('https only');
  const plugin = builtinPlugins.find(p =>
    p.name != null && p.renderEmbed != null && p.test(parsedUrl)
  );
  if (plugin?.renderEmbed == null) return reply.code(404).send('no plugin matched');
  let result;
  try { result = await plugin.renderEmbed(parsedUrl, {}); }
  catch (err) { app.log.error({ err }, 'embed renderEmbed failed'); return reply.code(500).send('render failed'); }
  if (/<script[\s>/]/i.test(result.body)) return reply.code(500).send('render failed');
  reply.type('text/html; charset=utf-8');
  // dev では frame-ancestors を localhost に限定 (本番は config 経由)
  reply.header(
    'Content-Security-Policy',
    `default-src 'none'; img-src https:; style-src 'unsafe-inline'; frame-ancestors 'self' http://localhost:${port} http://127.0.0.1:${port}`,
  );
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  return result.body;
});
```

本番との違い:
- `[embed].allowedPlugins` 制限なし (dev はすべての renderEmbed 対応プラグインを試したい)
- `frameAncestors` は `localhost:PORT` / `127.0.0.1:PORT` に固定 (本番 TOML 設定読み取りなし)
- body 512KB cap は dev では省略 (本番のみ defense-in-depth)

### (3) dev UI の player.url スキームチェックを localhost 許可に緩和

`dev/public/app.js` で `^https:` のみ許可していると、`http://localhost:3000/embed?...` が弾かれる:

```javascript
// 旧: https のみ許可
if (!/^https:\/\//i.test(player.url)) { /* スキップ */ }

// 新: https または http://localhost / 127.0.0.1 を許可
const isHttps = /^https:\/\//i.test(player.url);
const isLocalDev = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(player.url);
if (!isHttps && !isLocalDev) { /* スキップ */ }
```

### tsx HMR の落とし穴

`pnpm dev` は内部で `tsx dev/server.ts` を実行する。tsx は変更を watch して再起動する HMR 機能を持つが、**古いプロセスが port を保持したまま新しいプロセスが起動失敗** することがある (`EADDRINUSE`)。

#### 動作確認時の運用

- **コードを変更したら必ず Ctrl+C → `pnpm dev`** で完全再起動 (HMR を信用しない)
- 別 `PORT` で並行起動して新コードを試す: `PORT=3001 pnpm dev`
- 検証後に `pkill -f "tsx dev/server.ts"` で確実に停止

```bash
# クリーン再起動
pkill -f "tsx dev/server.ts" 2>/dev/null
sleep 1
PORT=3002 pnpm dev > /tmp/dev3002.log 2>&1 &
sleep 4
curl -s 'http://localhost:3002/api/summaly?url=<URL>' | python3 -m json.tool
curl -s 'http://localhost:3002/embed?url=<URL>' | head -c 500
```

### CSP `frame-ancestors` の dev 設定

本番では `[embed].frameAncestors = ["https://misskey.example.com"]` 等で明示制限するが、dev では UI 自身 (`localhost:PORT`) が iframe を埋め込むため:

```
frame-ancestors 'self' http://localhost:PORT http://127.0.0.1:PORT
```

`'self'` だけでも localhost:PORT は通るはずだが、`127.0.0.1` でアクセスする場合との互換性のため両方明示。本番の origin-only 厳格検証 (`embed-endpoint-design.md` のヘッダインジェクション防御) を dev で踏襲する必要はない (ローカル限定のため)。

## DOM レンダリングのサニタイズ

ユーザーデータ（`SummalyResult` のフィールド）を DOM に流し込むときは:

- 文字列値: `el.textContent = value`（`innerHTML` を使わない）
- リンク: `a.href = value` ではなく `a.href = '#'` + click handler で input フィールドに流し込む（href にユーザー入力を入れない）
- 画像: `img.src = url` の前に `/^https?:|^data:/i.test(url)` で正規化、`addEventListener('error', () => img.remove())` で broken image を消す
- iframe: `https:` のみ通す（`summaly()` 出口の `sanitizeUrl()` が既に弾くが UI 側でも二重ガード）、`player.height == null` のとき非表示（Misskey の MkUrlPreview 互換）

## 参考

- [docs/plans/phase7.1-dev-server.md](../plans/phase7.1-dev-server.md) — 設計プラン
- [dev/server.ts](../../dev/server.ts) — Fastify dev サーバ
- [dev/setup-version.ts](../../dev/setup-version.ts) — `_VERSION_` 注入
- [dev/public/app.js](../../dev/public/app.js) — Vanilla JS UI
