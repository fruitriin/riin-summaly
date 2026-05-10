# age-gate / redirect-gate サイト突破の 2 段防御パターン

> なろう R-18 (`novel18.syosetu.com`) で踏んだ年齢確認ゲートを契機に整理した、サイト側が意図的に挟む redirect ゲートを突破するパターン。コミット 8ad0afc。

## 課題: 意図的な redirect ゲートで preview が壊れる

R-18 サイト・年齢確認サイト・地域制限サイト等は、初回アクセス時にユーザーに同意を求める **redirect ゲート** を挟むことが多い。

### 症状 (なろう R-18 の例)

`https://novel18.syosetu.com/n8344gr/` に `SummalyBot/x.y.z` UA で GET すると:

```
HTTP/1.1 302 Found
Location: https://nl.syosetu.com/redirect/ageauth/?url=https%3A%2F%2Fnovel18.syosetu.com%2Fn8344gr%2F&hash=<hex>
```

- `summaly()` 冒頭の HEAD probe (`followRedirects`) が redirect を解決
- 解決後の URL (`nl.syosetu.com/redirect/ageauth/...`) で対象プラグインの `test()` が外れる (元 URL とは別ドメイン / 別パスのため)
- `general()` フォールバックが年齢確認ページの OGP を scrape
- 結果: `title: "年齢確認"` / `sitename: "nl.syosetu.com"` / `description: null` という壊れた preview を返す

これは bot block (UA で内容が変わる WAF) とは別の症状で、**「サイト側が意図的に挟むリダイレクト」** という分類。

## 突破パターン (2 段防御)

### 対策 1 (主): `skipRedirectResolution = true` で HEAD probe を skip

`SummalyPlugin` interface に既存の機構: プラグインが `export const skipRedirectResolution = true` を宣言すると、`summaly()` は HEAD probe を行わず原 URL でプラグイン dispatch する。

```typescript
// src/plugins/syosetu.ts
export const name = 'syosetu';
export const skipRedirectResolution = true;

export function test(url: URL): boolean { ... }
export async function summarize(url: URL, opts?) { ... }
```

これだけで上記症状は解決する (原 URL で test() が当たり、API 直叩き経路に乗る)。

`summaly()` 側 (`src/index.ts` L508 付近) で:
```typescript
const skippingPlugin = plugins.find(p =>
  p.skipRedirectResolution === true && p.test(initialUrl as URL)
);
```
で初期 URL にマッチするプラグインがあれば redirect 解決をスキップする。

### 対策 2 (defense-in-depth): redirect 後 URL を test() でマッチさせて unwrap

何らかの経路で redirect 後の URL (例: `https://nl.syosetu.com/redirect/ageauth/?url=<encoded>`) が **直接 summaly に渡された場合**の救援。Misskey 側の URL 正規化仕様変更や、ユーザーが redirect 後の URL をコピペしたケースで起きうる。

`?url=` 等のクエリパラメータから元 URL を取り出す `unwrap` 関数を追加し、`test()` / `extractMetadata` の冒頭で実行する:

```typescript
const AGE_AUTH_HOST = /^nl\.syosetu\.com$/;
const AGE_AUTH_PATH = /^\/redirect\/ageauth\/?$/;

/** ageauth URL なら `?url=` から元 URL を取り出して返す。それ以外は入力そのまま。
 * `?url=` が壊れている / 不正なら null を返す (test() で false) */
export function unwrapAgeAuthUrl(url: URL): URL | null {
  if (!AGE_AUTH_HOST.test(url.hostname) || !AGE_AUTH_PATH.test(url.pathname)) return url;
  const inner = url.searchParams.get('url');
  if (inner === null || inner === '') return null;
  try {
    return new URL(inner);
  } catch {
    return null;
  }
}

export function test(url: URL): boolean {
  const target = unwrapAgeAuthUrl(url);
  if (target === null) return false;
  // 以後 target で test 判定
  if (!HOST_REGULAR.test(target.hostname) && !HOST_R18.test(target.hostname)) return false;
  return PATH_PATTERN.test(target.pathname);
}

export async function summarize(url: URL, opts?) {
  // 元 URL で metadata 取得 + player URL 組み立て (Mi 側に渡る player URL も原 URL ベースになる)
  const resolvedUrl = unwrapAgeAuthUrl(url) ?? url;
  // ...
}
```

### 対策 3 (補完): bot allowlist UA を活用

サイトによっては SNS 共有用に bot UA (`Twitterbot/1.0`, `facebookexternalhit/1.1`) を allowlist してゲートを素通しすることがある。`scpaping()` で HTML を取りに行く経路 (例: 公式 API + 一部だけ HTML scrape) では bot UA を採用する:

```typescript
async function fetchNovelFromHtml(url: URL, opts?) {
  // なろう側は Twitterbot/1.0 を allowlist しているため、age-gate が発動しない + PV カウント除外
  const res = await scpaping(url.href, { ...opts, userAgent: 'Twitterbot/1.0' });
  return extractNovelDataFromHtml(res.$);
}
```

bot allowlist は `curl -A '<UA>' -I '<URL>'` で事前検証する (302 → 200 に変わるか確認)。

### 採用判断マトリクス

| 状況 | 対策 1 (skipRedirectResolution) | 対策 2 (unwrap) | 対策 3 (bot UA) |
|---|:---:|:---:|:---:|
| 公式 API 直叩きで完結 (HTML 不要) | **必須** | 推奨 (defense-in-depth) | 不要 |
| HTML scrape が必要 (公式 API なし) | 必須 | 推奨 | **必須** (UA 偽装で gate 素通し) |
| API + HTML 部分使用 (chapter title 等) | 必須 | 推奨 | **必須** (HTML 経路だけ) |

対策 2 単独 (= 対策 1 を入れない) は、HEAD probe の段階で redirect が解決され、解決後 URL を unwrap するロジックが無いと preview が壊れたままになる。**対策 1 が主 + 対策 2 は補助**。

## プロジェクトへの適用

### 新規 age-gate / redirect-gate サイトを発見したら

1. **症状の確認**: 通常 GET で 302 が返り、Location が gate ページに向く
   ```bash
   curl -sI '<URL>' -H 'User-Agent: SummalyBot/x.y.z' | head -10
   ```
2. **bot allowlist の有無を確認**: 各種 bot UA で 302 が消えるか試す
   ```bash
   for ua in 'Twitterbot/1.0' 'facebookexternalhit/1.1' 'over18=yes:cookie'; do
     echo "=== $ua ==="
     curl -sI '<URL>' -H "User-Agent: $ua" -H "Cookie: over18=yes" | head -3
   done
   ```
3. **対策 1 を実装** (`export const skipRedirectResolution = true`)
4. **HTML scrape が必要な経路があるか確認** → 必要なら bot UA を `scpaping` 経由で渡す (対策 3)
5. **対策 2 (unwrap) を defense-in-depth で実装** + test() / extract* で適用
6. **テスト 4 件**: gate URL の test() マッチ / inner 非対象パスで false / `?url=` 欠如で false / extract* で元 URL に unwrap

### 既存サイトの仕様変更で gate が新たに挟まれたら

- 既に `skipRedirectResolution` 宣言済みのプラグインなら影響なし (HEAD probe が走らない)
- 未宣言プラグインで preview が `title: "..."` / `sitename: "<gate host>"` のパターンに化けたら age-gate / redirect-gate 化を疑う
- `parse-failure-log.jsonl` の `groupKey` が gate ホスト (例: `nl.syosetu.com/redirect/ageauth`) になっていれば確定

## 注意点・制約

- **`skipRedirectResolution = true` は短縮 URL 経路を切る**: 短縮 URL (`amzn.asia/d/...` 等) を扱うプラグインで `skipRedirectResolution` を宣言すると、HEAD probe で短縮 URL → 元 URL の解決が走らなくなり、test() で短縮 URL を直接マッチさせる必要が出る。なろうは短縮 URL を提供していないので問題なし
- **対策 2 の `?url=` パラメータはサイトごとに名前が違う**: `?url=` (なろう) / `?return_url=` / `?next=` 等。各サイトの実装に合わせて regex / クエリ key を決める
- **bot UA の倫理判断**: `Twitterbot/1.0` を名乗るのは「**bot allowlist で素通しさせるため**」であって、Twitter のクローラーであると偽装する目的ではない。User-Agent 文字列は HTTP プロトコル上 hint であり、サイト側が allowlist で素通しさせている時点で bot UA の使用は許容されている設計。一方、CAPTCHA や WAF を意図的に回避するための完全偽装は別問題 (curl_cffi 等の TLS 偽装と組み合わせた場合に倫理的注意が必要、`curl-cffi-tls-impersonation.md` 参照)
- **対策 2 の SSRF リスク**: `?url=` パラメータの inner URL を `new URL(inner)` で parse → そのまま fetch すると open SSRF になりうる。**unwrap 後の URL に対して必ず元プラグインの test() を再適用**して、想定ホスト/パスのみ通すこと
- **redirect 解決系のテスト**: `followRedirects: false` を明示してリトライ機構や redirect 解釈を切り出して unit test できる (bot-block-ua-retry.md でも同パターン使用)

## 実装事例

| プラグイン | gate ホスト / パス | 採用対策 | sitename / sensitive |
|---|---|---|---|
| `syosetu` (なろう、phase13.1) | `nl.syosetu.com/redirect/ageauth/?url=...` (R-18 サブドメインのみ) | 1 + 2 (公式 API 経路) | R-18 ドメインで `sensitive: true` |
| `dmm` (DMM/FANZA、phase15.3) | `www.dmm.co.jp/age_check/=/?rurl=...` (**全サブドメインで挟まる**、`Vary: User-Agent`) | 1 + 3 (HTML scrape + `facebookexternalhit/1.1` UA allowlist) | 全サブドメインが age_check 経由のため `sensitive: true` 固定 |
| `nintendo-store` (My Nintendo Store、phase12.3) | Akamai Bot Manager の challenge ページ (= 仕組みは違うが allowlist 構造は同じ) | 3 単独 (HEAD probe は SummalyBot UA でも 302 されないため対策 1 不要) | sitename は OGP 任せ |

**DMM ケースの注意点**: 全サブドメインで `Vary: User-Agent` ベースの age_check が挟まるため、HEAD probe (`SummalyBot` UA で送信) が必ず gate URL に書き換わる → 対策 1 (`skipRedirectResolution = true`) が **必須**。対策 3 単独だと `summaly()` 入口の resolveRedirect 段で URL が age_check に書き換わって `test()` がマッチしなくなる失敗パターンになる。一方 nintendo-store は HEAD probe が SummalyBot UA でも 200 を返してくれるため対策 1 不要。**サイトの redirect 挙動 (HEAD vs GET / UA 別の挙動) を事前に curl 検証して必要な対策の組み合わせを決定する** こと。

## 参照

- [src/plugins/syosetu.ts](../../src/plugins/syosetu.ts) — `skipRedirectResolution` + `unwrapAgeAuthUrl` の実装
- [src/plugins/dmm.ts](../../src/plugins/dmm.ts) — `skipRedirectResolution` + bot UA allowlist (対策 1 + 3) の組み合わせ実装
- [src/plugins/nintendo-store.ts](../../src/plugins/nintendo-store.ts) — bot UA allowlist 単独 (対策 3 単独) の実装
- [src/iplugin.ts](../../src/iplugin.ts) — `skipRedirectResolution?: boolean` interface
- [src/index.ts](../../src/index.ts) L508 周辺 — `skipRedirectResolution` を見る dispatch ロジック
- [src/plugins/yodobashi.ts](../../src/plugins/yodobashi.ts) / [src/plugins/sqex.ts](../../src/plugins/sqex.ts) / [src/plugins/nitori.ts](../../src/plugins/nitori.ts) — `skipRedirectResolution = true` の他事例 (ただし TLS 切断対策が主目的、age-gate ではない)
- [docs/knowhow/bot-block-ua-retry.md](bot-block-ua-retry.md) — bot UA / フォールバック UA の関連知見
- [docs/knowhow/curl-cffi-tls-impersonation.md](curl-cffi-tls-impersonation.md) — TLS フィンガープリント偽装で WAF を抜ける別経路
- コミット 8ad0afc — syosetu age-gate 対策の実装
