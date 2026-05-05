# Phase 6.1 — twitter (X) プラグイン取り込み

> 状態: **完了 (2026-05-05)**
> 種別: 機能拡張 / プラグイン移植
> サイズ: **S**
> 依存: [phase2.1](phase2.1-plugin-infrastructure.md)、[phase2.2](phase2.2-mei23-non-plugin.md)（`medias[]`）、[phase3.1](phase3.1-plugin-oembed.md)、[phase3.2](phase3.2-plugin-dom.md)（プラグインパターン確立後）

## 目的・背景

mei23 fork の twitter プラグイン ([worktrees/mei-summaly/src/plugins/twitter.ts](worktrees/mei-summaly/src/plugins/twitter.ts)) は、`cdn.syndication.twimg.com/tweet-result` を直接叩いて高速にツイート情報を取得する実装を持っている。

ただし以下の理由で **本プラグインは保留扱い**:

1. **独自 token 算出ロジックが Twitter 側仕様変更で頻繁に壊れる**
   - `token` は `id / 1e15 * π` を 36 進数化して 0 と `.` を除去、という独自ロジック
   - これは Twitter 側の認証トークンを再現する黒魔術で、いつでも壊れうる
2. **X (Twitter) の利用規約上もグレー**
   - `cdn.syndication.twimg.com` は公開 API ではなく、内部利用される CDN エンドポイントを scrape している
   - 規約違反として API 提供側からブロックされる可能性
3. **メンテナンス負担**
   - 仕様変更のたびに token ロジックを修正する必要があり、メンテナーが「壊れたら誰が直すか」の責務を負う

→ **採用するなら別 PR で運用負荷を切り分ける**。本プロジェクトのメンテナーが「採否」「壊れたときの修正主体」を判断したタイミングで本フェーズを着手する。

---

## 現状分析

### 現在の twitter / X URL の扱い

upstream には twitter / X 専用プラグインがないため、`(twitter|x).com/<user>/status/<id>` URL は [src/general.ts](src/general.ts) → `parseGeneral()` で処理される。X の Web ページは現状、JS レンダリング前提で OG / Twitter Card がほぼ取れない構造になっており、**summaly の結果はほぼ空**になる。

### mei23 の twitter プラグイン

[worktrees/mei-summaly/src/plugins/twitter.ts](worktrees/mei-summaly/src/plugins/twitter.ts):

- マッチ: `(twitter|x).com/<user>/status/<id>` のみ
- `cdn.syndication.twimg.com/tweet-result?id=<id>&token=<token>&lang=en` を叩く
- `token` は `id / 1e15 * π` を 36 進数化して 0 と `.` を除去（独自ロジック）
- description = tweet text（先頭の t.co 短縮メディア URL は `entities.media[0].indices[0]` で切り落とし）
- thumbnail = video.poster → photos[0].url → user.profile_image（`_normal.` を除去してオリジナルサイズに）の優先順位
- title = `${user.name} on X` 固定パターン
- sitename = `'X'` 固定
- sensitive = `j.possibly_sensitive`
- 戻り値に独自フィールド `medias: string[]` を含む（複数画像対応）
- player は `{ url: null, width: null, height: null }` で player なし扱い。`allow` がない（型互換性なし）

---

## 採用時の設計方針（参考）

採用判断が下りた場合の実装方針を記録しておく。

### `Player.allow` の補完

mei23 では `allow` がないが、upstream の `Player` 型では必須。プラグインは player なし（`url: null`）で返すため `allow: []` で良い。

### `Summary.medias[]` の活用

[phase2.2](phase2.2-mei23-non-plugin.md) で導入される `medias?: string[]` を実際に使う最初のプラグイン。複数画像のツイートで全画像を返せる。

### token 算出ロジック

mei23 のロジックをそのまま移植 + コードコメントに「外部仕様変更で壊れる」旨を**強調**して記録する。

```ts
function calcToken(id: string): string {
    // X (Twitter) の cdn.syndication.twimg.com 用トークン算出。
    // 仕様変更で壊れる可能性が高いため、定期的にメンテナンスが必要。
    // 参考: mei23 fork
    const n = (Number(id) / 1e15) * Math.PI;
    return n.toString(36).replace(/0+|\.+/g, '');
}
```

### UA オーバーライド

`cdn.syndication.twimg.com` がブラウザ UA を要求する可能性があるため、[phase2.1](phase2.1-plugin-infrastructure.md) の `BROWSER_UA` を渡せるようにしておく。

---

## 実装ステップ（採用時のチェックリスト）

着手判断が下りた場合の手順:

- [x] **Step 0 — 採用判断** — オーナー承認 (2026-05-05、「壊れたら都度メンテのつもりで取り込みたい」)
- [x] **Step 1 — twitter プラグイン** — `name = 'twitter'`、mei23 token 算出 + cdn.syndication 経由
- [x] **Step 2 — テスト** — `buildSummary` フィクスチャ 8 件（test/match、calcToken、テキスト/複数画像/動画/sensitive/不正 JSON/user.name 欠如）
- [x] **Step 3 — README / Plugins.md / CHANGELOG 更新** — メンテナンス警告強調
- [x] **Step 4 — デフォルト有効、`allowedPlugins` 除外で disable 可能と CHANGELOG / README で案内**

## 実装結果メモ

- **player iframe を追加（Plan 当初の方針からの変更）**: mei23 オリジナルは `player.url = null` だったが、オーナー要望で「player 展開できたほうが便利」のため `https://platform.twitter.com/embed/Tweet.html?id=<id>` を返す形に拡張。X 公式 widget の Tweet 埋め込み iframe で、`width: 550 / height: 600` 固定（CDN が寸法を返さないため）
- **`buildSummary(id, json)` を export**: ネットワーク I/O 抜きにフィクスチャテストできる構造（spotify / youtube プラグインと同じパターン）
- **Misskey (Akamai 等とは違って) X 公式 CDN は `SummalyBot` UA で通る**: dev サーバで `https://twitter.com/jack/status/20` を取得し `description: "just setting up my twttr"` まで取れることを実機確認
- **「壊れたら都度メンテ」の方針**: README / Plugins.md / CHANGELOG / プラグインソースの全レイヤーで「X 仕様変更で壊れる」「除外したいなら `allowedPlugins`」を明記。プラグインのコメントでは「mei23 fork が壊れたら同 fork の更新も参照する」を含めて将来の修正者にヒントを残した

---

## 完了条件 (採用時の DoD)

- twitter プラグインが [src/plugins/index.ts](src/plugins/index.ts) に登録される
- `medias[]` が複数画像で正しく返る
- フィクスチャベースのテストが付いている
- README にメンテナンスリスクが明記されている
- `pnpm build && pnpm eslint && pnpm test` が通る

---

## リスク・注意点

1. **仕様変更で壊れる**: 採用後の運用負担を理解した上での判断が必要
2. **X の規約**: 規約違反として cdn.syndication.twimg.com からブロックされる可能性
3. **代替手段**: oEmbed エンドポイント（`publish.twitter.com/oembed`）も存在するが、現在は **JSON レスポンスが空** に近い形に変更されているため使えない（過去の summaly でも対応していない）
4. **デフォルト無効推奨**: メンテナンスリスクを考慮し、**`allowedPlugins` で明示的に有効化させる方針** を README で推奨

---

## 状態の更新

採用判断が下りたら、本ファイル冒頭の状態を「未着手」に変更し、TODO.md のバックログにも上げる。それまでは保留扱いで参照される位置に置く。
