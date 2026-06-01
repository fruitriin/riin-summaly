# embed エンドポイントの XSS / CSP 設計

> phase13.1 で導入。「summaly が外部から直接 iframe で読まれる HTML を返す」エンドポイントを新設するときの汎用設計知見。

## 課題

Misskey のカードスタイル制約 (1 行 title / 1 行 description / 1 行 sitename) では情報が収まらないサイト (なろう / 商品ページ詳細 / その他リッチ表示が必要なサイト) に対して、**プレイヤー iframe** で表示できる JS なし HTML+CSS を返したい。

しかし「外部に直接 iframe で読まれる HTML を返す」 = **新しい攻撃面の追加**:

| 攻撃ベクター | リスク |
|---|---|
| XSS (`<script>` インジェクション) | プラグインがエスケープし忘れたユーザー入力で任意 JS 実行 |
| 属性破壊 (`"` で `onerror` 仕込み) | エスケープ漏れで属性経由の JS 実行 |
| CSS injection (`expression()` 等) | 古 IE 等で CSS 経由の JS 実行 |
| iframe sandbox bypass | 親フレームから JS 経由で操作される |
| open redirect (`<a href=javascript:...>`) | クリック誘導で別サイト遷移 |
| SSRF (任意 URL を summaly が fetch する経路化) | 内部リソースへの不正アクセス |
| CSRF | GET only / cookie 不要なら影響無し |
| DoS (巨大 URL / 巨大 HTML) | レスポンス cap 無しで帯域・メモリ食潰し |
| CSP ヘッダインジェクション | TOML 設定値の `;` で CSP ディレクティブを上書き |

## 設計原則 (8 層 defense-in-depth)

### 1. URL バリデーション (`https:` only)

```typescript
if (parsedUrl.protocol !== 'https:') return reply.code(400).send('https only');
```

`http:` / `javascript:` / `data:` / `file:` を全て弾く。`http:` も弾く理由は「中間者攻撃で iframe HTML を改竄されてフィッシング・XSS 経路化されるリスク」。

### 2. プラグイン allowlist (TOML `[embed].allowedPlugins`、fail-close)

```typescript
const plugin = builtinPlugins.find(p =>
  p.name != null
  && embedConfig.allowedPlugins.includes(p.name)
  && p.renderEmbed != null
  && p.test(parsedUrl),
);
```

**fail-close**: 空配列 / 未設定なら全プラグインで embed 不可。新サイトを足すときに明示的に allowlist 追加が必要 → 「うっかり全プラグイン許可」を構造的に防ぐ。

### 3. CSP `default-src 'none'` で script を構造的にブロック

```
Content-Security-Policy: default-src 'none'; img-src https:; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors <config>
```

- `script-src` は `default-src 'none'` に吸収されて全ブロック (インライン / external 両方)
- `style-src 'unsafe-inline'` のみ許容 (`<style>` ブロック 1 つ書く前提)
- `img-src https:` で外部画像許可 (icon / thumbnail 用)
- `frame-ancestors` は config 経由で動的、各要素は origin-only に厳格検証

### 4. プラグイン側のエスケープ契約 (`escapeHtml` / `escapeAttr`)

`src/utils/escape-html.ts`:

```typescript
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export function escapeAttr(s: string): string { return escapeHtml(s); }
```

**契約**: プラグインの `renderEmbed` が返す `body` 内のすべてのユーザー入力 (API 由来 / DOM 由来) は `escapeHtml` を通すこと。Fastify 側はエスケープしない (= プラグイン側責任)。

`escapeAttr` は別名で提供 (現実装は同じ) — 呼出側が「ここは属性値」と意識する設計、URL 属性 (`href` / `src`) には別途スキーム検証 (`https:` / `http:` 限定) が必要。

### 5. Fastify 側 `<script>` sanity check (defense-in-depth)

```typescript
if (/<script[\s>/]/i.test(result.body)) {
  reply.code(500).send('render failed'); // 契約違反の早期検出
}
```

プラグイン側の契約を信用せず、Fastify 側でも `<script` の混入を構造的にブロック。**契約違反 (実装ミス) の早期検出 + ファーストライン guard**。

### 6. body サイズ cap (DoS 防御)

```typescript
const EMBED_BODY_MAX_BYTES = 512 * 1024;
if (Buffer.byteLength(result.body, 'utf8') > EMBED_BODY_MAX_BYTES) reply.code(500).send(...);
```

プラグインの実装ミスや異常 API レスポンスで巨大 HTML が返るケースを防ぐ。

### 7. error 経路は plain text のみ (HTML 返さない)

400 / 404 / 500 のエラーレスポンスは `text/plain` のみ:

```typescript
reply.code(400);
reply.type('text/plain; charset=utf-8');
return 'invalid url';
```

HTML を返すと将来の悪意ある CSP 緩和でリスク化する原則。CSP ヘッダはエラーレスポンスでも `default-src 'none'` を維持。

### 8. CSP ヘッダインジェクション防御 (TOML 値の厳格検証)

`bin/config-loader.ts` で `[embed].frameAncestors` の各要素を origin-only に検証:

```typescript
for (const origin of v) {
  if (origin === '*' || origin === "'self'" || origin === "'none'") continue;
  const parsed = new URL(origin); // throw → RangeError
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw RangeError;
  // pathname / query / hash がある = origin だけでない → ヘッダインジェクション疑い
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') throw RangeError;
}
```

**攻撃シナリオ**: `frameAncestors = ["https://x.com; script-src *"]` で CSP の `script-src 'none'` を `script-src *` に上書き (CSP インジェクション、phase13.1 security-review M-1 で発見)。`;` を含む TOML 値が CSP ディレクティブ分離として機能する。

**防御**: TOML パース段階で URL.origin / pathname / query / hash 全て検証して `;` を構造的に弾く。

## 補助的な設計

### CORS と iframe の混同回避

iframe 許可は **CSP `frame-ancestors`** (旧 `X-Frame-Options`)。**CORS (`Access-Control-Allow-Origin`)** は fetch 用で iframe には無関係。embed エンドポイントには CORS ヘッダを出さない (誤って出すと「埋め込み許可したつもり」の混乱招く)。

### 外部 player URL を返すプラグインは「その URL が iframe 可能か」を実装前に確認する (phase19.1)

`Summary.player.url` に **外部サイトの URL を直接入れる** プラグイン (`youtube` の oEmbed iframe、`google-drive` の `/preview` 等) を作るとき、対象サイトが第三者 framing を許可しているかを **`curl -I` で実装前に確認する**:

```bash
curl -sI "https://target.example/embed-url" | grep -iE "x-frame-options|content-security-policy"
```

- **`X-Frame-Options: SAMEORIGIN` / `DENY`** または CSP `frame-ancestors 'self'` を返すサイトは **構造的に iframe 不可** (Misskey の preview 枠に出ない)。回避不能なのでプラグイン化しても無駄。
  - 実例 (phase19.1): **Google Drive** `…/preview` は frame ブロックヘッダなし → iframe player 可。**Google Photos** `photos.google.com` は `X-Frame-Options: SAMEORIGIN` → iframe 不可、card 表示 (`og:image` → thumbnail) しか手段がない。同じ「Google の共有 URL」でも可否が割れる。
- iframe 不可サイトで「リッチ表示」を諦めたくない場合の代替は **card のみ** (`thumbnail` / `medias[]` に画像を出す)。ただし対象が SPA で `og:image` を JS 動的注入していると fail mode I で取れない (`docs/knowhow/spa-dynamic-ogp-unfixable.md`)。
- `player.url` は完全ハードコードのテンプレートでも `new URL(playerUrl).protocol !== 'https:'` の再検証を残す (組み立て方変更時の安全網)。外部 URL を入れる以上、出口 sanitize (`docs/knowhow/sanitize-and-agent-patterns.md`) と二重で `https:` を保証する。

### player のアスペクト比を外部 thumbnail の pixel 寸法から決める (phase19.1 followup)

iframe player の `width`/`height` は **絶対値ではなく比率** (Misskey は `padding-bottom: height/width * 100%`)。ハードコード (例 16:9) だと **縦動画が横長枠でレターボックス**になる。動画 / 画像の **実アスペクト比が事前に分からない** とき、対象サイトが「実寸比を保った thumbnail」を公開していれば、その画像の pixel 寸法を読んで `width`/`height` に入れれば向きが正しく出る。

- 実例 (Google Drive): `drive.google.com/thumbnail?id=<id>&sz=w1000` → 横動画 JPEG `1000×562` / 縦動画 JPEG `1000×1778`。この比率を player にそのまま入れると縦動画が縦長表示になる。
- **寸法パーサは外部依存を増やさず自前で**: JPEG/PNG/GIF/WebP はヘッダ先頭バイトだけで寸法が読める (`src/utils/image-dimensions.ts`)。完全デコード不要なので数 KB の先頭チャンクで足りる。
- **落とし穴**: `got` の `rawBody` は **`Uint8Array`** で返り、`Buffer` ではない。`buf.readUInt16BE` 等の Buffer ヘルパは無いので `Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)` で wrap する (コピーなし view 共有)。`Buffer.isBuffer(rawBody)` は false になる点に注意。
- **グレースフルデグレード必須**: 寸法フェッチは独立 `try/catch` にして、失敗時は安全なデフォルト比率 (16:9 等) で player を成立させる。メタ補完 (title 等) と並列で投げるなら `Promise.all` だが、片方の失敗が全体を倒さないよう各々で catch する。

### 外部 iframe player のコントロール崩れを CSS scale 縮小ラッパーで回避 (phase19.1 followup #4)

外部サイトの iframe player (Google Drive `/preview` 等) を狭い幅 (Misskey カード ~200px) で表示すると、**そのプレイヤーのコントロール UI に最小幅があって崩れる**ことがある。特に **Drive はタッチデバイスを検出するとスマホ用 UI (大きいボタン) に切り替える**ため、デスクトップでは崩れずスマホ (DevTools エミュレート含む) で崩れる、という再現条件になる。cross-origin なので中身の CSS は触れない。

解決: `renderEmbed` で **外部 iframe を「コントロールが崩れない固定幅」で描画し、CSS `transform: scale()` でカード幅に縮小**する。Drive プレイヤーは「自分は広い幅」と認識してコントロールを崩さず描画し、それを縮小表示する。

- **固定描画幅 (`RENDER_WIDTH`) は実機で特定**: Drive は実測 **900px** から崩れなくなる (デスクトップは 600px で足りるがスマホ UI は 900px 必要)。RW を大きくすると scale が小さくなり (コントロールも小さく表示される) が、崩れて操作不能よりは良い。
- **レスポンシブ scale は CSS container query length unit で JS なし実現**: 外側に `container-type: size` (cqi=幅 / cqb=高さ 両方有効)、内部 iframe を `width: <RW>px` + 実比率の高さで描画。`calc(100cqi / <RW>px)` は「コンテナ幅 ÷ 固定幅」の無次元比として解決される。これで embed CSP `default-src 'none'` を緩めずに (= `<script>` なしで) カード幅追従できる。`cqw`/`%` ベースや `zoom` は今回不安定だった、`cqi`/`cqb` + 固定 px 描画が確実。
- **クロップを避けるには contain scale (`min(cqi, cqb)`)**: アスペクト比制限 (下記) で外箱を実比率と違う形にすると、`scale(100cqi/RW)` の **幅基準 scale だけだと動画が箱いっぱいに広がりクロップ**される。`transform: translate(-50%,-50%) scale(min(calc(100cqi/<RW>px), calc(100cqb/<innerHeight>px)))` + 中央寄せにすると **`object-fit: contain` 相当**で「幅も高さも箱を超えない最大倍率」になり、実比率のままレターボックス (左右 or 上下の余白) で収まる。
- **縦長コンテンツは「固定 px 高さモード」で画面幅依存を断つ**: ヘッダ寸法をそのまま player.width/height に流すと、**デスクトップの広いカード幅で縦動画 (h/w≈1.78) が画面を埋める**ほど高さが過大になる。Misskey の `MkUrlPreview.vue` は `player.width` が **falsy のとき** 高さ計算を `padding-top:(height/width)*100%` (比率) から **`padding-top:<height>px` (絶対 px)** に切り替える。これを利用し、**縦動画は `player.width=null` + `player.height=固定 px` (例 480) を返す**と、デスクトップ/スマホ問わず高さが一定になり巨大化しない。その固定 px の箱に内側 iframe を上記 contain でレターボックス表示する。横動画・正方形 (h/w<=1) は実比率のまま。絶対値上限 (MAX_DIM、寸法パーサ層) と比率対策 (dims→player 写像層) はレイヤを分ける。
- **二重 aspect-ratio に注意**: Misskey/dev は embed iframe 自体に `aspect-ratio: player.width/height` を設定する。内部 stage で再度 `aspect-ratio` を掛けると二重になりずれる。stage は `height: 100%` (`container-type: size`) で embed iframe いっぱいに広げ、外箱の aspect-ratio に内側を contain で合わせる。
- **CSP**: 内部に外部 iframe を埋め込むため `EmbedRenderResult.cspDirectives = { 'frame-src': [origin] }` で配信元 origin を宣言 → embed エンドポイントが許可ディレクティブ + origin-only 再検証して CSP に追加 (`frameAncestors` と同じインジェクション防御)。ディレクティブ名をマップ化したことで将来 `media-src` 等が必要でも embed 側コード変更不要。
- 実装: 汎用 `src/utils/scaled-iframe-embed.ts` の `renderScaledIframeEmbed` (`renderWidth` 引数化、provider 非依存)。実機検証は **必ずブラウザの DevTools スマホエミュレートで** (デスクトップだけだと崩れを見逃す。Drive はタッチデバイスでコントロールが大きくなるため、デスクトップの最小幅 600px ではなく 900px が必要)。

### 外部サイトの動画を `<video>` で直再生できないケース: CORP / Sec-Fetch (phase19.1 followup #4)

「iframe player のコントロールが気に入らないから、元動画を取って自前 `<video>` で再生したい」という発想は、**Google Drive のような大手では原理的に塞がれている**ことが多い。Drive の直 DL / ストリーミング URL を `<video src>` に入れても再生できない理由 (実機で全滅を確認):

- **`Cross-Origin-Resource-Policy: same-site`**: 第三者サイトのブラウザからの読み込みを完全ブロック (`Access-Control-Allow-Origin: *` があっても CORP が上位で効く)。`<video src>` / `crossorigin` / `fetch()+blob` のいずれも失敗。
- **`Sec-Fetch-Site: cross-site` で 403**: download URL はブラウザが自動付与する `Sec-Fetch-*` を見て cross-site を 403。`Sec-Fetch-*` は JS から変更不可。
- **`videoplayback` 内部ストリーム**: `application/vnd.yt-ump` (生 mp4 でない) + `ip=` バインド + CORS 不一致で `<video>` 不可。
- **コーデック**: 新しい iPhone は HEVC、手元エンコードで AV1 等、Chrome/Firefox 非対応コーデックが混在 (`ffprobe -show_entries stream=codec_name` で確認可)。
- **最大の罠**: **curl / ffprobe は CORP / Sec-Fetch を無視する**ため「サーバ的には 206 + CORS + Range で取れる」が、ブラウザの `<video>` は再生できない。**サーバ側 curl 検証だけで「再生できる」と判断してはいけない。必ずブラウザ実機 (`<video>` の `error.code` / DevTools Network の 403) で検証する**。
- **結論**: iframe player でしか再生できないサイトは、上記の scale 縮小ラッパーで UI を整える方向に倒す (proxy 中継で CORP を剥がすのは帯域非現実的、コーデック非対応は proxy でも解決しない)。

### `frame-ancestors *` のデフォルト + warning

開発初期は `*` で全許可だが、商用は `https://misskey.example.com` 等で明示制限すべき。config-loader で `*` を含む場合は **stderr に warning** を出す:

```typescript
if (frameAncestors.includes('*')) {
  process.stderr.write('[summaly][embed] frameAncestors = ["*"] が設定されています。商用運用では明示制限を推奨\n');
}
```

### Misskey 側の挙動への対応 (phase13.1 Step 0 調査結果)

- **デフォルト `playerEnabled = false`**: 初回は card style のみ、ユーザーが「enable player」を押した時に iframe が出る → **`summarize()` の card 用 description / thumbnail も embed と同じくらい大事**
- **アスペクト比指定**: `width` / `height` は `padding-bottom: height/width * 100%` で計算される (絶対値ではなく **比率**)。`width: 3, height: 2` で 3:2 アスペクト
- **`transformPlayerUrl` のクエリ汚染**: Misskey が embed URL に `autoplay=1` / `auto_play=1` を勝手に追加するため、embed エンドポイントは **未知クエリを静かに無視** する設計が必須 (厳密 query 検証で 400 を返さない)

### カード description vs embed iframe の責任分担

Misskey の URL preview カードは description が **1 行幅** (CSS で折り返しなしか数行 clip) で表示されるため、複数要素を ` / ` で区切って詰め込むと **肝心の情報 (あらすじ等) が見切れる**。

旧設計 (失敗例):
```
作者: 山田太郎 / ハイファンタジー〔ファンタジー〕 / 連載中 / [残酷描写] / あらすじ: 異世界に転生した主人公…
```
→ カード幅で「あらすじ:」以降が表示されない / 数文字で切れる。

新設計:

| 要素 | card description | embed iframe (renderEmbed) |
|---|:---:|:---:|
| タイトル | (Summary.title 別フィールド) | 上部見出し |
| **あらすじ** (重要) | **80 文字 clip だけ**を入れる | 300 文字 clip + 改行保持 |
| 作者 | × (省略) | meta 行 |
| ジャンル | × (省略) | meta 行 |
| 連載状態 | × (省略) | meta 行 |
| マーカー (R-15 / 残酷描写 等) | × (省略) | meta 行末尾、span で赤文字強調 |
| タグ | × (省略) | あらすじの後ろ |
| サイト名 | (Summary.sitename 別フィールド) | 下部 |

実装 (`src/plugins/syosetu.ts`):
```typescript
export function composeDescription(novel: SyosetuNovelData): string {
  const story = asString(novel.story);
  if (story == null) return '';
  return `あらすじ: ${clip(story, STORY_CARD_CLIP_LENGTH)}`;
}
```

#### embed UI 内部のレイアウト制約

Mi 側プレイヤー iframe には以下の制約がある:
- **縦幅 = 横幅依存** (`padding-bottom: height/width * 100%` でアスペクト比固定)
- **iframe 内のスクロールは無効** (Misskey 側が `scrolling="no"` で出す環境がある)

→ **重要要素を上に寄せる**: タイトル → meta 行 (1 行統合) → あらすじ → タグ → サイト名

meta 行を 3 行 (作者 / ジャンル / 連載状態) から 1 行統合に変えると、上部 1/3 にあらすじまで届くようになり、iframe 高さが固定でも肝心情報が見える。

```
タイトル
作者: 山田太郎 / 連載中 / ハイファンタジー〔ファンタジー〕 / [残酷描写]
あらすじ本文 (300 文字)
タグ: ...
サイト名
```

警告マーカー (`[残酷描写]` `[R-15]` `[BL]` `[GL]` 等) は meta 行内 `<span class="markers">` で囲んで CSS `.markers { color: #b22; }` で赤文字強調。block レベル div で独立させる必要はない。

#### 順序の選定根拠

`作者 / 連載ステータス / ジャンル / 警告` の順序は以下の理屈:

1. **作者**: 検索/識別の主軸。最初に出す
2. **連載ステータス**: 「読み進められるか / 既に完結しているか」の判断材料 (連載中作品をすぐ読み始めたい人 vs 完結を待ってからまとめ読みする人で行動が変わる)
3. **ジャンル**: 興味があるジャンルかの判断材料
4. **警告マーカー**: センシティブ要素 (R-15 / BL / GL / 残酷描写) は最後に置いて視認性を上げる (`<span class="markers">` で赤文字、目に飛び込む)

### library mode と Fastify mode の分離

`embedBaseUrl` / `embedConfig` は **Fastify モード専用**。library mode (`summaly()` 関数直接呼び出し) で `/embed` エンドポイントは存在しないため、これらの設定は無視される (= player.url は null になる)。これは既存の `parseFailureLog` / `inMemoryCache` 等と同じ運用モデル。

### 各話 / chapter URL 対応パターン (連載コンテンツ)

なろう (`syosetu`) / カクヨム (`kakuyomu`) のような **連載コンテンツの各話 URL** で「作品全体のあらすじ」ではなく **その話の本文先頭** をプレビューする設計パターン (両プラグインで実証)。

#### 課題

各話 URL (`/works/<wid>/episodes/<eid>` / `/<ncode>/<chapter>/`) のプレビューが「作品全体のあらすじ」だけだと、ユーザーは「この話を踏んだ意味」(その話の冒頭は何か) が分からない。あらすじは作品トップ URL のときだけ表示し、各話 URL では本文先頭を表示するのが自然。

#### 実装パターン (3 + 1 step)

##### Step 1: `extractEpisodeBody($)` 純関数を export

サイト固有のセレクタで本文段落を抽出。前書き / 後書きクラス (`--foreword` / `--afterword` 等) は除外。

```typescript
// なろう (syosetu): <div class="js-novel-text p-novel__text"> 配下の <p>
export function extractEpisodeBody($: CheerioAPI): string | null {
  const $main = $('.p-novel__text:not(.p-novel__text--foreword):not(.p-novel__text--afterword)').first();
  if ($main.length === 0) return null;
  const paragraphs: string[] = [];
  $main.find('p').each((_, p) => {
    const text = $(p).text().trim();
    if (text !== '') paragraphs.push(text); // 全角空白だけ / <br> だけの段落は除外
  });
  return paragraphs.length > 0 ? paragraphs.join('\n') : null;
}

// カクヨム (kakuyomu): <div class="widget-episodeBody js-episode-body"> 配下の <p>
export function extractEpisodeBody($: CheerioAPI): string | null {
  const $body = $('.widget-episodeBody').first().length > 0
    ? $('.widget-episodeBody').first()
    : $('.js-episode-body').first();
  // ...同様に <p> を改行結合
}
```

純関数として export することで、cheerio fixture を渡す単体テスト (構造変更時の早期検出) が容易。

##### Step 2: `fetchEpisodeData(url, opts)` で title + body を 1 リクエストで取得

旧: `fetchEpisodeTitle` (title だけ) → 新: `fetchEpisodeData` (`{ title, body }`) に置換。1 リクエストで両方抽出することで HTTP コスト + PV カウント影響を抑える。

```typescript
async function fetchEpisodeData(url: URL, opts?): Promise<{ title: string | null; body: string | null } | null> {
  const res = await scpaping(url.href, { ...opts, userAgent: 'Twitterbot/1.0' });
  const title = extractEpisodeTitle(res.$);
  const body = extractEpisodeBody(res.$);
  if (title === null && body === null) return null; // 両方失敗 = 構造変更検出
  return { title, body };
}
```

`Twitterbot/1.0` UA で叩いて PV カウント除外を狙う (作品トップ取得と同 UA、bot allowlist 仕様を尊重)。

##### Step 3: `composeDescription` / `composeEmbedHtml` 拡張

card description は **本文 80 文字 clip** を「あらすじ」ラベル無しで表示 (本文は「あらすじ」ではないため誤認を避ける):

```typescript
export function composeDescription(work, episodeTitle = null, episodeBody = null): string {
  const hasEpisodeTitle = episodeTitle != null && episodeTitle !== '';
  const titlePart = hasEpisodeTitle ? `「${episodeTitle}」` : '';

  // episode body 優先 (各話 URL でユーザーが見たいのは「その話の冒頭」)
  if (hasEpisodeTitle && episodeBody != null && episodeBody !== '') {
    return `${titlePart} / ${clip(episodeBody, 80)}`;
  }
  // fallback: 作品全体のあらすじ (kakuyomu: catchphrase / syosetu: novel.story)
  // ...
}
```

embed HTML は title 直下に `<div class="episode-title">「<title>」</div>` を太字で挿入し、`<div class="story">` には episodeBody (取れたら) / 作品 introduction (fallback) を流す:

```typescript
// CSS
.title { font-size: 1.1rem; font-weight: bold; margin-bottom: 0.25rem; }
.episode-title { font-size: 0.95rem; font-weight: bold; color: #4a4a4a; margin-bottom: 0.5rem; }

// HTML 構造
<div class="title">${workTitleSafe}</div>
${episodeTitleSafe !== '' ? `<div class="episode-title">「${episodeTitleSafe}」</div>` : ''}
<div class="meta">${metaLine}</div>
<div class="story">${episodeBody ?? workIntroduction}</div>  // clip 300 文字
```

##### Step 4 (重要): `summarize` と `renderEmbed` 両方で並列取得

`summarize` だけだと card description は更新されるが embed HTML は古い work data 経由のままになる。`renderEmbed` でも同じ `fetchEpisodeData` を Promise.all で並列実行:

```typescript
export async function renderEmbed(url, opts) {
  const extracted = extractWorkAndEpisode(url);
  const [workData, episodeData] = await Promise.all([
    fetchWorkData(workTopUrl, opts),
    extracted.episodeId != null ? fetchEpisodeData(url, opts) : Promise.resolve(null),
  ]);
  return { body: composeEmbedHtml(workData.work, ..., episodeData?.title ?? null, episodeData?.body ?? null), ... };
}
```

#### 落とし穴

- **本文 fallback の漏れ**: episodeBody 不在時に `work.introduction` / `work.story` に fallback しないと、HTML 構造変更で全プレビューが空文字になる
- **空段落の判定**: 全角空白だけ `<p>U+3000</p>` / `<br>` だけの段落は trim() で空判定してスキップ。これがないと先頭が改行だらけになる
- **前書き / 後書きの除外**: `--foreword` / `--afterword` クラスは「本文」ではない (作者の挨拶 / 補足)。`<p>` を全部結合すると先頭にこれらが混入する。`:not()` セレクタ or class 文字列マッチで除外
- **コメント内の全角空白**: ESLint `no-irregular-whitespace` がコメント内の `U+3000` を弾く。文字列リテラル内では許容されるが、JSDoc 等のコメントには `U+3000` の代わりに `<p>U+3000</p>` のような表記で書く
- **PV カウント配慮**: 本文を取りに行くため、`Twitterbot/1.0` 等の bot UA で叩いて PV カウント除外を狙う。サイト側の bot allowlist 仕様を事前に `curl -A '<UA>' -I '<URL>'` で確認
- **倫理判断**: 本文全文ではなく 80〜300 文字 clip の preview 用途。ユーザーは preview を見て本文を読みに行く動機を持つため、サイトへの誘導効果はむしろ高まる方向

#### 実証

- syosetu (n4830bu/2/): 「新しい生活」 / ダンッ！ダンッ！と何かを床や台に...
- kakuyomu (works/.../episodes/...): 「序章」 / 後宮の下っ端宮女の雨妹は、今日も元気に掃除に勤しんでいる。

各話と作品トップで embed UI 構造が自動的に切り替わる (episode-title 行の有無、story 内容)。

## 拡張時の踏み台

新しいサイトに renderEmbed を実装するとき:

1. プラグインに `renderEmbed: (url, opts) => Promise<EmbedRenderResult>` を実装
2. `body` を組み立てる際 **すべてのユーザー入力を `escapeHtml` で entity 化**
3. `<style>` ブロックは静的に書く (動的に値を流し込まない、CSS injection 経路を作らない)
4. `<a href="...">` は **基本書かない** (iframe 内クリックは Misskey 側の挙動が読めない)。テキストオンリーで確定する
5. config の `[embed].allowedPlugins` にプラグイン名を追加
6. テスト: `composeEmbedHtml` の単体テストで XSS 攻撃 (`<script>` / 属性破壊 / `onerror=`) を **少なくとも 3 ケース** 含める (phase13.1 syosetu の踏襲)

## 参考

- [docs/plans/phase13.1-syosetu-embed.md](../plans/phase13.1-syosetu-embed.md) — 設計起点
- [src/index.ts](../../src/index.ts) — Fastify `/embed` ルート実装
- [src/utils/escape-html.ts](../../src/utils/escape-html.ts) — `escapeHtml` / `escapeAttr` 純関数
- [src/iplugin.ts](../../src/iplugin.ts) — `renderEmbed` interface
- [src/plugins/syosetu.ts](../../src/plugins/syosetu.ts) — 第 1 号実装 (なろう小説 API + composeEmbedHtml)
- [bin/config-loader.ts](../../bin/config-loader.ts) — `[server].publicUrl` (https only) / `[embed]` セクション
- [test/embed.test.ts](../../test/embed.test.ts) — エンドポイント基盤テスト (config gating / URL validation)
- [test/escape-html.test.ts](../../test/escape-html.test.ts) — escape utility テスト
- [test/syosetu.test.ts](../../test/syosetu.test.ts) — composeEmbedHtml の XSS テスト 3 ケース
