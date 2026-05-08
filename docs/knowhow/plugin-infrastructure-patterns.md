# プラグイン基盤の設計パターン

summaly のプラグインシステム拡張で得た再利用可能な設計判断。

## getJson ヘルパ

外部 JSON エンドポイント（oEmbed・komiflo 等の API）を取得する共通ヘルパ。

```ts
export async function getJson(
    url: string,
    referer?: string,
    opts?: Pick<GeneralScrapingOptions, 'userAgent' | 'responseTimeout' | 'operationTimeout'>,
): Promise<unknown>
```

**設計の決め手**:

1. **`getResponse` を経由する**: プライベート IP ガード・content-length 制限等の SSRF 防御を自動継承。プラグインから直接 `got(...).json()` を呼ぶより安全
2. **`typeFilter: /^application\/(?:json|.*\+json)/`**: HTML 等の予期しない content-type を弾き、`JSON.parse` 失敗時のエラー混入を防ぐ。`application/oembed+json` のような vendor サブタイプも許容
3. **戻り値 `unknown`**: 型 assert は呼出側プラグインの責任。型レベルで「呼出側が検証しなければならない」ことを明示
4. **`String(res.body)`**: `as string` キャストではなく明示変換。got が将来 Buffer を返しても安全
5. **`User-Agent` 必須**: `DEFAULT_BOT_UA`（`SummalyBot/<version>`）をデフォルトで送る。ログ解析側で bot 識別できるように
6. **`opts` で UA / タイムアウトを上書き可能**: ブラウザ UA が必須な API のための逃げ道（プラグイン単位で対処）

## プラグイン `name` 定数

`SummalyPlugin` interface に `name?: string` を追加し、組み込みプラグインに `export const name = '<filename>';` を付与する。

**設計の決め手**:

- **optional**: 既存外部プラグインへの破壊的変更を避ける
- **ファイル名と一致させる**: CI テスト（`readdirSync` で `.ts` ファイルを列挙、name と突合）でドリフトを検出
- **用途**: `allowedPlugins` キー、Fastify モードのキャッシュキー、ログ・メトリクスのプラグイン識別子

```ts
// CI テスト例
test('プラグイン name はファイル名（src/plugins/<name>.ts）と一致する', () => {
    const files = readdirSync('src/plugins')
        .filter(f => f.endsWith('.ts') && f !== 'index.ts')
        .map(f => f.replace(/\.ts$/, ''));
    const names = builtinPlugins.map(p => p.name).filter(n => n != null);
    for (const f of files) expect(names).toContain(f);
});
```

### ドキュメント表チェックを test で構造的に守る (phase11.4 / phase15.2 / phase16.1)

新規プラグイン追加時に **「ドキュメントへの言及漏れ」を test で fail させる** 構造的ガードを置くと、phase11.4 (`npmjs` を `[plugins.allowed]` に反映漏れ → 本番 403)、phase15.2 (`kakuyomu` を README プラグイン表に反映漏れ) のような同種の見落としを防げる。

[test/config-example-plugins.test.ts](../../test/config-example-plugins.test.ts) は `config.example.toml` と `docs/deploy-examples/summaly-config.example.toml` の `[plugins.allowed]` を `"<name>"` quoted パターンでチェックする。phase16.1 ではこれを README にも拡張し ([test/readme-plugins.test.ts](../../test/readme-plugins.test.ts))、`` `<name>` `` バッククォート付きトークンで言及されているかを確認する。

**設計パターン**:

- 「言及の有無」だけを保証 (経路列の値 / 対象 URL の正確性は人力レビュー or 詳細ドキュメント側に委ねる)
- コメントアウト行 (`# "dlsite",`) や非推奨注記もパス扱い (運用者が判断で活性化できれば OK)
- エラーメッセージで具体的な修正箇所を案内 (どのファイルのどの表に追記するか)
- 検出ロジックは `src/plugins/*.ts` 直接の `export const name = '...'` 抽出 (`builtinPlugins` import は循環回避のため避ける)

**ドキュメントごとの「言及形式」と検出パターン**:

| ドキュメント | 言及形式 | 検出パターン |
|---|---|---|
| `config.example.toml` / `docs/deploy-examples/summaly-config.example.toml` | TOML 配列の quoted 文字列 | `"<name>"` または `'<name>'` |
| `README.md` プラグイン表 | バッククォート付きトークン | `` `<name>` `` |

新形式のドキュメントを追加する時は、その形式の検出パターンで test ファイルを追加すれば、運用者は「新規プラグイン追加 → `pnpm test` で漏れ検出」の同じ反射神経で守れる。

## ブラウザ UA オーバーライド

サイト固有の UA 切替えを **コアにホストリストを抱えず、プラグイン単位で** 対処する。

```ts
// src/utils/user-agents.ts
export const BROWSER_UA = 'Mozilla/5.0 ... Chrome/130.0.0.0 ...';

// プラグイン側
import { BROWSER_UA } from '@/utils/user-agents.js';
const res = await scpaping(url.href, { ...opts, userAgent: BROWSER_UA });
```

**設計の決め手**:

- mei23 の `NOT_BOT_UA = ['www.sankei.com', 'abema.tv']` 方式は **不採用**。コア側にホストリストの負債を残さない
- バージョン番号は反応的に更新（年1回程度）。コメントに `最終更新: YYYY-MM-DD（Chrome XXX stable）` を付けて陳腐化を可視化

## 短縮 URL の SSRF 限定許可（KNOWN_SHORT_HOSTS）

Fastify モード（`followRedirects: false`）でも、サービス公式の短縮 URL に限り HEAD で URL を解決する dispatcher 改修。

```ts
// src/utils/short-urls.ts
export const KNOWN_SHORT_HOSTS = new Set([
    'youtu.be', 'amzn.to', 'amzn.asia', 'a.co', 'w.wiki', 'spotify.link',
]);

// dispatcher
const shouldResolve = opts.followRedirects || KNOWN_SHORT_HOSTS.has(initialHost);
if (shouldResolve) {
    actualUrl = await got.head(url, { ...opts, maxRedirects: 5 }).then(r => r.url);
}
```

**設計の決め手**:

- **「サービス公式」に限定**: `bit.ly`/`t.co` 等の汎用短縮 URL は SSRF 拡大に繋がるため除外
- **`maxRedirects: 5`**: HEAD リクエストの多段リダイレクトを制限（チェイン攻撃緩和）
- **HEAD 解決失敗は許容**: try-catch で original URL にフォールバック。短縮 URL がデッドリンクでも一般経路として動作する
- **解決後の URL でプラグインマッチング**: `youtu.be/<id>` → `youtube.com/watch?v=<id>` の dispatch が Fastify モードでも自然に動く

## oEmbed プラグインのテスト容易化（phase3.1）

YouTube / Spotify のような oEmbed 直叩きプラグインは「ネットワーク呼出 → JSON パース → Summary 組立」の 3 段で、ネットワーク呼出を mock しないとローカルテストが書けない。

**解決パターン**: `summarize()` を「ネットワーク呼出」と「JSON → Summary 組立」に分け、後者を `buildSummaryFromOEmbed(oEmbed: unknown): Summary | null` として export する。

```ts
export function buildSummaryFromOEmbed(oEmbed: unknown): Summary | null {
    if (typeof oEmbed !== 'object' || oEmbed === null) return null;
    const o = oEmbed as Record<string, unknown>;
    // ナローイングしてフィールドを検証
    if (o.type !== 'video' || typeof o.html !== 'string') return null;
    // ...iframe 抽出 + Summary 組立...
}

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
    const oEmbed = await getJson(buildOEmbedUrl(url), undefined, opts);
    return buildSummaryFromOEmbed(oEmbed);
}
```

利点:
- フィクスチャテスト（モック oEmbed JSON を関数に直接渡す）が `vi.mock` 不要で書ける
- 異常系（type 違い・iframe 偽装 URL・null 入力等）を網羅的にユニットテストできる
- `as any` キャスト不要で `unknown` ナローイングのみで型安全

**iframe src の URL parse 検証**:
`startsWith('https://')` ではなく `new URL(src).protocol !== 'https:'` を try-catch で使う。`https:evil.com` のような偽装を弾けるため防御深度が増す。`general.ts` の `getOEmbedPlayer` と同じパターン。

**`PLAYER_ALLOW_OEMBED` の共有**:
複数プラグインで参照する safelist 配列は `readonly string[]` + `Object.freeze()` で mutate 防止。`Summary.player.allow` への代入時はスプレッド (`[...PLAYER_ALLOW_OEMBED]`) でコピーして参照漏洩を防ぐ。

## DOM 後処理プラグイン（phase3.2）

`scpaping → parseGeneral → 後処理` を各プラグインが自前で呼び、`postProcess` フックは追加しない方針。bluesky と同じパターン。後処理ロジックは `enrichWithXxx(summary, $, landingUrl)` ヘルパとして export し、cheerio をテストで直接ロードしてフィクスチャテストする。

### 落とし穴

1. **`Summary` には `url` フィールドが無い**: `Summary` は `summarize` の戻り値型で、`url` は `summaly()` 出口で `SummalyResult` に追加される。プラグイン内で「結果 URL のパスで sensitive 判定」したい場合は `general(url)` に渡した `url`（または retry で実際に成功した URL）を呼出側で別途保持する必要がある（dlsite で `tryFetch` が `{summary, usedUrl}` を返す形にした）。
2. **`cheerio.text()` は既にエンティティをデコード済み**: その上に `html-entities.decode` を重ねると `&amp;lt;` のような二重エンコードされた値が `<lt>` まで化けるリスクがある。`.text()` の戻り値には `decode` を掛けず `trim()` のみに留める（属性値 `.attr('content')` には decode が必要）。
3. **JSON-LD の制御文字エスケープ**: `\n` だけでなく `\r` `\t` 等 U+0000-U+001F は JSON 中で生で出ると `JSON.parse` が失敗する。一括して `replace(/[\x00-\x1F]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))` で Unicode エスケープに置換する（`no-control-regex` lint は意図的なので disable コメントで抑制）。
4. **404 リトライの無限ループ防止**: `tryFetch(url, opts, alreadySwapped: boolean)` のように再帰の深さをフラグで制限。dlsite の `/announce/` ↔ `/work/` が好例。
5. **API 失敗時の握りつぶし**: ライブラリ責務として `console.log` は出さず、try-catch で fallback パスに静かに戻す。komiflo の `api.komiflo.com` 失敗時の挙動。

## Cloudflare 配下サイトの公式 JSON API 直叩きパターン（phase11.4 / npmjs）

`www.npmjs.com` のように **Cloudflare Bot Management の "managed challenge"** で蓋をされているサイトでは、SummalyBot UA・ブラウザ模倣 UA・正規 bot UA（Discordbot/Twitterbot/Slackbot/facebookexternalhit）すべてで 403 が返る。これは Cloudflare 側で **IP / rDNS まで含めた verified bot 検証** をしているため、HTTP レイヤでは突破不可能（X や Discord で OG が表示されているのは IP allowlist 経由）。

ただし **公式 JSON API（`registry.npmjs.org` 等）は Cloudflare 保護の対象外** であることが多く、`SummalyBot/x.y.z` UA でも素通しで 200 / `application/json` を返してくれる。description / homepage / repository 等のメタが揃っている場合、HTML スクレイプを諦めて API 直叩きで Summary を組み立てる方が確実かつ高速。

### 適用判断のチェックリスト

1. `curl -A SummalyBot/x.y.z https://example.com/...` が 403 / Cloudflare challenge を返す
2. `curl -A SummalyBot/x.y.z https://api.example.com/...` が 200 / JSON を返す
3. JSON に title / description 相当のフィールドが揃っている
4. プラグイン化する URL パターンが特定できる（npm の `/package/<name>` のように）

### サブパスは latest 固定で簡素化

`/package/<pkg>/v/<ver>` `/tutorial` `/security` 等のサブパスでも常に `dist-tags.latest` を返す。upstream の OG にもバージョン別表示は無いため、複雑化を避けて簡素化優先。

### scope 付きパッケージ名のエンコード

`@scope/name` の `/` は `%2F` 必須、`@` は registry 側で生のまま受けてくれる。`encodeURIComponent` だと `%40scope%2Fname` になるが、慣例に合わせて `@` は残し `/` だけ `%2F` に置換 (`pkg.replace('/', '%2F')`) する形が綺麗。

### アイコン陳腐化リスクと対策

npm の固定ハッシュ PNG (`58a19602036db1daee0d7863c94673a4.png`) のような自社 CDN アセットはいつか入れ替わる。リンク切れ検知は別途モニタリング。陳腐化したら GitHub の npm org アバター (`https://avatars.githubusercontent.com/u/6078720?s=200&v=4`) のような外部代替に切り替える。

### テスト戦略

`buildSummaryFromRegistry(body)` を pure 関数として export し、フィクスチャを **直接渡してテスト** する（fastify モックサーバ不要）。spotify / youtube の `buildSummaryFromOEmbed` と同じパターン。`extractPackageName` `buildRegistryUrl` も独立 export してパス組み立ての境界条件を網羅できる。

## 汎用パスの thumbnail/icon 二段フォールバック (phase11.7)

`parseGeneral` で OG/Twitter/image_src/apple-touch-icon が全部無いサイト（個人ブログや古いサイトに多い）への対策として、**HEAD 検証済みの favicon を thumbnail に流用** するパターン。

```ts
const [icon, oEmbed] = await Promise.all([getIcon(), getOEmbedPlayer($, url.href)]);

// OG/Twitter/image_src/apple-touch-icon が全部無い場合、HEAD 検証済みの favicon を採用
const thumbnail = image ?? icon?.href ?? null;
```

### 設計の決め手

- **`getIcon()` の HEAD 検証を再利用**: 別途 HEAD を発行せず、`Promise.all` 後の `icon` を使う。リクエスト数を増やさない
- **`data:` URI / 巨大 favicon の安全策**: `getIcon()` が `<link rel="icon" href="data:...">` を HEAD すると失敗する → `icon: null` → フォールバックも発動しない。安全
- **プラグイン経由は影響なし**: `parseGeneral` 内のみの変更。`amazon` / `wikipedia` / `twitter` 等の独自プラグインは自前で thumbnail を組み立てているので無関係

### `isThinSummary` 側の補正が必須

「favicon フォールバック発動 = `thumbnail === icon`」状態を thin 候補として残すため、`isThinSummary` を補正:

```ts
// 旧: if (summary.thumbnail != null) return false;
// 新: if (summary.thumbnail != null && summary.thumbnail !== summary.icon) return false;
```

これでプラグイン化候補のシグナル品質を phase10.1 と同等に維持する。**機能追加と観測機構の整合性を一緒にメンテしないと検出器の純度が落ちる** という教訓。

### 16×16 favicon の見た目問題はクライアント側責務

favicon が 16×16 だと Misskey クライアントの大きなサムネ枠で拡大表示されてボヤける。「`thumbnail === icon` ならアイコン扱いの小枠表示」のような分岐は Misskey fork 側の責務（summaly の射程外）。

### `.ico` / `.cur` は thumbnail に流用しない (2026-05-08 補正)

phase11.7 の favicon fallback で **`.ico` / `.cur` は `<img>` で broken image** になる問題が判明。Misskey は `summary.icon` を `media-proxy/preview.webp?url=...&preview=1` 経由で ico→webp 変換して表示しているが、**summaly はその proxy ホストを知らない** ため `summary.thumbnail` 自体には素材として `<img>` 直接表示可能なものを返すしかない。

設計判断:

- **`isThumbnailableIcon(icon)` ヘルパで判定** (export、`src/general.ts`):
  - content-type 優先: `image/x-icon` / `image/vnd.microsoft.icon` を blocklist、それ以外の `image/*` を許可
  - content-type 不明: 拡張子で判定 (`.ico` / `.cur` 除外、その他は許可)
  - 拡張子なし path (動的 favicon) は許可 (誤検知より取りこぼし防止優先)
- **`summary.icon` フィールドは ico を残す** (互換性維持): Misskey 等が proxy 経由で ico→webp 変換できる UI もあるため、icon フィールドのセマンティクス「サイトアイコン」を保つ
- **`summary.thumbnail` のセマンティクス**: 「`<img>` に直接貼れる素材」と定義し、proxy が無い利用者 (Mastodon / 任意 client) でも broken image にならない安全側へ寄せる

**summaly のスコープ整理**: 「URL preview メタデータを返すライブラリ」として **「素材は再生可能形式のみ返す」** が責務。proxy URL の組み立ては利用者責務 (proxy ホストは summaly が知らない)。`mediaProxyHint` のような利用者宣言オプションを将来追加すれば proxy 経由 thumbnail も解禁できるが、現状は未対応。

### Next.js `__NEXT_DATA__` を事実上の API として使う (phase15.2 カクヨム、2026-05-08)

公式 API が無いサイトでも、Next.js + Apollo (Relay 風) で SSR されたページなら **HTML 内の `<script id="__NEXT_DATA__" type="application/json">`** に正規化キャッシュ JSON が埋め込まれている。これを parse すれば API 同等の構造化情報が取れる。

実例: カクヨム `kakuyomu.jp/works/<id>` の `__NEXT_DATA__` には `Work:<id>` エンティティ (title / introduction / genre / serialStatus / publicEpisodeCount / isCruel / isSexual / isViolent / tagLabels / ogImageUrl など) が完備されている。`author = { __ref: 'UserAccount:<id>' }` 形式で別エンティティに参照されている部分は、同じ Apollo state 内で `UserAccount:<id>` キーを lookup する。

実装パターン (`src/plugins/kakuyomu.ts` 参照):

```typescript
// 1. cheerio で <script id="__NEXT_DATA__"> の中身を取得
const raw = $('script#__NEXT_DATA__').first().contents().text();

// 2. JSON.parse + try/catch で壊れた JSON を null に
const state = (() => { try { return JSON.parse(raw); } catch { return null; } })();

// 3. Apollo state を再帰探索して `Work:<id>` キーを探す (WeakSet で循環参照ガード)
function findWork(o, target) {
  // ... 再帰 walk、direct[`Work:${id}`] が `__typename: 'Work'` ならヒット
}
```

**設計上の利点**:
- 公式 API 無しでも構造化情報が取れる (HTML scrape より dramatically クリーン)
- フィールド名が直接コードに出るので保守性が高い
- 未知フィールドは `unknown` 型で受けて asString/asNumber/asBoolean ヘルパで narrowing → スキーマ変更耐性

**設計上の落とし穴**:
- Apollo の `__ref` 参照は別エンティティを lookup する必要があり、再帰探索 + 循環参照ガード必須
- `__NEXT_DATA__` の構造はサイトの Next.js 設定次第で大きく変わる (`__APOLLO_STATE__` / `props.pageProps.<key>` 等、固定経路ではない)。**WeakSet 付きの再帰 walk で全ノードを探す**のが現実的
- Next.js のメジャーバージョンアップでフィールド名や正規化方式が変わる可能性 → fallback として OGP scrape を最終手段に置いておく
- PV カウント影響: HTML を取る = サーバはアクセスとしてカウントしうる。`Twitterbot/1.0` UA で叩いて bot 除外を狙う (なろう allcount=0 fallback と同パターン)

### なろうプラグイン: API allcount=0 のとき HTML 専用 scrape にフォールバック (phase13.1 補正、2026-05-08)

phase13.1 で「API 直叩き = PV カウント影響無し」を採用したが、**API の index に載っていない作品** (古い作品 / API 登録漏れ) で `allcount=0` が返るケースが本番ログで観測 (`n3862be` 等)。HTML ページは正常に存在し OGP も完備しているのに preview 不能になる。

3 段フォールバック:

1. **API 直叩き** (`allcount=1`) — 最優先 (PV 影響無し)
2. **HTML scrape (`extractNovelDataFromHtml`)** (`allcount=0` で title or writer が取れる) — `Twitterbot/1.0` UA で叩いて PV カウント除外を狙う
3. **`general()` + Twitterbot UA** (HTML 構造が完全に壊れた場合) — OGP 経路の最終 fallback

HTML から取れるフィールド: `title` / `writer` / `story` / `isr15` / `iszankoku` / `isbl` / `isgl` / `keyword`。取れないフィールド: `genre` / `novel_type` / `end` (HTML には明示されない、API のみで取れる)。`composeDescription` の asString/asNumber が `undefined` を `null` として扱う設計のおかげで「取れないフィールドは undefined のまま」で動作する。

セレクタは fallback テキストマッチを併用してメンテ耐性を高める:

- title: `h1.p-novel__title` → fallback `og:title`
- writer: `.p-novel__author a` → fallback テキスト「作者：xxx」
- マーカー: 本文「〔残酷描写〕」テキストパターンマッチ

抽出関数を `extractNovelDataFromHtml($)` として **pure 化 + export** することで test fixture HTML で容易にテスト可能 (cheerio.load 経由で 9 ケース)。

**SNS bot UA を選ぶ意義**: なろうのアクセス解析は SNS bot UA を PV カウントから除外している前提で、phase13.1 の API 直叩き精神 (PV 影響無し) を構造的に維持できる。phase12.3 (nintendo-store の `facebookexternalhit/1.1` 固定) と同類のパターン。

## 関連

- [object-assign-mutable-target.md](object-assign-mutable-target.md) — オプション扱いの落とし穴
