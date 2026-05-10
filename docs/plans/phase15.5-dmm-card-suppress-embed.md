# phase15.5 — DMM プラグイン: card preview を NSFW 抑制 + embed プレイヤー追加

## 背景

phase15.3 で DMM (FANZA) プラグインを追加したが、`og:image` (作品サムネ) と `og:description` (作品あらすじ) が **直球すぎて Misskey タイムラインの URL preview に流すと露骨** という問題が判明 (2026-05-10、オーナーフィードバック)。

オーナー判断: **card preview は伏せ、embed iframe 側でフル情報を表示** する方針 (「踏まなければ表示されない」原則。embed は明示的にユーザーが展開操作をしないと描画されない仕組みを利用)。

phase13.1 の embed 基盤 (syosetu / kakuyomu で実装済) を流用する。

## ゴール

DMM/FANZA プラグインに「card preview = NSFW 抑制 / embed = 制限なし」の二層表現を追加する。

### Card preview (summaly() 戻り値)

| フィールド | 値 |
|---|---|
| `title` | `【<sitename>】<og:title>` (例: 「【FANZA】家出娘、拾いました。」)。`sitename` は OGP の `og:site_name` (FANZA / DMM 自動分岐) |
| `description` | 固定で `【R-18】 内容を伏せています` (タイトル以外の作品情報は出さない) |
| `thumbnail` | **`null`** (作品サムネを完全に出さない、強制 null 上書き) |
| `icon` | `parseGeneral` 由来のサイト favicon (= サイトロゴ、作品ロゴではない) |
| `sensitive` | `true` (phase15.3 から維持) |
| `player.url` | `<embedBaseUrl>/embed?url=<encoded>` (`renderEmbed` 実装によって自動組立) |

### Embed (`renderEmbed`)

制限なし: og:title (作品名) / og:description (あらすじ) / og:image (作品サムネ) を表示。理由: embed iframe は Misskey UI 上で明示的に展開操作しないと描画されないため、踏むのは合意したユーザーのみ。

レイアウト: 上から `タイトル → サイト名 → 作品サムネ → あらすじ`。CSP `default-src 'none'; img-src https:; style-src 'unsafe-inline'` で 2 段防御 (本ファイル内の `<script>` 不可、外部 fetch 不可、画像のみ https: 経由で許可)。

## 設計詳細

### `summarize()` 改修

phase15.3 の summarize に「OGP は parseGeneral で取得しつつ、card 用に特定フィールドを上書きする」処理を追加する。**OGP 取得自体は維持** (icon / sitename を parseGeneral から拾う必要がある)。

```typescript
export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
  const res = await scpaping(url.href, {
    ...opts,
    userAgent: FB_BOT_UA,
    fallbackUserAgent: undefined,
    fallbackRetryCategories: undefined,
  });
  const summary = await parseGeneral(url, res);
  if (!summary) return null;

  const sitename = summary.sitename ?? 'DMM';
  const ogTitle = summary.title ?? '';
  // 作品名を含めると直球性が残るが、オーナー指示「【サイト名】ページ名」に従って prefix 形式
  const safeTitle = ogTitle !== '' ? `【${sitename}】${ogTitle}` : `【${sitename}】`;

  const playerUrl = composePlayerUrl(url, opts?._embedBaseUrl);

  return {
    ...summary,
    title: safeTitle,
    description: '【R-18】 内容を伏せています',
    thumbnail: null,  // 作品サムネを出さない (icon は維持)
    sensitive: true,  // phase15.3 維持
    player: playerUrl != null
      ? { url: playerUrl, width: 3, height: 2, allow: [] }
      : summary.player,
  };
}
```

### `renderEmbed()` 新設

phase13.1 の syosetu / kakuyomu と同パターン。`scpaping` で OGP を取り直して `composeEmbedHtml` に渡す (`summarize` で取得した summary を引き回さない設計、各経路独立で `renderEmbed` 単独で動くように)。

```typescript
export async function renderEmbed(url: URL, opts?: GeneralScrapingOptions): Promise<EmbedRenderResult> {
  const res = await scpaping(url.href, {
    ...opts,
    userAgent: FB_BOT_UA,
    fallbackUserAgent: undefined,
    fallbackRetryCategories: undefined,
  });
  const summary = await parseGeneral(url, res);
  if (!summary) {
    throw new Error('dmm renderEmbed: parseGeneral returned null');
  }
  const html = composeEmbedHtml({
    title: summary.title ?? '',
    description: summary.description ?? '',
    thumbnail: summary.thumbnail,
    sitename: summary.sitename ?? 'DMM',
  });
  return { body: html, width: 3, height: 2 };
}
```

### `composeEmbedHtml()` (pure 関数 export、テスト容易化)

すべてのユーザー入力 (title / description / sitename) を `escapeHtml` で escape。thumbnail URL は別途 `https:` のみ通す簡易 sanitize (`pickSafeImageUrl` 相当の判定、または既存の `sanitizeUrl` を import)。

レイアウト:
- 上に title (太字)
- サイト名 (灰色 small)
- 作品サムネ (max-width: 100%)
- あらすじ (description、`<p>`、word-break)

## 実装ステップ

### Step 1: プラグイン本体の改修

- [x] `src/plugins/dmm.ts` の `summarize()` を `【sitename】title` + `【R-18】` 固定 + `thumbnail: null` + player.url 組立 に改修
- [x] `composePlayerUrl(url, embedBaseUrl)` を pure 関数として実装 (kakuyomu からコピペ)
- [x] `composeEmbedHtml({ title, description, thumbnail, sitename })` を pure 関数として export 実装
- [x] `renderEmbed(url, opts?)` を実装 (`scpaping` → `parseGeneral` → `composeEmbedHtml`)

### Step 2: テスト

- [x] phase15.3 のテストを更新:
  - [x] title が `【FANZA】サンプル作品` 形式になることを確認
  - [x] description が `【R-18】 内容を伏せています` (固定) であることを確認
  - [x] thumbnail が `null` (作品サムネを抑制) であることを確認
  - [x] icon が parseGeneral 由来のサイト favicon であることを確認
- [x] `composeEmbedHtml` の pure 関数テスト追加:
  - [x] 通常入力で `<title>` / `<img src>` / description が出ること
  - [x] **XSS テスト**: title / description / sitename に `<script>alert(1)</script>` を渡しても escape されること
  - [x] thumbnail が null なら `<img>` が出ないこと
  - [x] thumbnail が `https://` でない (例: `javascript:`) なら `<img>` が出ないこと
- [x] `renderEmbed` の fastify mock テスト追加:
  - [x] 200 + `text/html; charset=utf-8` で HTML が返ること
  - [x] body に title / og:image URL が含まれること

### Step 3: ドキュメント

- [x] `CLAUDE.repo.md` の dmm 行を更新 (card 抑制 + embed 制限なしの設計を記述)
- [x] `docs/Plugins.md` の dmm セクション更新 (`renderEmbed` 対応プラグインに加わる旨)
- [x] `README.md` のプラグイン表 dmm 行を更新 (経路 / 備考)
- [x] `CHANGELOG.md` unreleased セクションに `feat(plugin: dmm)` で追記
- [x] `dev/sample-urls.ts` の dmm エントリに「card 抑制 + embed 表示」の検証用 note 追加
- [x] `docs/knowhow/age-gate-bypass-pattern.md` の DMM 事例に「card 抑制 + embed フル表示」の二層構造を追記 (NSFW プラグインの新パターンとして)

### Step 4: 設定 example 確認

- [x] `[embed].allowedPlugins` の auto-fill (src/index.ts L731) で dmm が `renderEmbed` を実装していれば自動で embed allow される。手動設定不要を確認
- [x] 両 config example の `[plugins].allowed` で `# "dmm",` がコメントアウトのままであることを確認 (NSFW 慣例維持)
- [x] `[embed]` セクションの `enabled = true` + `publicUrl` 設定がある運用環境でのみ /embed が機能する仕様を CHANGELOG に明記

### Step 5: 動作確認

- [x] ローカル `pnpm dev` で:
  - card preview が `【FANZA】家出娘、拾いました。` / `【R-18】 内容を伏せています` / 作品サムネ非表示 になること
  - embed iframe (player) を展開すると title / 作品サムネ / あらすじが表示されること
- [x] 本番デプロイ後 (運用者作業) `https://video.dmm.co.jp/av/content/?id=ailb00009` で同様の挙動

## リスクと判断

- **embed iframe で R-18 サムネを表示することの倫理**: Misskey UI で「URL preview を展開」操作はユーザー意思の表明 (NSFW 設定 ON / share された URL に明示的に開くアクション)。倫理的にはユーザー合意がある状態とみなす
- **CSP 多層防御**: embed HTML は CSP `default-src 'none'` で `<script>` 不可、`img-src https:` で http 画像不可、`style-src 'unsafe-inline'` で外部 CSS 不可 → XSS 経路が構造的に閉じている (escapeHtml の二重防御)
- **サムネ URL の sanitize**: `og:image` URL を `<img src>` に流す前に `https:` のみ通す簡易 sanitize を実装。`javascript:` / `data:` 等を排除
- **作品名タイトル直球性**: `【FANZA】<og:title>` で作品名は出るが、これはオーナー判断 (`Title: 【サイト名】ページ名` 仕様)。タイトルの先頭のみで強い NSFW 抑止には到達しないが、サムネ/あらすじ抑制と sensitive: true の併用で許容範囲

## レビュー対応

- **W-1 (`addf-code-review-agent`)**: `embedBaseUrl` 未設定時 (library mode) に `summary.player` を fallthrough で渡すと `parseGeneral` の oEmbed 検出経路で外部 player URL が card に出てしまう設計上の穴を指摘。NSFW プラグインの設計意図 (embed 経由でのみ作品情報を見せる) と矛盾するため、`{ url: null, width: null, height: null, allow: [] }` で明示的に null 化する形に修正 (syosetu / kakuyomu と同型 player 構造に統一)。回帰防止テストとして「embedBaseUrl 未設定時に player.url が null」の expect を既存テストに追加
- S-1 (`pickHttpsImage` の正規表現判定): Info、`new URL().protocol` でより正確だが現状 XSS にはならず実害なし。スキップ
- S-2 (重複 title `【FANZA】FANZA動画` ケースの設計意図コメント): 採用、コードコメントに「重複は許容範囲とする」を追記
- S-3 (重複 title のテスト追加): スキップ、コメントレベルで意図記録があれば十分

## サイズ

M (実装規模 ~200 行 + テスト 9 件 + ドキュメント、kakuyomu 同型の embed パターン流用)
