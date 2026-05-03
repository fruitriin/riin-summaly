# Phase 2.1 — プラグイン基盤の整備

> 状態: **完了 (2026-05-03)**
> 種別: 基盤整備
> サイズ: **S**
> 依存: なし（[phase2.2](phase2.2-mei23-non-plugin.md) と並列で着手可）
> 後続: [phase3.1](phase3.1-plugin-oembed.md)、[phase3.2](phase3.2-plugin-dom.md)、[phase6.1](phase6.1-plugin-twitter.md)

## 目的・背景

mei23 fork からプラグインを順次取り込むにあたり、**プラグイン側が必要とする横断的な基盤** を先に固める。具体的には:

- **`getJson(url, referer?)` ヘルパ**: oEmbed エンドポイントを直接叩くプラグイン（youtube / spotify）と、外部 JSON API を叩くプラグイン（komiflo）が共通で使う
- **プラグインの `name` 定数**: `allowedPlugins` オプション（[phase2.2](phase2.2-mei23-non-plugin.md)）と、Fastify のキャッシュキー設計（[phase4.1](phase4.1-fastify-in-memory-cache.md)）で必要
- **プラグインによる UA オーバーライド**: 特定サイト（産経新聞、AbemaTV 等）でブラウザ UA でないとレスポンスが変わる事象に、コアにホストリストを抱えず**プラグイン単位**で対処する API
- **短縮 URL 解決**: Fastify モード（`followRedirects: false`）でも公式短縮 URL（`youtu.be`, `amzn.to`, `w.wiki` 等）が適切なプラグインに到達するための dispatcher 改修

これらを **プラグイン本体の移植（phase3.x）に先立って** 整備しておくことで、後続フェーズが基盤の検討から解放されて並列開発しやすくなる。

---

## 現状分析

### 既存プラグインインターフェース

[src/iplugin.ts](src/iplugin.ts) の `SummalyPlugin`:

```ts
interface SummalyPlugin {
    test: (url: URL) => boolean;
    summarize: (url: URL, opts?: GeneralScrapingOptions) => Promise<Summary | null>;
}
```

- `name` 定数の export がない（`allowedPlugins` のキーとして使えない）
- 既存組み込みは [src/plugins/index.ts](src/plugins/index.ts) に配列として登録されているが、ファイル名と紐付ける名前情報がない

### 既存 HTTP 層

[src/utils/got.ts](src/utils/got.ts):

- `scpaping(url, opts)` の `opts` は `lang` / `userAgent` / `responseTimeout` / `operationTimeout` / `contentLengthLimit` / `contentLengthRequired` を受ける
- ただし **プラグイン側から `userAgent` を上書きする経路がない**（呼出側のトップレベル `SummalyOptions.userAgent` のみ）
- JSON 取得用のヘルパが存在しない（プラグイン側で `got(...).json()` を直接呼ぶ必要がある）

### 既存 dispatcher（短縮 URL 関連）

[src/index.ts](src/index.ts):

- `opts.followRedirects` が `true` のときだけ HEAD で `actualUrl` を解決（[src/index.ts:86-117](src/index.ts#L86-L117) 付近）
- Fastify モードは `followRedirects: false` を強制（SSRF 緩和、サーバ間チェイン攻撃の回避）
- このため `youtu.be/<id>` などの公式短縮 URL は plugin の `test()` には短縮ホストのまま渡り、本来動くべき youtube プラグインが起動しない

---

## 設計方針

### `getJson` ヘルパ

[src/utils/got.ts](src/utils/got.ts) に追加:

```ts
export async function getJson(
    url: string,
    referer?: string
): Promise<unknown> {
    const res = await getResponse({
        url,
        method: 'GET',
        headers: {
            'accept': 'application/json, */*',
            ...(referer ? { referer } : {}),
        },
        // typeFilter は無し（任意の JSON API を叩く想定）
    });
    return JSON.parse(res.body as string);
}
```

- 既存 `getResponse` を再利用（`contentLengthLimit` / プライベート IP ガード等は自動で効く）
- `referer` は komiflo のように API 呼出時にリファラを要求するサイト用（mei23 互換）
- 戻り値は `unknown`（プラグイン側で型 assert または zod 等で検証）

### プラグインの `name` 定数

[src/iplugin.ts](src/iplugin.ts) を拡張:

```ts
interface SummalyPlugin {
    /** プラグイン名。allowedPlugins 等のキーとして使う。ファイル名（拡張子なし）と一致させる */
    name?: string;
    test: (url: URL) => boolean;
    summarize: (url: URL, opts?: GeneralScrapingOptions) => Promise<Summary | null>;
}
```

- `name` は **optional**（既存組み込みには順次付与、外部プラグインへの破壊的変更を避ける）
- 各組み込みプラグイン ([amazon.ts](src/plugins/amazon.ts) など) に `export const name = 'amazon';` を追加
- CI で「ファイル名 === `name` 定数」一致をチェックするテストを追加

### UA オーバーライド機構

[src/utils/got.ts](src/utils/got.ts) の `scpaping(url, opts)` の `opts` に既に `userAgent` がある場合はそれを使う、なければ既定 UA。**プラグイン側がここを使えるよう、`SummalyPlugin.summarize` に渡される `GeneralScrapingOptions` から `userAgent` を経由して `scpaping` まで通す**。

ブラウザ UA 定数は [src/utils/user-agents.ts](src/utils/user-agents.ts) を新設:

```ts
/** Chrome 系のブラウザ UA。バージョン番号は明示し、定期的に陳腐化チェックする */
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
```

プラグイン側の利用例:

```ts
// src/plugins/sankei.ts (将来追加する仮想例)
import { BROWSER_UA } from '../utils/user-agents';
import { scpaping } from '../utils/got';

export const name = 'sankei';
export function test(url: URL) { return url.host === 'www.sankei.com'; }
export async function summarize(url: URL, opts) {
    const res = await scpaping(url.href, { ...opts, userAgent: BROWSER_UA });
    // ...
}
```

mei23 の `NOT_BOT_UA = ['www.sankei.com', 'abema.tv']` のホストリスト方式は **不採用**。コアにホストリストを抱える負債を避け、サイト固有の対応はプラグインで個別対応する。

### 短縮 URL 解決（dispatcher 改修）

[src/utils/short-urls.ts](src/utils/short-urls.ts) を新設:

```ts
/** 公式の短縮 URL ホスト。Fastify モード（followRedirects: false）でも HEAD 解決する許可リスト */
export const KNOWN_SHORT_HOSTS = new Set<string>([
    'youtu.be',
    'amzn.to',
    'amzn.asia',
    'a.co',
    'w.wiki',
    'spotify.link',
    // 't.co' は元 tweet ID が取れないため意味薄いので入れない
]);
```

[src/index.ts](src/index.ts) の dispatcher 改修:

- 現状: `opts.followRedirects` が `true` のときだけ HEAD で `actualUrl` を解決
- 変更後: `followRedirects: false` でもホストが `KNOWN_SHORT_HOSTS` ならば HEAD だけ実行して `actualUrl` を更新。残りはそのまま
- プラグインマッチングは解決後の URL で行う（既存ロジックのまま）

これにより Fastify サーバ運用でも、サービス公式短縮 URL に限り適切なプラグインにディスパッチされる。

---

## 実装ステップ（チェックリスト）

各ステップで `pnpm eslint && pnpm test` を通す。

- [x] **Step 1 — `getJson` ヘルパ追加**
  - [src/utils/got.ts](src/utils/got.ts) に `getJson(url, referer?, opts?)` を追加
  - typeFilter: `application/json` 系を強制（コードレビュー指摘により追加）
  - User-Agent: `DEFAULT_BOT_UA` を既定値、`opts.userAgent` で上書き可能（コードレビュー指摘により追加）
  - 単体テスト: JSON 取得・referer ヘッダ・referer なしのケース・不正 JSON 例外
- [x] **Step 2 — プラグイン `name` 定数導入**
  - [src/iplugin.ts](src/iplugin.ts) に `name?: string` を optional 追加
  - 全組み込みプラグイン (amazon / bluesky / wikipedia / branchio-deeplinks) に `export const name`
  - CI テスト: `readdirSync` で `src/plugins/*.ts` を列挙、`builtinPlugins[i].name` と突合
- [x] **Step 3 — UA オーバーライド機構**
  - [src/utils/user-agents.ts](src/utils/user-agents.ts) を新設、`BROWSER_UA` 定数（Chrome 130, 2026-05-03 更新）
  - `scpaping(url, opts)` 経路は元から `opts.userAgent` 尊重済みのため変更なし
  - 単体テスト: `summaly(host, { userAgent: BROWSER_UA })` で User-Agent ヘッダがモックサーバに到達することを確認
- [x] **Step 4 — 短縮 URL リスト**
  - [src/utils/short-urls.ts](src/utils/short-urls.ts) を新設、`KNOWN_SHORT_HOSTS` を export
- [x] **Step 5 — dispatcher 改修**
  - [src/index.ts](src/index.ts) の HEAD 解決ブロックを `opts.followRedirects || KNOWN_SHORT_HOSTS.has(initialHost)` で発火
  - HEAD リクエストに `maxRedirects: 5` を追加（SSRF チェイン緩和、コードレビュー指摘対応）
  - テスト: 定数のメンバーシップテスト追加（`youtu.be` 等を含み `bit.ly` `t.co` を含まないこと）

---

## 完了条件 (Definition of Done)

- `getJson(url, referer?)` がプラグインから利用可能で、単体テストが通る
- 全組み込みプラグインに `name` 定数が付与され、ファイル名との一致が CI で検証される
- `BROWSER_UA` 定数が export され、`scpaping` の `userAgent` オプション経由でプラグインが UA をオーバーライドできることがテストで担保されている
- `KNOWN_SHORT_HOSTS` の URL は Fastify モードでも HEAD 解決され、適切なプラグインにディスパッチされる
- 既存ユーザーの呼び出し（`summaly(url)` / `summaly(url, opts)`）が破壊的変更を受けていない
- `pnpm build && pnpm eslint && pnpm test` が通る

---

## リスク・注意点

1. **`getJson` の SSRF**: 既存 `getResponse` のプライベート IP ガードを再利用するので新規リスクは無いが、テストでガードが効くことを必ず確認する。
2. **`name` 定数のドリフト**: ファイル名と `name` がずれると `allowedPlugins` が正しく動かない。CI 一致テストで防止。
3. **短縮 URL リストの過剰拡大**: 一般的な短縮 URL（bit.ly, t.co 等）まで足すと SSRF 拡大に繋がる。**`KNOWN_SHORT_HOSTS` は「サービス公式の」短縮ホストに限定**する（Fediverse 上で実際に多数飛び交うもの限定）。
4. **`BROWSER_UA` の陳腐化**: Chrome のメジャーバージョンが上がるたびに値を更新するか検討。**まず固定値で運用**し、サイト側がより新しいバージョンを要求し始めたら更新する反応的方針（年1回程度の更新で十分）。
