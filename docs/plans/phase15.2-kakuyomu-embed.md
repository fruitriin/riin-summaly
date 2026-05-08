# phase15.2 — カクヨムプラグイン + embed 対応

## 背景

phase13.1 でなろう (`ncode.syosetu.com`) に対する API 直叩きプラグイン + `/embed` エンドポイント基盤を整備した。本番運用後、オーナーから「カクヨムも embed player が欲しい」要望が出た (2026-05-08)。

カクヨム (`kakuyomu.jp`) は KADOKAWA + はてなの Web 小説投稿サイト。なろうと同様に Misskey 等の SNS で URL preview される頻度が高いが、現状は汎用 OGP 経路で title / description が取れるのみで、player iframe (作者・ジャンル・あらすじ表示) は無い。

## ゴール

カクヨムのプラグインを追加し、なろう同等の card style + embed player を提供する。

- `https://kakuyomu.jp/works/<id>` (作品トップ) と `https://kakuyomu.jp/works/<id>/episodes/<eid>` (各話) の両方に対応
- card style: title / 作者 / ジャンル / 連載状態 / あらすじ抜粋 / 作品サムネ
- embed (`/embed?url=...`): iframe で作者・ジャンル・あらすじ・タグ・各種統計を表示

## 設計詳細

### URL マッチ

```typescript
const HOST = /^kakuyomu\.jp$/;
// 作品 ID は 19 桁の数値文字列 (例: 1177354054894377419)
const WORK_PATH = /^\/works\/(\d+)(?:\/episodes\/(\d+))?\/?$/;
```

R-18 専用ドメインは無さそう (要確認)。`isSexual: true` フラグで `sensitive: true` を返す。

### データ取得方式

カクヨムには公式 API が無いが、**HTML 内の `<script id="__NEXT_DATA__" type="application/json">` に Apollo (Relay 風) 正規化キャッシュ JSON が埋め込まれている**ため、これを使う。

実装方針:
1. `scpaping(url, { ...opts, userAgent: 'Twitterbot/1.0' })` で HTML 取得 (PV カウント除外狙い)
2. cheerio で `script[id="__NEXT_DATA__"]` の内容を JSON.parse
3. Apollo state を walk して `Work:<id>` キーを探す
4. `author = { __ref: 'UserAccount:xxx' }` を `UserAccount:xxx` キーで lookup

### `Work` エンティティのフィールド (実観測)

```typescript
interface KakuyomuWork {
  __typename: 'Work';
  id: string;
  title: string;
  catchphrase: string | null;     // キャッチコピー
  introduction: string;            // あらすじ
  genre: KakuyomuGenre;            // enum 文字列 (LOVE_STORY 等)
  serialStatus: 'RUNNING' | 'COMPLETED' | string;
  publicEpisodeCount: number;      // 公開話数
  totalCharacterCount: number;     // 文字数
  totalReadCount: number;          // 総 PV
  totalReviewPoint: number;        // 総評価
  totalFollowers: number;          // フォロワー数
  reviewCount: number;             // レビュー数
  publishedAt: string;              // 連載開始日 (ISO)
  lastEpisodePublishedAt: string;   // 最終話日時
  hasPublication: boolean;          // 書籍化済み
  ogImageUrl: string;               // 作品サムネ (cdn-static.kakuyomu.jp)
  isCruel: boolean;                 // 残酷描写
  isSexual: boolean;                // 性的描写
  isViolent: boolean;               // 暴力描写
  tagLabels: string[];              // ユーザータグ
  author: { __ref: string };         // → UserAccount lookup
}

interface KakuyomuUserAccount {
  __typename: 'UserAccount';
  id: string;
  name: string;                     // 作者名
}
```

### ジャンル enum マッピング (`src/utils/kakuyomu-genres.ts`)

実観測 + 推定で初期マッピング。未知 enum は「その他」にフォールバック (なろうの `getGenreName` と同パターン)。

```typescript
const GENRE_NAMES: Record<string, string> = {
  LOVE_STORY: '異世界恋愛',
  ROMANCE: '現代恋愛',
  FANTASY: '異世界ファンタジー',
  // FANTASY_MODERN: '現代ファンタジー',  // 推定、要確認
  SF: 'SF',
  ACTION: 'アクション',
  HORROR: 'ホラー',
  MYSTERY: 'ミステリー',
  HISTORY: '歴史・時代・伝奇',
  ESSAY_NONFICTION: 'エッセイ・ノンフィクション',
  DRAMA: '現代ドラマ',
  // POEM_FAIRY_OTHER: '詩・童話・その他',
  // CRITIQUE: '創作論・評論',
};

export function getKakuyomuGenreName(g: string): string {
  return GENRE_NAMES[g] ?? 'その他';
}
```

### card style description 構成

なろうと同じ `composeDescription(work)` 形式:

```
作者: <name> / <ジャンル> / 連載中 (169話) / [残酷描写] [性的描写] / あらすじ: <introduction の clip 80 文字>
```

`catchphrase` が存在すれば優先、無ければ `introduction` を使う (なろうの story 相当)。

### embed HTML 構成

なろうの `composeEmbedHtml` を参考に:
- ヘッダ: 作品サムネ (`ogImageUrl`) + タイトル + 作者
- メタ情報: ジャンル / 連載状態 (RUNNING/COMPLETED) / 話数 / 文字数 / マーカー
- あらすじ: clip 300 文字
- フッタ: タグラベル (上位 5 件カンマ区切り) / `lastEpisodePublishedAt`
- CSP `default-src 'none'` 維持 / 全 escapeHtml

### chapter URL 対応 (各話)

`https://kakuyomu.jp/works/<id>/episodes/<eid>` は **作品トップを fetch して各話タイトルだけ別 fetch**:
1. 作品 work data は `https://kakuyomu.jp/works/<id>` から `__NEXT_DATA__` parse
2. 各話タイトルは episode URL の `og:title` から抽出 (`<EpisodeTitle> - <WorkTitle> - カクヨム`)
3. card description 末尾に「各話タイトル: xxx」を付与 (なろう phase13.1 の chapter 対応と同パターン)

設計判断: 各話 episode の HTML にも `__NEXT_DATA__` があり Episode entity が取れるはずだが、初期実装では作品トップを正本とし、episode URL は parent work に丸める (なろうと同じ割り切り)。

### Sensitive 判定

`work.isSexual === true` なら `sensitive: true` を返す。`isCruel` / `isViolent` は description にマーカー表示するが sensitive flag には含めない (なろうの基準と揃える)。

将来的にカクヨムが R-18 専用エリアを持っていることが判明したら、ホスト or path で別判定する。

## ステップ分割

### Step 1: ジャンル enum マップ + プラグイン本体 (M)

- [ ] `src/utils/kakuyomu-genres.ts` 新設 (enum → 日本語ラベル)
- [ ] `src/plugins/kakuyomu.ts` 新設
  - test (URL マッチ) / extractWorkAndEpisode (URL から ID 抽出)
  - parseNextData (HTML → __NEXT_DATA__ JSON parse → Work エンティティ抽出)
  - composeDescription (card style description)
  - buildSummaryFromWork (Summary 組み立て)
  - summarize (フルフロー)
  - composeEmbedHtml + renderEmbed
- [ ] `src/plugins/index.ts` に kakuyomu 登録 (順序: amazon の後ろ、syosetu の近く)
- [ ] `test/kakuyomu.test.ts` 新設 (pure 関数 + fixture HTML 経由 parseNextData テスト)

### Step 2: 設定 example + docs 反映

- [ ] `config.example.toml` の `[plugins].allowed` に `"kakuyomu"`、`[embed].allowedPlugins` 例に追加
- [ ] `docs/deploy-examples/summaly-config.example.toml` も同様
- [ ] `CHANGELOG.md` (unreleased) に追加
- [ ] `docs/Plugins.md` / `CLAUDE.repo.md` 表に追加
- [ ] knowhow `docs/knowhow/plugin-infrastructure-patterns.md` に「Next.js `__NEXT_DATA__` parse パターン」を追記

### Step 3 (将来): 完全な enum 網羅 + episode 単独取得

- [ ] 不明ジャンル enum を本番ログから収集して GENRE_NAMES に追加
- [ ] episode URL の Episode entity 単独取得 (各話タイトル + 各話文字数等)
- [ ] R-18 専用エリアの判定 (要調査)

## 撤退条件

- カクヨムが `__NEXT_DATA__` の構造を変更し parse 不能 → OGP fallback 経路だけ残してプラグイン無効化検討
- カクヨムが Twitterbot UA を弾くようになった → fallback UA リトライ機構で救援、最終的には curl_cffi も検討

## サイズ見積もり

**M** (Step 1 + Step 2 で完結。Step 3 は将来課題)。

なろう (phase13.1 Step 3 + embed) と構造的に同等だが、cheerio + JSON.parse の合わせ技が増えるので少し時間がかかる。

## 関連

- [docs/plans/phase13.1-syosetu-embed.md](phase13.1-syosetu-embed.md) — なろうの参考実装
- [docs/knowhow/plugin-infrastructure-patterns.md](../knowhow/plugin-infrastructure-patterns.md) — プラグイン基盤パターン
- [docs/knowhow/embed-endpoint-design.md](../knowhow/embed-endpoint-design.md) — `/embed` 設計 (8 層防御)
