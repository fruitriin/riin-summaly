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

## 関連

- [object-assign-mutable-target.md](object-assign-mutable-target.md) — オプション扱いの落とし穴
