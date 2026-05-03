# Phase 3.1 — oEmbed 系プラグインの取り込み（youtube / spotify）

> 状態: **完了 (2026-05-03)**
> 種別: 機能拡張 / プラグイン移植
> サイズ: **S**
> 依存: [phase2.1](phase2.1-plugin-infrastructure.md)（`getJson`、UA オーバーライド機構）、[phase2.2](phase2.2-mei23-non-plugin.md)（`sanitize-url`、`Player.allow` 互換）
> 並列可: [phase3.2](phase3.2-plugin-dom.md)

## 目的・背景

mei23 fork から **oEmbed エンドポイントを直接叩く高速プラグイン** を取り込む。具体的には:

- `youtube`: `youtube.com/oembed` を叩いて player URL とメタデータを 1 リクエストで取得
- `spotify`: `open.spotify.com/oembed` を叩いて同上

これらは `general()` 経由で HTML を取得するパスより **1〜数リクエスト少なく** 高速化が見込める。Misskey の Note プレビューで頻出するためユーザー体験への影響が大きい。

mei23 は `Player.allow` フィールドを返していないため、upstream に取り込む際は **適切な safelist を補う**必要がある。

---

## 現状分析

### upstream で youtube / spotify が当たる経路

- [src/plugins/branchio-deeplinks.ts](src/plugins/branchio-deeplinks.ts) が `spotify.link` をハンドルし、`general()` に委譲
- `youtu.be` / `*.youtube.com` / `open.spotify.com` は専用プラグインがないため [src/general.ts](src/general.ts) → `getOEmbedPlayer()` 経由で処理。HTML を取得→ `<link rel="alternate" type="application/json+oembed">` を探す→ oEmbed エンドポイントを叩く、と **2 リクエスト**かかる

### mei23 の youtube プラグイン

[worktrees/mei-summaly/src/plugins/youtube.ts](worktrees/mei-summaly/src/plugins/youtube.ts):

- マッチ: `*.youtube.com/{watch,v,playlist,shorts}`、`youtu.be`
- `https://www.youtube.com/oembed?url=<url>` を `getJson` で取得（1 リクエスト）
- `j.html` 内 iframe の `src` を player URL に
- `j.type !== 'video'` で throw
- icon は `https://www.youtube.com/s/desktop/014dbbed/img/favicon_32x32.png` 固定（YouTube 側のアセット更新で陳腐化）
- player に `allow` がない → 移植時に補完必要

### mei23 の spotify プラグイン

[worktrees/mei-summaly/src/plugins/spotify.ts](worktrees/mei-summaly/src/plugins/spotify.ts):

- マッチ: `open.spotify.com`
- `https://open.spotify.com/oembed?url=<url>` を `getJson` で取得 → `j.html` を cheerio ロード → `iframe[src]` を抽出
- `src` が `https?://` でなければ throw
- icon/sitename/thumbnail は oEmbed のフィールドから採用
- player に `allow` がない → 移植時に補完必要

---

## 設計方針

### 共通: `Player.allow` の補完

mei23 では `allow: string[]` を返していない。upstream の `Player` 型では必須なので、**youtube/spotify ともに README の YouTube 例と同じ safelist** を採用:

```ts
const PLAYER_ALLOW_OEMBED = [
    'autoplay',
    'clipboard-write',
    'encrypted-media',
    'picture-in-picture',
    'web-share',
    'fullscreen',
];
```

このセットは [src/general.ts](src/general.ts) 内 `getOEmbedPlayer()` の `safeList` とも整合する。

### 共通: oEmbed iframe の検証

mei23 は iframe の `src` が `https?://` であることだけチェックしている。upstream の `getOEmbedPlayer` はもっと厳格（`https:` のみ、`allow` が `safeList` 内のみ等）。

**移植時は upstream の検証ロジックを参考に、`https:` のみ許可・`allow` は固定 safelist** を採用する。

### 共通: `general()` との衝突回避

プラグインが先にマッチしたら **`general()` を呼ばずに完全に置き換える**。general 側の `getOEmbedPlayer()` 経路と二重実行しない。プラグインの `summarize()` 内で oEmbed 直叩きで完結させる。

### youtube プラグイン固有

- マッチ: `(www|m).youtube.com/{watch,v,playlist,shorts}`、`youtu.be/<id>`
- 短縮 URL `youtu.be` は `youtube.com/oembed?url=` にそのまま渡せる（YouTube 側がリダイレクト処理してくれる）
- icon URL は **固定値ではなく oEmbed レスポンスからの値があれば優先**。なければ `https://www.youtube.com/favicon.ico`（mei23 のアセットハッシュ付き URL は陳腐化するため使わない）
- `sitename: 'YouTube'` 固定

### spotify プラグイン固有

- マッチ: `open.spotify.com`
- 既存 [src/plugins/branchio-deeplinks.ts](src/plugins/branchio-deeplinks.ts) は `spotify.link` を扱い `general()` に委譲する。**`open.spotify.com` で先にマッチしたら spotify プラグインが処理**するため、branchio 経由ルートとも衝突しない
- icon/sitename/thumbnail は oEmbed のフィールドを採用

### `Summary` 型との互換

[phase2.2](phase2.2-mei23-non-plugin.md) で導入される `medias?: string[]` 型は本フェーズでは使わない（youtube / spotify は単一画像）。

---

## 実装ステップ（チェックリスト）

各ステップで `pnpm eslint && pnpm test` を通す。

- [x] **Step 1 — youtube プラグイン**
  - [src/plugins/youtube.ts](src/plugins/youtube.ts) を新設
    - `export const name = 'youtube';`
    - `test(url)`: `(www|m).youtube.com` のパス制約、または `youtu.be/<id>`
    - `summarize(url, opts)`: `getJson('https://www.youtube.com/oembed?url=' + encodeURIComponent(url.href))` を呼び、`j.type === 'video'` を確認、iframe 抽出後 `Player.allow = PLAYER_ALLOW_OEMBED`
    - icon は oEmbed の `thumbnail_url` ホストの favicon（または `https://www.youtube.com/favicon.ico` フォールバック）
  - [src/plugins/index.ts](src/plugins/index.ts) に登録
  - oEmbed レスポンスのフィクスチャを `test/htmls/` 隣に作って統合テスト（モックサーバ）
  - 短縮 URL `youtu.be` でも動作することをテスト
- [x] **Step 2 — spotify プラグイン**
  - [src/plugins/spotify.ts](src/plugins/spotify.ts) を新設
    - `export const name = 'spotify';`
    - `test(url)`: `open.spotify.com` のみ
    - `summarize(url, opts)`: `getJson('https://open.spotify.com/oembed?url=' + encodeURIComponent(url.href))` を呼び、iframe 抽出後 `Player.allow = PLAYER_ALLOW_OEMBED`
    - icon/sitename/thumbnail は oEmbed フィールドから採用
  - [src/plugins/index.ts](src/plugins/index.ts) に登録（branchio-deeplinks の前後関係に注意）
  - 既存 [src/plugins/branchio-deeplinks.ts](src/plugins/branchio-deeplinks.ts) の `spotify.link` ルートと衝突しないことをテストで確認
  - oEmbed レスポンスのフィクスチャを作って統合テスト
- [x] **Step 3 — `Player.allow` 共通定数**
  - [src/utils/player-allow.ts](src/utils/player-allow.ts) を新設し `PLAYER_ALLOW_OEMBED` を export
  - youtube / spotify から共有
  - 将来 [phase3.2](phase3.2-plugin-dom.md) や [phase6.1](phase6.1-plugin-twitter.md) からも参照可能にする
- [x] **Step 4 — README / CHANGELOG 更新**
  - 「対応形式（組み込みプラグイン）」表に youtube / spotify の行を追加
  - mei23 から取り込んだ高速化パスである旨を記載

---

## 完了条件 (Definition of Done)

- youtube / spotify プラグインが [src/plugins/index.ts](src/plugins/index.ts) に登録され、`getJson` 経由で oEmbed を叩くパスが動作する
- 各プラグインに `name` 定数が付与されている（[phase2.1](phase2.1-plugin-infrastructure.md) の規約に準拠）
- `Player.allow` が両者で `PLAYER_ALLOW_OEMBED` に統一されている
- フィクスチャベースのテストが各プラグインに付いている
- 短縮 URL `youtu.be/<id>` で youtube プラグインが起動する（[phase2.1](phase2.1-plugin-infrastructure.md) の `KNOWN_SHORT_HOSTS` + dispatcher 改修と組み合わせて Fastify モードでも動く）
- `pnpm build && pnpm eslint && pnpm test` が通る

---

## リスク・注意点

1. **icon URL の陳腐化**: YouTube / Spotify とも oEmbed レスポンスの `thumbnail_url` を参考にして icon を組み立てる。固定値（mei23 の `014dbbed` のようなアセットハッシュ）は使わない
2. **branchio との衝突**: `spotify.link` は branchio-deeplinks 側で `$web_only=true` を付けて `general()` に委譲する。`open.spotify.com` 着地後は spotify プラグインが拾う想定。プラグインの登録順を [src/plugins/index.ts](src/plugins/index.ts) で確認
3. **iframe 検証**: mei23 は `https?://` でチェックしているが、本実装では **`https:` のみ許可**（HTTP iframe は埋め込み側でブロックされることが多いため、フィルタしても実害なし）
4. **oEmbed エンドポイントのレート制限**: 高頻度アクセス時は 429 を返すことがある。`StatusError` を throw して呼出側に委ねる（既存挙動と整合）
