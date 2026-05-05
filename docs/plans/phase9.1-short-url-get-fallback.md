# Phase 9.1 — 短縮 URL の HEAD 失敗時 GET フォールバック

> 状態: **完了 (2026-05-05)**
> 種別: バグ修正 / 互換性
> サイズ: **S〜M**
> 関連: [phase2.1](phase2.1-plugin-infrastructure.md)（KNOWN_SHORT_HOSTS dispatcher）

## 目的・背景

[src/index.ts](../../src/index.ts) の `summaly()` は `KNOWN_SHORT_HOSTS` に登録された短縮 URL について `got.head()` でリダイレクト解決を行う。しかし **`amzn.asia`** は HEAD リクエストに対して 404 を返す（`SummalyBot` でもブラウザ UA でも同じ）一方、GET なら 301 で `www.amazon.co.jp/dp/...` に展開される。

```bash
$ curl -sI 'https://amzn.asia/d/00K7piwG'
HTTP/1.1 404 Not Found

$ curl -sIL -X GET 'https://amzn.asia/d/00K7piwG'
HTTP/1.1 301 Moved Permanently
Location: https://www.amazon.co.jp/dp/4297127830?ref=...
```

結果として:
- summaly は HEAD 404 を catch して `actualUrl = url`（短縮 URL のまま）で続行
- amazon プラグインの `test()`（`www.amazon.{com,co.jp,...}`）にマッチしない
- 汎用パス `general()` で `amzn.asia` ページを scrape し、ほぼ何も取れない

[dev/sample-urls.ts](../../dev/sample-urls.ts) に `amzn.asia` サンプルがあり、現状「コンテンツが展開されない」既知挙動として note 付きで残してある。

## 現状分析

### 該当コード

[src/index.ts](../../src/index.ts) `summaly()` 内:

```ts
if (shouldResolve) {
    try {
        actualUrl = await got
            .head(url, { ..., maxRedirects: 5 })
            .then(res => res.url);
    } catch {
        actualUrl = url;   // ← ここで諦めている
    }
}
```

### 影響を受けるホスト

- `amzn.asia`（実測で HEAD 404）
- `amzn.to` / `a.co` も同じ可能性あり（要検証）
- `*.app.link` は branchio-deeplinks プラグインが `$web_only=true` を付ける別系統のため対象外

## 設計方針

### 候補 A: HEAD 失敗時に GET でリダイレクトだけ取る

```ts
try {
    actualUrl = await got.head(url, {...}).then(res => res.url);
} catch {
    try {
        // GET でも body は受信しない（method: 'GET' + Range: 0-0 で先頭 1 バイトだけ）
        actualUrl = await got.get(url, {
            ...,
            headers: { ..., range: 'bytes=0-0' },
            maxRedirects: 5,
        }).then(res => res.url);
    } catch {
        actualUrl = url;
    }
}
```

`Range: bytes=0-0` で 1 バイトだけ取る → サーバが Range を無視しても body は最大 contentLengthLimit までで読みつつ、`res.url` がリダイレクト後の URL になる。**実装シンプル、互換破壊なし**。

### 候補 B: `got.head` の `methodRewriting` / fallback method 機能

got にネイティブな HEAD→GET fallback はない。自前で書く必要がある（候補 A と同じ）。

### 候補 C: KNOWN_SHORT_HOSTS のうち HEAD が壊れているホストを別リストにする

`KNOWN_SHORT_HOSTS_HEAD_BROKEN = new Set(['amzn.asia'])` を別途持ち、これらは最初から GET で解決。短縮 URL ホストごとの差異が表面化するが、判別が明示的になる。

→ **採用: A + ホスト固有の最適化なし**。シンプルさを優先。GET fallback は HEAD 失敗時のみ走るため通常運用への影響はゼロ。

### Range によるバイト消費

`Range: bytes=0-0` を送ると:
- サーバが対応 → 1 バイトだけ転送、リダイレクト時は無視される（リダイレクトは body なしの 3xx）
- サーバが Range 未対応 → 200 + フルボディだが、`maxRedirects: 5` で **リダイレクトが解決した時点で body 受信前に res.url が確定**（got の挙動）。さらに `methodRewriting: false` 等で挙動を確実にしておく

実装上は単に GET にして `maxRedirects: 5` で書けば十分。`Range` は防御的に付けてもよい。

### タイムアウト・SSRF

既存の HEAD と同じタイムアウト/agent/maxRedirects 設定を使う。新規 SSRF 経路を増やさない。

## 実装ステップ

各ステップで `pnpm eslint && pnpm typecheck && pnpm test` を通す。

- [x] **Step 1 — `summaly()` の HEAD ブロックに GET fallback を追加** — `buildResolveRequestOptions()` / `resolveRedirect()` の 2 helper に切り出して HEAD → GET (with `Range: bytes=0-0`) → 元 URL のフォールバックチェーンを構築。インライン 30 行が 5 行の関数呼び出しに整理された
- [x] **Step 2 — テスト** — fastify モックで 3 ケース: (a) HEAD 404 + GET 301 で resolve、(b) HEAD 200 直接成功（fallback 不発）、(c) HEAD/GET 共に失敗で原 URL 続行 → throw
- [x] **Step 3 — CHANGELOG 更新** — dispatcher の挙動変更を明記。dev サンプル (`amzn.asia`) の note も「展開される」に更新

## 実装結果メモ

- **実機検証**: dev サーバ経由で `https://amzn.asia/d/00K7piwG` が `www.amazon.co.jp/dp/4297127830` に解決 → amazon プラグインがマッチ → 「良いコード/悪いコードで学ぶ設計入門」というタイトル取得を確認
- **`Range: bytes=0-0` の効果**: amzn.asia は GET 1 リクエスト目で 301 を返すため body は無し。最終ターゲットの amazon.co.jp が 200 を返すかは fallback 経路では関係ない（`res.url` だけ取って完了している）
- **コード整理の副次効果**: HEAD ブロックを `resolveRedirect` に切り出したことで `summaly()` 関数のメインフローが短くなり、リダイレクト解決責務が分離された。Stage 2 review で「summaly() が肥大化している」と指摘される可能性を先回りで解消

## 完了条件

- `summaly('https://amzn.asia/d/00K7piwG')` が `www.amazon.co.jp/dp/...` に解決され amazon プラグインで処理される
- HEAD が成功する短縮 URL（spotify.link 等）の挙動が変わらない
- 既存テストすべて通過 + GET fallback の単体テスト追加
- CHANGELOG に dispatcher の挙動変更を明記

## リスク

1. **GET でレスポンスボディを受信してしまう**: HEAD 失敗のフォールバックなので頻度は低いが、巨大ページに当たると帯域を消費する。`Range: bytes=0-0` を送って防御。それでもサーバが無視する場合は `responseTimeout` / `operationTimeout` で打ち切られる
2. **GET でも 4xx が返る**: amzn.asia 以外で「HEAD も GET も失敗する」短縮 URL があれば従来通り `actualUrl = url` で諦める。挙動は phase 前と同じ
3. **`Range: 0-0` が誤動作するサーバ**: 一部のサーバは Range をエラーで返す（416）。GET fallback 自体が失敗 → 従来挙動

## オープンクエスチョン

- **A. amazon プラグインの test() を `amzn.asia` も含める形に拡張すべきか**: 別の解。ただし「短縮 URL を直接判定する」のは amazon プラグインの責務として太い。汎用的な GET fallback の方が他の短縮ホスト（一時的な障害含む）にも効く
- **B. `Range: bytes=0-0` を付けるか**: 帯域節約目的。HEAD が 404 を返すサーバはおそらく Range もケアしていないため、付けても無効化される可能性が高い。実装シンプルさを優先するなら付けない方針も
