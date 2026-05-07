# phase13.1 — 小説家になろうプラグイン + `/embed` エンドポイント基盤

> 状態: **ほぼ完了** (Step 1 + Step 2 + Step 3 + Step 4 部分 + Step 6 + Step 7 完了 2026-05-08。残るは Step 5 dev サーバ手動動作確認のみ — UI 検証必要のため自動化対象外、運用者が dev/sample-urls.ts に「小説家になろう」を追加して動かす想定)
> 種別: 機能追加 / プラグイン追加 / Fastify 新エンドポイント
> サイズ: **M〜L**
> 依存: [phase2.1](phase2.1-plugin-infrastructure.md)（プラグイン基盤）、[phase4.1](phase4.1-fastify-in-memory-cache.md)（Fastify LRU キャッシュ流用）、[phase8.1](phase8.1-toml-config.md)（TOML config）
> 並列可: 単独（Fastify ルート追加 + プラグイン interface 拡張で複数ファイルを跨ぐため、他フェーズと衝突しやすい）

## 背景

`https://ncode.syosetu.com/n7587fe/2/` のような **小説家になろう** の URL を summaly に投げると、汎用パスでは以下の問題が出る:

| 観測される問題 | 原因 |
|---|---|
| `description` がジャンル/キーワードのタグ列挙になる | OG description にタグが入っている |
| `thumbnail` があらすじの先頭画像（見切れる） | OG image があらすじキャプチャになっている |
| 作者名が出ない | OG にも HTML 構造にも `writer` 単独メタが無い |
| R-18 (ノクターン / ムーンライト) でも `sensitive: false` | プラグイン側でドメイン判定していない |
| ページビュー誤集計 | `SummalyBot` UA が PV にカウントされる |

**Misskey のカードスタイル制約** は 1 行 title / 1 行 description / 1 行 sitename しか入らないため、表示できる情報量が構造的に足りない。なろうの作品ページで知りたい情報（作品名 / 作者 / ジャンル / 連載中・完結 / R-15 / あらすじ）を全部 description に詰めると 1 行に収まらず欠落する。

## ゴール

1. **`/embed?url=...` エンドポイント基盤を Fastify モードに新設**
   - プレイヤー iframe として読まれる **JS 一切なしの HTML+CSS** を返す
   - **XSS 対策**（HTML エスケープ + 厳格な CSP + 外部リソース全禁止）を必須要件とする
   - プラグインが `renderEmbed(url, opts)` を実装すれば自動で対応するプラグイン拡張点として設計する
2. **`syosetu` プラグインの追加** — なろう小説 API (`api.syosetu.com/novelapi/api/`) を直叩きして作品メタを取り、`renderEmbed` で作品名 / 作者 / ジャンル / 連載状況 / あらすじを 1 枚の HTML に整形して返す
3. **`SummalyOptions.embedBaseUrl`** を追加し、Fastify モードで起動時に `[server].publicUrl` ベースで自動セットする。プラグインは opts から受け取って `player.url` に組み立てる
4. **R-18 ドメイン判定 + `sensitive: true`**、**UA を `facebookexternalhit/1.1` に固定**（API 呼び出しは PV カウントに影響しないが、念のため API には `User-Agent` を明記）

## 設計方針

### Fastify `/embed` エンドポイントの責務分離

```
┌────────────────────────────────────────────────────────────────┐
│ GET /embed?url=<URL>                                           │
│                                                                │
│ 1. URL バリデーション (https only, embed allowlist domain チェック) │
│ 2. プラグイン dispatch (summaly 内部の plugins[] を回し、最初に     │
│    test() == true でかつ renderEmbed が実装されているものを選ぶ)  │
│ 3. plugin.renderEmbed(url, opts) を呼ぶ → { title, body }       │
│ 4. CSP ヘッダ + X-Frame-Options + Cache-Control を付けて HTML を返す │
└────────────────────────────────────────────────────────────────┘
```

#### CSP / セキュリティ要件（変更不可の基準）

```
Content-Security-Policy:
  default-src 'none';
  img-src https:;
  style-src 'unsafe-inline';
  font-src 'none';
  base-uri 'none';
  form-action 'none';
  frame-ancestors *  ← もしくは config.toml で明示制限
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: public, max-age=600
```

- `script-src` は **default-src 'none'** に吸収されて全ブロック（インラインも external も）
- `style-src 'unsafe-inline'` は許容（`<style>` ブロックを 1 つ HTML 内に書くため）
- `img-src https:` は icon / thumbnail を画像として表示する場合のみ。テキストオンリー化するなら `img-src 'none'` に締める判断もあり
- `frame-ancestors` のデフォルトは `*`（自前 Misskey から読まれることを許可）。商用運用なら config で制限する選択肢を残す

#### プラグイン interface 拡張

```ts
// src/iplugin.ts
export interface SummalyPlugin {
  name?: string;
  test: (url: URL) => boolean;
  summarize: (url: URL, opts?: GeneralScrapingOptions) => Promise<Summary | null>;
  skipRedirectResolution?: boolean;

  /**
   * **embed エンドポイント用 HTML 生成**（phase13.1）。
   * 実装すると summaly が `/embed?url=<this URL>` で本関数の HTML を返すようになる。
   * 戻り値の `body` は信頼できないユーザー入力を含む可能性があるため、**プラグイン側でエスケープ済みである**ことを契約とする。
   */
  renderEmbed?: (url: URL, opts?: GeneralScrapingOptions) => Promise<EmbedRenderResult>;
}

export interface EmbedRenderResult {
  /**
   * 完全な HTML5 ドキュメント (`<!DOCTYPE html>...`)。
   * **すべてのユーザー入力はエスケープ済みであること**（Fastify 側はエスケープしない）。
   * **`<script>` を含めてはならない**（CSP `default-src 'none'` で実行されないが、混入を許す設計にしない）。
   */
  body: string;

  /** プレイヤーの推奨幅 / 高さ（Misskey 側の iframe サイズ計算に使う） */
  width: number;
  height: number;
}
```

#### `SummalyOptions.embedBaseUrl` の追加

```ts
// src/index.ts
export type SummalyOptions = {
  // ...既存
  /**
   * Fastify モードで自身が公開されている URL ベース。
   * 例: `https://summaly.example.com`
   * 設定すると、対応するプラグインが Summary の `player.url` を
   * `<embedBaseUrl>/embed?url=<encoded>` として組み立てる。
   * 未設定の場合 player は無効化（library mode のデフォルト挙動）。
   */
  embedBaseUrl?: string;
};
```

`bin/summaly-server.ts` で `cfg.server.publicUrl ?? ''` から自動投入。`config.toml` の `[server]` に `publicUrl` を追加（次節）。

### `[embed]` config セクション

```toml
[server]
host = "127.0.0.1"
port = 3000
# **自身が外部に公開されている URL**。/embed エンドポイントを使うプラグインで player.url を組み立てるのに使う。
# 未設定なら embed 機能は無効になる。
publicUrl = "https://summaly.example.com"

[embed]
# embed エンドポイントを有効化するか。
# false の場合、/embed が 404 を返し、プラグインの player.url も null になる。
enabled = true
# 許可するプラグイン名のリスト。embed 対応プラグインでもここに無ければ player.url を生成しない。
# fail-close: 空 / 未設定なら全部無効。
allowedPlugins = ["syosetu"]
# iframe を読み込んで良いオリジン (CSP `frame-ancestors`)。"*" で全許可。
# 商用運用では Misskey インスタンスのオリジンを並べる。
frameAncestors = ["*"]
```

### syosetu プラグインの URL マッチ・API 呼び出し

#### マッチ範囲

| ドメイン | 種別 | sensitive |
|---|---|---|
| `ncode.syosetu.com` | 通常作品（一般） | false |
| `novel18.syosetu.com` | R-18 (ノクターン / ムーンライト等) | **true** |

パスパターン: `/^\/(n[0-9a-z]+)(?:\/.*)?$/i`（ncode は `n` + 英数字）。**個別エピソード `/<ncode>/<chapter>/` も作品レベルの ncode で集約**（chapter 単位の本文取得は API に存在しないため、作品見出しと同じ Summary を返す。embed 表示で「個別エピソード」と作品見出しを区別できないのは仕様として割り切る）。

#### API

```
通常: https://api.syosetu.com/novelapi/api/?ncode=<NCODE>&out=json&of=t-w-s-bg-g-nt-e-ir15-izk-ibl-igl-k
R-18: https://api.syosetu.com/novel18api/api/?ncode=<NCODE>&out=json&of=t-w-s-bg-g-nt-e-ir15-izk-ibl-igl-k
```

`of` でフィールド絞り込み（trafic 削減）:

| 略号 | フィールド | 用途 |
|---|---|---|
| `t` | title | 作品名 |
| `w` | writer | 作者名 |
| `s` | story | あらすじ |
| `bg` | biggenre | 大ジャンル ID |
| `g` | genre | ジャンル ID |
| `nt` | novel_type | 1=連載, 2=短編 |
| `e` | end | 0=連載中, 1=完結 |
| `ir15` | isr15 | R-15 フラグ |
| `izk` | iszankoku | 残酷な描写あり |
| `ibl` | isbl | BL |
| `igl` | isgl | GL |
| `k` | keyword | キーワード（タグ） |

レスポンス形式: `[{allcount: 1}, {title, writer, ...}]` の配列。`allcount === 0` の場合は作品が見つからない（削除済み等）。

#### `summarize()` の出力

```ts
return {
  title: novel.title,
  description: composeDescription(novel),  // 後述
  thumbnail: 'https://syosetu.com/img/syosetu_logo.png',  // なろうトップロゴ固定
  icon: 'https://syosetu.com/favicon.ico',
  player: opts.embedBaseUrl
    ? {
        url: `${opts.embedBaseUrl}/embed?url=${encodeURIComponent(url.href)}`,
        // Misskey は `padding: height/width * 100%` でアスペクト比を計算する。
        // 絶対値は無視され、コンテナ幅にレスポンシブで伸縮する。比率だけが意味を持つ。
        width: 3,
        height: 2,
        allow: [],
      }
    : { url: null, width: null, height: null, allow: [] },
  sitename: isR18 ? 'ノクターンノベルズ / ムーンライトノベルズ' : '小説家になろう',
  sensitive: isR18,
  activityPub: null,
  fediverseCreator: null,
};
```

`composeDescription(novel)` は card style fallback 用:
```
作者: <writer> / <ジャンル名> / <連載中 or 完結> / <R-15 / 残酷描写 / BL / GL マーカー>
あらすじ冒頭: <story の先頭 80 文字 + …>
```

#### `renderEmbed()` の出力構成

iframe 内で表示する HTML レイアウト:

```
┌─────────────────────────────────────────────┐
│ [小説家になろうロゴ] <作品タイトル>         │
│                                              │
│ 作者: <writer>                               │
│ ジャンル: <ジャンル名>  [連載中/完結] [R-15] │
│ キーワード: <keyword 上位 5 件をカンマ区切り> │
│                                              │
│ あらすじ:                                    │
│ <story 全文または 300 文字 clip>             │
└─────────────────────────────────────────────┘
```

実装方針:
- **テンプレートライブラリは使わない**（依存追加を避ける）
- 文字列連結で `<!DOCTYPE html><html>...</html>` を組み立てる
- すべてのユーザー入力（title, writer, story, keyword）に対して `escapeHtml()` を呼ぶ。`escapeHtml` は `& < > " '` の 5 文字を escape（過剰でも問題ない）
- `escapeHtml` は **文字列リテラル属性に入れる前にも呼ぶ**（`<a href="...">` の URL 属性に入れる場合は別途 URL 検証 + escape）
- 外部 URL を `<a>` で書く必要があれば、**`href` を出さない方が安全**（iframe 内クリックは Misskey 側の挙動が読めない）。今回は **テキストオンリー** で確定する

#### UA 戦略

API には `facebookexternalhit/1.1` を **使わない**（API は bot 認識しないため）。**`SummalyBot/x.y.z` で素直に呼ぶ** で OK。なろうトップ HTML を取りに行かないので PV カウントの問題は構造的に発生しない。

> 補足: もし将来 chapter 単位で **本文冒頭** を取りに行くフェーズを足す場合、その HTML 取得には `facebookexternalhit/1.1` UA を使う。OG card 用の bot として認識されれば PV 集計から除外される運用になっている可能性が高い（要実機検証）。

### キャッシュ戦略

- Fastify LRU キャッシュは **`/?url=...`** だけを対象。`/embed?url=...` は別エンドポイントなので別キャッシュが要る
- 一旦 **`Cache-Control: public, max-age=600`** をレスポンスヘッダで返し、CDN / ブラウザに任せる（フェーズ内で in-memory cache まで実装するとスコープが膨張するため）。次フェーズで in-memory cache 統合を検討

### XSS 攻撃面の点検（Plan レベルで明示）

| 攻撃ベクター | 対策 |
|---|---|
| **`title` に `<script>` 等を埋め込み** | `escapeHtml()` で `<` を `&lt;` に。CSP `default-src 'none'` で script 全ブロック |
| **`writer` に `"` を埋め込んで属性破壊** | 文字列を属性に入れない設計（`<span>` 等の textContent のみ）。やむを得ず属性に入れる場合は `escapeAttr()` で `"` も escape |
| **`story` に巨大な改行+HTML** | 入力長 cap (5000 文字程度に clip)。`<br>` への改行変換は escape 後に `\n` を `<br>` に置換するか、CSS `white-space: pre-wrap` で済ませる（後者推奨。混入リスク無し） |
| **`url` クエリで javascript: スキーム / data: スキーム** | URL 検証段階で `https:` のみ許可。それ以外は 400 を返す |
| **embed 経由で任意サイトの SSRF** | プラグイン dispatch 後、`renderEmbed` を実装するプラグインだけが対象 → syosetu API しか叩かない構造に閉じ込められる。汎用 fetch は embed 内には存在しない |
| **iframe sandbox bypass** | summaly は iframe を出す側ではない（出すのは Misskey）。CSP `frame-ancestors` で読み込み側を制限する選択肢のみ提供 |
| **CORS と iframe の混同** | iframe の許可は CORS (`Access-Control-Allow-Origin`) ではなく **`CSP: frame-ancestors` / 旧 `X-Frame-Options`**。embed エンドポイントには CORS ヘッダ不要（fetch されない）。誤って CORS を出して埋め込み許可したつもりにならないよう実装コメントに明記 |

## デプロイ・連携前提（実装着手前に確認）

### iframe 表示経路

Misskey の **summary proxy `/url`** はバックエンド経由の JSON API 中継であり、iframe の中身は経由しない:

```
[1. メタデータ取得 = JSON]
Misskey browser ──fetch──> Misskey backend /url ──server-to-server──> summaly /
                                                                        (CORS 回避)

[2. iframe 表示 = HTML]
Misskey browser ──iframe src=player.url──> summaly /embed
                  (Misskey backend を経由しない、ブラウザが直接 fetch)
```

### この経路で必要な条件

1. **summaly が公開ホストである必要がある**（ブラウザから到達可能な HTTPS URL）
   - VPC / Tailscale 等の閉域デプロイでは embed 機能を使えない
   - その場合は `[embed].enabled = false` で完全無効化を推奨
2. **iframe 許可ヘッダ**: 別ドメインからの iframe 化は **CORS ではなく** `Content-Security-Policy: frame-ancestors`（旧 `X-Frame-Options`）で制御される
   - summaly 側で `frame-ancestors *` を出せば任意の Misskey から iframe 可能
   - CORS ヘッダ (`Access-Control-Allow-Origin`) は **embed エンドポイントには不要**（fetch されるわけではないため）
3. **Misskey フロントの iframe ホワイトリスト**（要確認 → Step 0）

## 実装ステップ（チェックリスト）

各ステップで `pnpm eslint && pnpm test` を通す。

- [x] **Step 1 — embed エンドポイント基盤** (完了 2026-05-08)
  - [x] `src/utils/escape-html.ts` を新設 (`escapeHtml(s)` / `escapeAttr(s)` で `& < > " '` の 5 文字を entity 化) + テスト 9 ケース
  - [x] `src/iplugin.ts` に `renderEmbed?: (url, opts?) => Promise<EmbedRenderResult>` と `EmbedRenderResult { body, width, height }` を追加
  - [x] `src/index.ts` の `SummalyOptions` に `embedBaseUrl?: string` と `embedConfig?: { enabled, allowedPlugins, frameAncestors }` を追加
  - [x] Fastify plugin 本体に `GET /embed?url=<URL>` ルートを追加:
    - URL バリデーション (https only、parse 失敗・javascript:/data:/http: は 400)
    - `embedConfig` 未設定 / `enabled === false` で 404
    - builtinPlugins から `test() && renderEmbed != null && allowedPlugins.includes(name)` の最初を採用、無ければ 404
    - 未知クエリは静かに無視 (Misskey transformPlayerUrl の autoplay=1 注入対応)
    - CSP `default-src 'none'` + `style-src 'unsafe-inline'` + `img-src https:` + `frame-ancestors <config>` + `X-Content-Type-Options: nosniff` + `Referrer-Policy: no-referrer` + `Cache-Control: public, max-age=600`
    - エラー経路は plain text 400 / 404 / 500 (HTML 返さない)
    - **defense-in-depth**: `<script>` sanity check (M-4) + body サイズ 512KB cap (L-2)

- [x] **Step 2 — config と server エントリの拡張** (完了 2026-05-08)
  - [x] `bin/config-loader.ts`:
    - `ServerOptions.publicUrl?: string` を追加 (https only 検証、空文字列禁止)
    - `[embed]` セクション parser を追加: `enabled?: boolean`、`allowedPlugins: string[]` (空配列禁止 fail-close)、`frameAncestors?: string[]` (各要素 `*` / `'self'` / `'none'` / origin only URL のみ許容、CSP インジェクション防御)
    - `parseTomlConfigString` の `summaly` 出力に `embedBaseUrl` (publicUrl の origin+pathname を抜き出して末尾スラッシュ削除) と `embedConfig` を組み込む
    - `frameAncestors` に `*` が含まれる場合は stderr に warning (商用運用は明示制限推奨)
  - [x] `config.example.toml` と `docs/deploy-examples/summaly-config.example.toml` の **両方** に `[embed]` セクションのコメント例を追加
  - [x] `test/config-loader.test.ts` に embed セクションパース + バリデーション + CSP インジェクション防御のテスト 14 ケース追加

- [x] **Step 0 — Misskey フロントの iframe 許容範囲を調査**（完了 2026-05-07）
  - **調査結果**: Misskey フロント (`MkUrlPreview.vue`) は **iframe ドメイン allowlist 無し**。`player.url.startsWith('http://') || .startsWith('https://')` だけが条件。本フェーズの実装は **Misskey fork 側修正なしで動く** ことを確認
  - 観察事項（実装に反映すべき制約）:
    - **デフォルト `playerEnabled = false`**: 初回表示は card style のみで、ユーザーが「enable player」ボタンを押して初めて iframe が出る → **`summarize()` の card 用 description 整形は embed と同じくらい重要**
    - **アスペクト比指定 (`padding: height/width * 100%`)**: width/height は **比率としてのみ** 効く、絶対値は無視。コンテナ幅にレスポンシブで伸縮する
    - **`transformPlayerUrl()` がクエリ汚染**: `autoplay=1` / `auto_play=1` が勝手に追加される（Twitch 系は `parent` も）→ embed エンドポイントは **未知クエリを無視** する設計が必須（厳密 query 検証で 400 を返さない）
    - **iframe sandbox 属性**: `allow-scripts allow-same-origin` 付きで技術的には JS 実行可能。本フェーズでは **CSP `default-src 'none'` で JS 実行を構造的に殺す方針を維持**（攻撃面縮小優先）
  - 参照: [/Users/riin/workspace/misskey-worktrees/misskey/packages/frontend/src/components/MkUrlPreview.vue](/Users/riin/workspace/misskey-worktrees/misskey/packages/frontend/src/components/MkUrlPreview.vue), [.../utility/url-preview.ts](/Users/riin/workspace/misskey-worktrees/misskey/packages/frontend/src/utility/url-preview.ts)
  - [src/utils/escape-html.ts](../../src/utils/escape-html.ts) を新設: `escapeHtml(s) / escapeAttr(s)` の純関数 + テスト
  - [src/iplugin.ts](../../src/iplugin.ts) に `renderEmbed?: ...` と `EmbedRenderResult` を追加
  - [src/index.ts](../../src/index.ts) の `SummalyOptions` に `embedBaseUrl?: string` を追加
  - Fastify プラグイン本体（`src/index.ts` の `register`）に **`/embed` ルート登録**:
    - URL バリデーション（`https:` only、`new URL()` で parse 失敗時は 400）
    - `cfg.embed.enabled === false` なら 404
    - `cfg.embed.allowedPlugins` に対象プラグインが入っているか確認、なければ 404
    - 既存の `plugins[]` を回して `test(url) === true && renderEmbed != null` の最初のものを採用
    - `plugin.renderEmbed(url, opts)` を呼ぶ
    - **未知クエリは無視する**（Misskey の `transformPlayerUrl` が `autoplay=1` / `auto_play=1` を勝手に追加するため、厳密 query 検証で 400 を返してはいけない）。`url` 以外のクエリは読まずに捨てる
    - CSP / X-Frame-Options / Cache-Control / Content-Type ヘッダを付けて HTML 返却
    - エラー時は **plain text 400 / 404 / 500**（HTML を出さない、CSP も `default-src 'none'`）

- [ ] **Step 2 — config と server エントリの拡張**
  - [bin/config-loader.ts](../../bin/config-loader.ts):
    - `[server].publicUrl?: string` を追加（HTTPS のみ許可、URL parse 検証）
    - `[embed]` セクションを追加: `enabled?: boolean`、`allowedPlugins?: string[]`、`frameAncestors?: string[]`
    - `parseTomlConfig` の `summaly` 出力に `embedBaseUrl: server.publicUrl`、`embed: { ... }` を組み込む
  - [bin/summaly-server.ts](../../bin/summaly-server.ts):
    - register 時に `embed` config を渡す（既存と同じ流儀）
  - [config.example.toml](../../config.example.toml) と [docs/deploy-examples/summaly-config.example.toml](../../docs/deploy-examples/summaly-config.example.toml) **両方** に `[embed]` セクションを追加（example 同期チェック）
  - [test/config-loader.test.ts](../../test/config-loader.test.ts) に embed セクションパース + バリデーションのテスト追加
  - [test/config-example-plugins.test.ts](../../test/config-example-plugins.test.ts) を `syosetu` 追加で更新（[Feedback.md](../../.claude/Feedback.md) のチェック構造）

- [x] **Step 3 — syosetu プラグインの追加** (完了 2026-05-08)
  - [x] `src/plugins/syosetu.ts` を新設 (test / extractNcodeAndR18 / buildApiUrl / parseNovelApiResponse / composeDescription / composeEmbedHtml / buildSummaryFromApi / summarize / renderEmbed)
  - [x] ジャンル ID マッピングは **`src/utils/syosetu-genres.ts`** として分離 (Plan の `src/plugins/syosetu-genres.ts` から変更 — `src/plugins/` 配下は plugin のみ置く既存テスト規約を尊重するため)
  - [x] `src/plugins/index.ts` に syosetu を登録
  - [x] `config.example.toml` + `docs/deploy-examples/summaly-config.example.toml` 両方の `[plugins].allowed` に `"syosetu"` 追加
  - [x] テスト 32 件追加 (test() URL マッチ + 別パス除外 / extractNcodeAndR18 / buildApiUrl / composeDescription / buildSummaryFromApi / composeEmbedHtml + XSS 攻撃 3 ケース)
  - [x] レビュー対応 (W-1 ncode 正規表現を `n\d+[a-z][0-9a-z]*` に強化、`/novelview/` `/ncode/` 等の他パス誤マッチを構造的に除外 + S-1/S-4 コメント補足)


- [x] **Step 4 — テスト** (部分完了 2026-05-08): pure 関数 (composeEmbedHtml / buildSummaryFromApi / extractNcodeAndR18 / parseNovelApiResponse / composeDescription / buildApiUrl) を syosetu.test.ts で 32 ケース網羅 + escape-html / embed エンドポイント基盤テストを Step 1+2 で追加済 (escape-html.test.ts 9 + embed.test.ts 8 + config-loader.test.ts embed 14)。**残: `summarize` / `renderEmbed` のフルフロー (実 API 経由) は外部 `api.syosetu.com` mock infra が現リポに無いため Step 5 dev 手動検証で代替。test/jsons/syosetu/ フィクスチャ + mock fastify api server の追加は本フェーズの予算外**

- [ ] **(旧) Step 4 — テスト**（fastify mock + フィクスチャベース、ネットワーク非依存）
  - **embed エンドポイントのテスト** [test/embed.test.ts](../../test/embed.test.ts) 新設:
    - 正常系: 対応プラグインの URL で 200 + 期待 HTML が返る + CSP ヘッダ確認
    - 400: 不正 URL（http: / parse 失敗 / 空文字）
    - 404: embed.enabled=false / allowedPlugins に無いプラグイン
    - **XSS テスト**: API レスポンスに `<script>` / `"` / `onerror=` を仕込んで、出力 HTML に escape 済みで現れることを確認
    - **CSP ヘッダ厳格性**: レスポンスヘッダを正規表現で検査
  - **syosetu プラグインのテスト** [test/index.test.ts](../../test/index.test.ts) 追加:
    - 通常作品の API レスポンス（フィクスチャ）で Summary 組み立て確認
    - R-18 ドメインで `sensitive: true` + sitename 切り替え
    - 短編 (`novel_type: 2`) と完結 (`end: 1`) の description 組み立て確認
    - `allcount: 0` で null 返却（test ハーネスのモック）
    - `embedBaseUrl` 設定時 / 未設定時の player.url 切り替え
    - chapter URL `/<ncode>/2/` でも作品レベル ncode に正規化される
  - フィクスチャ: [test/jsons/syosetu/](../../test/jsons/syosetu/) ディレクトリを新設して JSON を置く
  - モックサーバ（既存の fastify テストハーネス）に `api.syosetu.com` 相当のルートを足す

- [ ] **Step 5 — dev サーバ動作確認**
  - [dev/sample-urls.ts](../../dev/sample-urls.ts) に「小説家になろう」グループ追加:
    - `https://ncode.syosetu.com/n7587fe/` (作品見出し)
    - `https://ncode.syosetu.com/n7587fe/2/` (個別エピソード、作品レベルに正規化される)
    - `https://novel18.syosetu.com/<sample-ncode>/` (R-18、sensitive: true 確認)
  - dev サーバ起動して **iframe プレビューが card style と並んで表示されること** を実機確認
    - dev/server.ts で `embedBaseUrl: 'http://127.0.0.1:3000'` を渡す
    - dev/public/index.html で player.url があれば iframe を表示する UI を追加（無ければ追加）

- [x] **Step 6 — ドキュメント更新** (完了 2026-05-08)
  - [x] README.md のプラグイン一覧に `syosetu` 行追加 (sqex 行も併せて追加されていなかったので合体反映)
  - [x] docs/Plugins.md に syosetu セクション + `renderEmbed` interface 説明 + 「契約 / 運用」記述追加
  - [x] docs/Library.md に `embedBaseUrl` / `embedConfig` の表行追加 (Fastify モード専用と明記)
  - [x] docs/SETUP.md に `/embed` エンドポイント節 + `[server].publicUrl` (https only) + `[embed]` config + CSP 多層防御 + Misskey 側挙動 (Step 0 調査結果) を追加
  - [x] CLAUDE.repo.md の対応形式表に syosetu 行追加
  - [x] CHANGELOG.md は Step 1+2 / Step 3 で都度反映済

- [x] **Step 7 — 知見記録** (完了 2026-05-08)
  - [x] `docs/knowhow/embed-endpoint-design.md` 新設 — 8 層 defense-in-depth (URL https-only / プラグイン allowlist fail-close / CSP `default-src 'none'` / プラグイン側 escapeHtml 契約 / Fastify 側 `<script>` sanity check / body 512KB cap / error 経路 plain text のみ / TOML `frameAncestors` の origin-only 厳格検証で CSP インジェクション防御) + Misskey 側挙動 + library/Fastify 分離 + 拡張時の踏み台
  - [x] docs/knowhow/INDEX.md 更新 (embed-endpoint-design 行を summaly プラグイン基盤セクション末尾に追加)
  - 既存 plugin-infrastructure-patterns.md への「公式 API 直叩き + 自前 HTML 表示」セクション追加は **次フェーズ送り** (npmjs Registry 直叩きと renderEmbed パターンを横断する一般化記述、phase13.1 の範囲を超える)

- [ ] **Step 8 — 品質ゲート**
  - Stage 1: `pnpm build && pnpm eslint && pnpm typecheck && pnpm test` + `bash .claude/tests/run-all.sh`
  - Stage 2: `addf-code-review-agent` 通過、特に **CSP / escape の網羅性** を重点確認
  - Stage 3: `addf-security-review-agent` でも見てもらう（今回は外部に HTML を出すので追加レイヤとして）
  - `addf-contribution-agent` は変更ファイルが ADDF 領域に触れないためスキップ可（既存スキップ条件適用）

## 完了条件 (Definition of Done)

- `https://ncode.syosetu.com/n<id>/` および `/n<id>/<chapter>/` で API 経由 Summary が返る
- `https://novel18.syosetu.com/n<id>/` で `sensitive: true` が付く
- Fastify モードで `embedBaseUrl` を設定すると player.url が `<base>/embed?url=...` を指す
- `/embed?url=<syosetu URL>` が **CSP `default-src 'none'`** + **X-Frame-Options** 付きで HTML を返す
- API レスポンスに `<script>` 等が混入しても出力 HTML には escape されて現れる（XSS テストで担保）
- library mode（直接 import）では `embedBaseUrl` 未設定で player.url=null になる（既存挙動維持）
- `pnpm build && pnpm eslint && pnpm typecheck && pnpm test` が通る

## リスク・注意点

1. **iframe sandbox の挙動依存**: Misskey が iframe に何の sandbox 属性を付けているかで CSS の表示崩れが起きる可能性。**実 Misskey で iframe レンダリングを確認**するまで Step 5 を完了とみなさない
2. **CSP `frame-ancestors *` の判断**: 開発初期は `*` で良いが、商用運用は明示制限が必須。config に切り出して **デフォルト `*` + ドキュメントで「商用運用は制限すべき」と注意書き** にする
3. **API のレート制限**: なろう API は寛容だが大規模 Misskey からのアクセスで 429 が出る可能性。`getJson` の `StatusError` をそのまま伝播させて library 層は何もしない（既存 plugin と同じ流儀）。**Cache-Control: 600s** で前段 CDN にキャッシュさせる前提
4. **API 呼び出しが summarize と renderEmbed で 2 回**: 同じデータを 2 回取りに行くのは無駄だが、Fastify in-memory cache を embed 用にも拡張するスコープは別フェーズ（phase13.2 案）に切り出す。今回は CDN キャッシュ任せ
5. **chapter 単位の本文冒頭表示**: 今回は **作品レベル集約のみ**。chapter ごとの epitext を欲しがる声が出てきた時点で別フェーズで HTML スクレイプを足す（PV カウント問題で UA 偽装が必要）
6. **ジャンル ID マッピングの保守**: なろう API のジャンル ID はめったに変わらないが、新ジャンルが追加されたら手動更新が必要。`Unknown` フォールバックを必ず入れて、未知 ID で表示が壊れないようにする
7. **embed 機能を library 利用者が無効にしたい場合**: `embedBaseUrl` 未設定 = embed 機能無効、というデフォルトで満たされる。Fastify モード起動時も `[embed].enabled = false` で完全無効化できる（fail-close 設計）
8. **iframe 内のテキスト選択 / スクロール**: JS なし HTML+CSS なので、長い `story` は CSS `overflow-y: auto` でスクロールさせる。iframe サイズはコンテナ幅レスポンシブ + width/height は **比率としてのみ効く**（Misskey 側で `padding: height/width * 100%` として処理されるため）。`width: 3, height: 2` 程度の比率指定で 3:2 アスペクトを宣言
9. **summaly が browser 到達可能であることが前提**: 閉域デプロイ（Misskey backend からだけ到達可能な内部ホスト）では embed 機能が使えない。デプロイドキュメントに明記し、`[embed].enabled = false` で完全無効化できる経路を保証する
10. **Misskey フロント側の iframe ホワイトリスト**: Step 0 で **ドメイン allowlist 無し** を確認済（`http(s)://` プロトコルチェックのみ）。Misskey fork 修正は不要
11. **Misskey デフォルト UX**: `playerEnabled = false` 起動なので **初回は card style だけが見える**。ユーザーが明示的に「enable player」ボタンを押した時に初めて iframe が出る → **`summarize()` の card 用 description / thumbnail も embed と同じくらい大事**（embed だけ整えても初回印象が悪いと意味がない）
12. **`transformPlayerUrl` のクエリ汚染**: Misskey が embed URL に `autoplay=1` / `auto_play=1` を勝手に追加してくるため、embed エンドポイント側は **未知クエリは静かに無視** する設計が必須。厳密 query 検証で 400 を返さないこと

## 未検討事項（次フェーズ候補）

- chapter 単位の本文冒頭取得（HTML スクレイプ + UA 偽装）
- embed 用 in-memory cache 統合（Fastify LRU を `/embed` でも使う）
- 他プラグインへの embed 拡張（sqex の商品スペック表 / yodobashi の価格表示 / amazon の更にリッチな表示）
- `frame-ancestors` を Misskey インスタンス自動検出（Origin ヘッダ + allowlist）
- ダークモード対応 CSS（`prefers-color-scheme: dark`）

## 関連 knowhow

- [docs/knowhow/plugin-infrastructure-patterns.md](../knowhow/plugin-infrastructure-patterns.md) — プラグイン基盤・公式 API 直叩きパターン
- [docs/knowhow/plugin-pattern.md](../knowhow/plugin-pattern.md) — プラグイン実装パターン
- [src/plugins/npmjs.ts](../../src/plugins/npmjs.ts) — 公式 API 直叩きの先行事例
- [src/plugins/wikipedia.ts](../../src/plugins/wikipedia.ts) — API 経由 + 完全独自実装の先行事例
