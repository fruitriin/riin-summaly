# phase19.1 — Google Drive プレビュープラグイン (iframe player)

## 背景

オーナーから「Google Drive の動画と Google フォトの共有 iframe プレビューに対応してほしい」という要望 (2026-06-01)。

調査 (web 調査 + `curl` 実機ヘッダ確認) の結果、**2 サービスで実現可能性が大きく異なる**ことが判明した:

| サービス | iframe 埋め込み | 実機確認 |
|---|---|---|
| **Google Drive** | **可能**。`drive.google.com/file/d/<id>/preview` が公式の embed URL。`X-Frame-Options` / frame 制限 CSP を **返さない** | `curl -I .../preview` → frame ブロックヘッダなし (CSP は `require-trusted-types-for 'script'` のみ、framing は許可) |
| **Google Photos** | **不可能**。`photos.google.com` が **`x-frame-options: SAMEORIGIN`** を返すため、第三者サイト (Misskey) の iframe には絶対に表示されない | `curl -I https://photos.google.com/` → `x-frame-options: SAMEORIGIN` |

### Google Photos を本 phase スコープから外す判断

`x-frame-options: SAMEORIGIN` は **構造的に回避不能**(サイト側が明示的に第三者 framing を拒否している)。iframe player は実装しても Misskey 上で blank になるだけ。

代替として「共有アルバムページの `og:image` (カバー画像) を thumbnail に抜く card 表示」は技術的に可能だが、

- Google Photos 共有ページは大半が JS 動的レンダリング (SPA) で `og:image` が安定して取れる保証が薄い (fail mode I の懸念)
- 抽出できる画像 URL は非永続 (Google 側で失効する)

ため、**オーナーと相談の上 (2026-06-01)、Google Photos 対応は本 phase から除外**した。将来 fail mode I 救援 (Playwright, phase15.1) が入った後に「card 表示のみ」で再検討する余地を残す (末尾「将来検討」参照)。

→ **本 phase は Google Drive の iframe player プラグインのみを実装する。**

### Drive: 対応する file 種別

オーナー確認 (2026-06-01): **`drive.google.com/file/d/<id>` の全 file 種別**を `/preview` iframe 対象にする。Google の `/preview` は video / PDF / 画像 / Docs すべてをレンダリングするため、URL から種別判定する必要がなく、同一コードで広くカバーできる (Drive は URL に file 種別を露出しない)。

## ゴール

`drive.google.com/file/d/<id>/...` 形式の共有 URL について、`Summary.player.url = https://drive.google.com/file/d/<id>/preview` の iframe player を返す。Misskey 上で Drive の動画/PDF/画像がインライン再生・表示される。

- 新規プラグイン `google-drive` を追加
- oEmbed は存在しないため **player URL を直接組み立てる** (`youtube` / `spotify` の oEmbed 経路とは異なり、ネットワーク I/O なしの pure 構築)
- `test()` で `drive.google.com` の `/file/d/<id>` 形式にマッチ
- player の `width`/`height` は 16:9 (動画想定のデフォルトアスペクト比) を返す

## 設計詳細

### マッチ条件 (`test`)

```typescript
export const name = 'google-drive';

// drive.google.com および drive.usercontent.google.com は対象外 (後者は直 DL URL)
const HOST = 'drive.google.com';
// /file/d/<id>/view, /file/d/<id>/preview, /file/d/<id>/edit, 末尾なし すべて許容
const FILE_ID_RE = /^\/file\/d\/([a-zA-Z0-9_-]+)/;

export function test(url: URL): boolean {
  if (url.hostname !== HOST) return false;
  return FILE_ID_RE.test(url.pathname);
}
```

- file ID の文字種は Drive の base64url 風 ID に合わせ `[a-zA-Z0-9_-]+`。
- `/open?id=<id>` 形式や `/uc?id=<id>` (直 DL) は **対象外**(共有 UI が生成する標準形は `/file/d/<id>/view`)。必要なら将来追加。

### player URL の組み立て (pure 関数, export)

`youtube.ts` の `buildSummaryFromOEmbed` と同様、テスト容易性のため **ネットワーク I/O を含まない pure 関数**として切り出す:

```typescript
export function buildSummaryFromUrl(url: URL): Summary | null {
  const m = FILE_ID_RE.exec(url.pathname);
  if (!m) return null;
  const id = m[1];
  // preview URL を encodeURIComponent 不要な構造で組み立てる (id は文字種制限済み)
  const playerUrl = `https://drive.google.com/file/d/${id}/preview`;
  // 防御: 組み立てた URL を再 parse して https を検証 (plugin-infrastructure-patterns の作法)
  try {
    if (new URL(playerUrl).protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return {
    title: null,            // Drive は file 名を匿名 API で出さないため null (player 優先)
    icon: 'https://drive.google.com/favicon.ico',
    description: null,
    thumbnail: null,
    player: {
      url: playerUrl,
      width: 16,            // アスペクト比 16:9 (Misskey は height/width 比率で解釈)
      height: 9,
      allow: [...PLAYER_ALLOW_OEMBED],
    },
    sitename: 'Google Drive',
    activityPub: null,
    fediverseCreator: null,
  };
}

export async function summarize(url: URL): Promise<Summary | null> {
  return buildSummaryFromUrl(url);
}
```

#### title / thumbnail を null にする判断

匿名 (未ログイン) で Drive file の **メタデータ (file 名・サムネ) を安定取得する公開 API は無い**。

- `/preview` ページを scrape すると JS 動的描画 + ログインゲートで安定しない
- Drive API (`files.get`) は OAuth/API key 必須で、公開共有でも anonymous では file 名を返さないことがある

そのため title/thumbnail は `null` で返し、**player iframe をプレビューの主役**にする (youtube の oEmbed が title を返すのとは事情が異なる)。Misskey 側は player があればそれを表示するため、title なしでも実用上問題ない。

> **将来検討**: API key を運用者が設定できる場合に限り `files.get?fields=name,thumbnailLink` で title/thumbnail を補完するオプションを追加する余地あり (本 phase スコープ外)。

### `allow` permission

`PLAYER_ALLOW_OEMBED` (`autoplay` / `clipboard-write` / `encrypted-media` / `picture-in-picture` / `web-share` / `fullscreen`) をそのまま流用。Drive video player は `encrypted-media` (DRM) / `fullscreen` / `autoplay` を必要とするため適合。

### `skipRedirectResolution` は不要

Drive の `/file/d/<id>/view` は **終端 URL** (短縮でない)。ただし `summaly()` 入口の HEAD probe (`SummalyBot` UA) が `/view` でログインゲートにリダイレクトする可能性がある。

- 本プラグインは **scrape せず URL から player を組み立てるだけ**なので、HEAD probe がどこにリダイレクトしても `summarize` の挙動には影響しない (URL から id を抜くだけ)。
- ただし HEAD probe が別ホストにリダイレクトすると `test()` が外れて汎用パスに落ちる懸念がある。Drive の `/view` がログイン要求でも **同一ホスト内**にとどまる想定だが、念のため **`skipRedirectResolution = true` を宣言**して原 URL のまま本プラグイン経路に乗せる (`yodobashi` / `dmm` と同じ防御、純損失なし)。

```typescript
export const skipRedirectResolution = true;
```

### exit sanitize との整合

`src/index.ts` L582-589 の出口 sanitize は `player.url` を `sanitizeUrl()` に通し、`https:` ならそのまま通す。組み立てた `https://drive.google.com/.../preview` は通過する (確認済み)。

## 実装ステップ

### Step 1: プラグイン本体

- [x] `src/plugins/google-drive.ts` を新設 (上記設計通り、`buildSummaryFromUrl` を pure export)
- [x] `src/plugins/index.ts` の `plugins` 配列に登録 (末尾に追加)

### Step 2: テスト

- [x] `test/index.test.ts` の `oEmbed 系プラグイン` describe ブロックにテスト追加 (既存プラグインと同じ集約方針):
  - [x] `test()` マッチ判定: `/file/d/<id>/view` true / `/file/d/<id>/preview` true / `/file/d/<id>` (末尾なし) true / `/drive/folders/<id>` false / 詐称ドメイン (`drive.google.com.evil.com`) false / `docs.google.com` false
  - [x] `buildSummaryFromUrl` の player URL が `https://drive.google.com/file/d/<id>/preview` になる (フィクスチャ URL 直接)
  - [x] player.width=16 / height=9 / allow が `PLAYER_ALLOW_OEMBED` と一致
  - [x] `skipRedirectResolution === true` の宣言確認
  - [x] file ID に後続セグメントが混ざっても最初のセグメントだけ取ることの確認
  - [x] **(レビュー W-1 追加)** 異常に短い (<10) / 長い (>200) file ID を弾くテスト
- [x] 既存テスト (`pnpm test`) 全件パス (677 件)

### Step 3: 設定 example 同期 (phase11.4 / 6.1 派生バグの教訓 — 修正漏れしやすい!)

- [x] `config.example.toml` の `[plugins].allowed` に `"google-drive",` を追加 (アクティブ形式 — NSFW ではないのでコメントアウト不要)
- [x] `docs/deploy-examples/summaly-config.example.toml` の `[plugins].allowed` に `"google-drive",` を追加
- [x] `test/config-example-plugins.test.ts` が両 example 言及を自動検証することを確認 (新規プラグインの `export const name` を全件抽出して両 example にあるかチェックする fail-close ガード — パス)

### Step 4: ドキュメント

- [x] ~~`CLAUDE.repo.md` の表に google-drive 行追加~~ → **対象外**: 本リポジトリには `CLAUDE.repo.md` のプロジェクト固有インスタンスが未作成 (`CLAUDE.repo.example.md` のみ存在、プラグイン表を持たない)。dmm 等の先例 Plan の記述を流用した結果の乖離 (レビュー S-3)
- [x] `docs/Plugins.md` に `google-drive` セクションを追加 (目次にも反映)。「iframe player のみ、title/thumbnail は null」「Google Photos は X-Frame-Options で不可のため非対応」を明記
- [x] `README.md` のプラグイン表に `google-drive` 行を追加 (経路列 = URL 直接組み立て)。`test/readme-plugins.test.ts` の同期ガード通過確認
- [x] `dev/sample-urls.ts` にオーナー提供の Google Drive 共有 URL サンプル 2 件 (横/縦動画) を追加
- [x] `CHANGELOG.md` unreleased セクション冒頭に `feat (plugin: google-drive)` を記録。Google Photos 除外理由 (X-Frame-Options) も記載

> **レビュー対応サマリ (addf-code-review-agent)**: Critical 0。W-1 (file ID 長さ上限なし) → 正規表現を `{10,200}` + 末尾境界 `(?:\/|$)` で reject 化して対処。W-2 (summarize の opts シグネチャ不一致) → `opts?: GeneralScrapingOptions` を受けて `void opts;` で明示 (twitter.ts と同パターン)。S-1 (https 再検証が self-evident) → コメントで意図明記。S-3 (CLAUDE.repo.md 乖離) → 上記 Step 4 で N/A クローズ。contribution-agent: ADDF 由来ファイル変更ゼロでスキップ妥当。

> **E2E 検証 (2026-06-01)**: オーナー提供の 2 URL を built ライブラリで `summaly()` 実行 → 両方とも `player.url = https://drive.google.com/file/d/<id>/preview` を返すことを確認。両 `/preview` URL は `curl -I` で HTTP 200 + `X-Frame-Options` なし = Misskey iframe で描画可能。

## Followup (2026-06-01): 縦動画の縦長プレビュー対応

オーナーから「iframe で縦動画を縦長プレビューできるか?」という質問。初版は `player` を 16:9 ハードコードしていたため縦動画が横長枠でレターボックス表示になる問題があった。

**発見**: Drive の公開 thumbnail エンドポイント `https://drive.google.com/thumbnail?id=<id>&sz=w1000` は **file の実アスペクト比を保った画像**を返す (実測: 横動画 → JPEG `1000×562`、縦動画 → JPEG `1000×1778`)。さらに `/view` ページを `facebookexternalhit/1.1` UA で叩くと `og:title` に **file 名**が入る (匿名で取れる唯一のメタデータ。初版の「title は取得不能」判断は誤りだった)。

**対応**:
- 新規 `src/utils/image-dimensions.ts`: JPEG / PNG / GIF / WebP のヘッダから pixel 寸法を読む最小パーサ (外部依存なし)。`got` の `rawBody` は `Uint8Array` なので `Buffer.from` で wrap して `readUInt16BE` 等を使う (落とし穴: `Buffer.isBuffer(rawBody)` は false)。
- `summarize()`: thumbnail 取得 (寸法) + `/view` OGP 取得 (title) を `Promise.all` で並列実行。dims が取れたら `player.width`/`player.height` を実比率で上書き + thumbnail 採用、title が取れたら採用。どちらも失敗時は base (16:9 + null) にグレースフルデグレード。8 秒 timeout + 2 MiB cap。
- E2E 再確認: 横 → `1000×562` (横長プレビュー)、縦 → `1000×1778` (縦長プレビュー)、title = file 名、thumbnail あり。
- テスト: `test/image-dimensions.test.ts` (JPEG/PNG/GIF/WebP VP8/VP8L/VP8X の横/縦/Uint8Array/不正、8 件) + `extractFileId` + `applyMeta` (寸法/title 上書き + デグレード) で google-drive/image 系計 14 件 (合計 686 件 pass)。
- knowhow: `docs/knowhow/embed-endpoint-design.md` に「外部 thumbnail の pixel 寸法で player アスペクト比を決める」パターンを追記。
- **followup レビュー (addf-code-review-agent)**: Critical 0。バイナリパースの境界チェック / SSRF (private IP ガードは redirect 後の最終 IP を検査) は安全確認。W-1 (`String(res.body)` encoding) → コメント明示。W-2 (WebP テスト無し) → VP8/VP8L/VP8X テスト追加。S-1 (typeFilter 意図) / S-2 (JPEG EOI 早期打ち切り) 対応。S-3 (mutation のテスト不足) → マージ処理を `applyMeta` pure 関数に抽出してユニットテスト追加。

## Followup #4 (2026-06-01): スマホでコントロールが崩れる → Drive `/preview` を CSS scale で縮小ラップ

オーナーが実機 (スマホ) で「横動画のコントロールが崩れる」と報告 (縦動画は followup #2 のアスペクト比対応で OK)。徹底検証で原因と解を確定:

**原因の切り分け**:
- `/preview` をスマホブラウザで**直接**開いても崩れる → Drive 側 UI の問題、アスペクト比調整では直せない。
- 決定的条件: **デスクトップでは崩れず、DevTools のスマホエミュレート (タッチデバイス) で崩れる** → Drive プレイヤーは **タッチデバイスを検出するとコントロールボタンを大きいスマホ用 UI に切り替える**。狭い実描画幅 (~200px) でそのボタンが収まらず崩れる。

**自前 `<video>` 案は原理的に不可と判明 (撤回)**:
- Drive 直ストリーミング URL (`drive.usercontent.google.com/download?...`) は `Cross-Origin-Resource-Policy: same-site` + `Sec-Fetch-Site: cross-site` 403 で第三者サイトの `<video>` / `fetch` / `crossorigin` のいずれからも読めない。
- `videoplayback` 内部ストリームは `application/vnd.yt-ump` (生 mp4 でない) + IP バインド + CORS 不一致。
- コーデックも HEVC/AV1 が混在し Chrome 非対応。
- **罠**: curl/ffprobe は CORP/Sec-Fetch を無視するため「サーバ的には 206 + CORS + Range で取れる」が、ブラウザの `<video>` は再生できない。必ずブラウザ実機で検証する。

**解決: `/preview` iframe を CSS scale で縮小ラップ**:
- `src/utils/drive-embed-html.ts` の `composeDriveScaledEmbedHtml`: 内部 Drive iframe を **固定 `RENDER_WIDTH=900px` (スマホ UI で崩れない最小幅、実機で 600→900 と判明) で描画**し、`transform: scale(calc(100cqi / 900px))` (CSS container query length unit) でカード幅に追従縮小。Drive は「自分は 900px 幅」と認識してコントロールを崩さず描画 → CSS で縮小。**JS 不要** (embed CSP `default-src 'none'` 維持)。
- stage は `height:100%` で embed iframe 自体の aspect-ratio (`player.width/height`) に追従 (二重 aspect-ratio で横動画がずれるのを回避)。
- `EmbedRenderResult.frameSrc?: string[]` 新設 → embed CSP に `frame-src https://drive.google.com` を origin-only 再検証して追加 (本番 `src/index.ts` + dev `dev/server.ts`)。
- `composePlayerUrl(url, id, embedBaseUrl)` で embed 有効時は `/embed?url=...`、無効時は `/preview` 直に分岐。
- 実機検証: 横/縦動画 + スマホエミュレートでコントロール崩れず動作確認。
- テスト: `test/drive-embed-html.test.ts` (HTML 構造 / XSS / https / 比率フォールバック 6 件) + `composePlayerUrl` 1 件 (計 693 件 pass)。
- knowhow: `docs/knowhow/embed-endpoint-design.md` に「外部 iframe を CSS scale で縮小ラップ」+「CORP/Sec-Fetch で `<video>` 直再生不可」を追記。

## PR #2 code-review 対応 (2026-06-01)

オーナーから PR #2 のレビュー (fruitriin の敵対的カバレッジ指摘 + `/code-review high` の 9 件) に対応。**スコープは google-drive PR 内に限定** (ヘルパ追加は可だが syosetu/kakuyomu 等の既存プラグインには触れない方針)。

**fruitriin レビュー (image-dimensions 敵対的入力)**:
- `getImageDimensions` に `MAX_DIM=32767` 絶対値上限 + GIF magic 6 byte 厳密検証 + JPEG 0xFF padding スキップを実装。width/height=0 / truncated / 異常 segLen DoS の退行防止テストも有効化 (敵対的カバレッジ 14 件)。
- 「上限超えたら ffmpeg 縮小」案 → **本パーサは画像をサーブせずアスペクト比判定のみ**なので縮小不要、null → 16:9 fallback が正解と整理。

**`/code-review high` 9 件 (上記 followup #4 の実装をリファクタ)**:
1. **アスペクト比 clamp**: `MAX_DIM` 絶対値上限は `1×32767` のような極端比を素通しし、宣言された脅威 (padding-bottom 破綻) を防げていなかった。`applyMeta` / `renderEmbed` に **比率 [1/4..4/1] clamp** 層を追加 (絶対値上限とは別レイヤ)。
2. **JPEG off-by-one**: `while (offset+9 < len)` → `<= len` (width が buffer 末尾ぴったりの valid JPEG 取りこぼし修正)。
3. **二重フェッチ統合**: `summarize` と `renderEmbed` の重複フェッチを `resolveDriveMeta(id, opts)` に共通化。
4. **Range + 軽量抽出**: thumbnail/title フェッチに `Range: bytes=0-65535`、og:title は cheerio 全 DOM 構築をやめ `extractOgTitle` 正規表現に (cheerio 依存を google-drive から除去)。
5. **CSP テスト**: `filterCspOrigins` / `buildCspDirectiveParts` のヘッダインジェクション防御に専用テスト 9 件 (`test/csp-origin.test.ts`)。
6. **cspDirectives 一般化**: `EmbedRenderResult.frameSrc?: string[]` → `cspDirectives?: Record<string, string[]>` (ディレクティブ許可リスト + origin-only 再検証)。revert された `<video>` 版の media-src churn を構造的に解消。
7. **player URL helper**: embed player URL 組み立てを `src/utils/embed-player-url.ts` の `composeEmbedPlayerUrl` に切り出し (末尾スラッシュ複数除去。google-drive のみ使用、他プラグイン移行は別 PR)。
8. **scale ラッパー汎用化**: `src/utils/drive-embed-html.ts` → `src/utils/scaled-iframe-embed.ts` の `renderScaledIframeEmbed` (`renderWidth` 引数化)。Drive 固有の 900px はプラグイン側 `DRIVE_RENDER_WIDTH` に保持。
9. **thumbnail 独立採用**: dims 判定失敗 (大きすぎ/破損で null) でも thumbnail URL は valid なので `applyMeta` で dims と独立に採用 (絵は出す)。
- 併せて dev `/embed` に本番と同じ body size cap (512KB) 追加 (guard parity)。
- テスト計 717 件 pass。`/code-review high` で検出した #10 (library mode 非 https embedBaseUrl) は W-2 既知事項として対象外。

**派生: デスクトップ縦動画の巨大化対策 (オーナー実機 2026-06-01)**:
- 本番 Misskey で**デスクトップ表示時に縦動画が画面を埋める**ほど巨大化する問題が判明 (縦動画 h/w≈1.78 を比率で渡すと広いカード幅で高さ過大)。
- **Misskey `MkUrlPreview.vue` 確認**: `player.width` が **falsy のとき** 高さ計算を `padding-top:(height/width)*100%` (比率) から **`padding-top:<height>px` (絶対 px)** に切り替える。これを利用。
- 対策: **縦動画 (h/w>1) は `player.width=null` + `player.height=480px` (固定 px 高さ)** を返す (`playerBox`)。デスクトップ/スマホ問わず高さ 480px 一定で巨大化しない。その固定 px の箱に内側 Drive iframe を **contain (レターボックス)** で収めるため、`renderScaledIframeEmbed` を contain 方式 (二重 iframe、内側実比率 + `container-type: size` + 中央寄せ + `scale(min(100cqi/RW, 100cqb/innerHeight))`) に変更。縦動画はクロップされず実比率のまま左右余白付きで収まる。横動画・正方形 (h/w<=1) は実比率で素通し。
- 実機検証: デスクトップ幅を変えても縦動画 (width=null, height=480、内側 9:16 レターボックス) の高さが一定 + 横動画も正常を確認。`playerBox` + `renderScaledIframeEmbed` contain テストを更新 (717 件 pass)。

### Step 5: 本番動作確認 (デプロイ後 — 運用者 / オーナー側)

skill `/url-preview-check` Phase 6 のバリエーションで叩く:

| バリエーション | URL 例 |
|---|---|
| 動画 file の `/view` | `https://drive.google.com/file/d/<video-id>/view?usp=sharing` |
| `/preview` 直叩き (冪等性確認) | `https://drive.google.com/file/d/<id>/preview` |
| PDF / 画像 file | `https://drive.google.com/file/d/<pdf-id>/view` |
| クエリ付き (`?usp=drive_link` 等) | id 抽出が安定するか |

期待: 全 URL で `player.url = https://drive.google.com/file/d/<id>/preview` が返り、Misskey 上で iframe が描画されること。**未公開 (非共有) file** はログインゲートになるが、summaly は player URL を返すだけ → iframe 内で Google がログイン要求を表示する (summaly 側の責務外、想定挙動)。

## リスクと判断

- **オープンプロキシ化リスク**: 無し。scrape せず URL 構築のみ。SSRF 経路を一切踏まない。
- **非公開 file の扱い**: summaly は file の公開状態を検証しない (匿名 API が無いため不可能)。非公開 file の player URL を返すと iframe 内で Google のログイン画面が出る。これは Google 側の正常な動作で、情報漏洩リスクは無い (非公開コンテンツは Google がゲートする)。
- **file 名・サムネが出ない UX**: title/thumbnail が null のため、player 非対応クライアントでは情報が薄い。これは匿名メタデータ取得不可という制約由来で、player 対応クライアント (Misskey) では実害なし。
- **Drive 側仕様変更**: `/preview` URL 形式は長年安定 (Google 公式の embed 手順)。`X-Frame-Options` を将来付ける可能性は低い (embed 機能が公式提供のため) が、付いたら救援不可になる (要監視)。

## 関連 knowhow / 関連プラグイン

- [src/plugins/youtube.ts](../../src/plugins/youtube.ts) / [src/plugins/spotify.ts](../../src/plugins/spotify.ts) — iframe player を返す先例 (oEmbed 経由だが player 組み立ての作法を踏襲)
- [docs/knowhow/plugin-infrastructure-patterns.md](../knowhow/plugin-infrastructure-patterns.md) — `name` 定数・ファイル名一致テスト、iframe src の `https:` 検証、pure 関数切り出しによるテスト容易化
- [docs/knowhow/embed-endpoint-design.md](../knowhow/embed-endpoint-design.md) — `Summary.player` のアスペクト比 (height/width 比率) 解釈
- [docs/knowhow/sanitize-and-agent-patterns.md](../knowhow/sanitize-and-agent-patterns.md) — 出口 sanitize で `player.url` が弾かれると player 全体が reset される挙動
- [src/utils/player-allow.ts](../../src/utils/player-allow.ts) — `PLAYER_ALLOW_OEMBED`

## 将来検討 (本 phase スコープ外)

- **Google Photos card 表示**: `x-frame-options: SAMEORIGIN` で iframe は不可能だが、共有アルバムの `og:image` (カバー画像) を thumbnail に抜く card は理論上可能。ただし Photos 共有ページの SPA 動的描画 (fail mode I) で安定取得できる保証が薄い。Playwright モード (phase15.1) 導入後に「card のみ (player なし)」で再検討する。
- **Drive メタデータ補完**: 運用者が Google API key を設定した場合に限り `files.get?fields=name,thumbnailLink` で title/thumbnail を補完するオプション。匿名では取得不可のため、API key 必須の opt-in 機能として将来検討。
- **`/open?id=` / `/uc?id=` 形式**: 標準共有 UI が生成しない URL 形式。要望が出たら `test()` / id 抽出を拡張。

## サイズ

S (実装規模 ~50 行 + テスト 5〜6 件 + ドキュメント。oEmbed I/O が無い分 youtube より単純)
