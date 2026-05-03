# 結果 sanitize と HTTP agent 設計

phase2.2 で導入した「結果 URL の sanitize」「keep-alive デフォルト agent」「`useRange` / `allowedPlugins`」の設計判断を残す。

## 結果 URL の sanitize（最終リターン直前で適用）

[src/utils/sanitize-url.ts](../../src/utils/sanitize-url.ts) で `https:` / `http:` / `data:`（10KB 以下）のみ通す。

**設計の決め手**:

1. **適用ポイントは最終リターン直前の 1 箇所のみ**: プラグイン側で sanitize を呼ばず、汎用パスとプラグインパスを問わず `summaly()` 出口で集約フィルタする。プラグインの実装ミスで `javascript:` URL が漏れても安全
2. **`data:` は許可するが長さ上限を厳守**: 将来の PDF アイコン用途を見据えて完全 reject はしない。**バイト長 (`Buffer.byteLength`) で判定**（文字長だと URL エンコードされた非 ASCII でブレる）
3. **`player.url` が null になったら player 全体をリセット**: `url=null` なのに `allow=['fullscreen', ...]` が残ると利用側が誤って permission を付与する可能性がある。セキュリティを最大化する原則として「URL が信頼できないなら **そのコンテキスト全体を信頼しない**」
4. **`medias[]` は filter で空要素を除去**: `null` を配列に残さず、利用側が `medias.length === 0` で判定できるようにする

## keep-alive デフォルト agent

[src/utils/agent.ts](../../src/utils/agent.ts) で `http.Agent` / `https.Agent` を `keepAlive: true` で生成し、[src/utils/got.ts](../../src/utils/got.ts) の `getEffectiveAgent()` で fallback として使う。

**設計の決め手**:

1. **`setAgent` で外部 agent が来ていたらそちらを優先**: 既存の API 互換性を保ち、プロキシ用途にも対応
2. **SSRF ガードと agent fallback で同じ判定（`isExternalAgentSet()`）を共有**: `Object.keys(agent).length > 0` のロジックを 2 箇所に書かないことでドリフト防止
3. **テスト後の cleanup（`destroyDefaultAgents()`）が必須**: keep-alive ソケットを閉じないと vitest プロセスがハングする。`afterAll` で必ず呼ぶ
4. **`SUMMALY_FAMILY=4`/`=6` で IP family を強制**: mei23 互換、IPv6 only 環境での運用に対応

## `useRange` オプション

`Range: bytes=0-N-1` で先頭 N バイトのみ取得。サーバが Range 未対応なら 200 OK でフルボディが返るため、既存の `contentLengthLimit` ガードで保護される。

**設計の決め手**:

1. **Range の end と `contentLengthLimit` を一致させる**: 「どこまで読むか」の数字を 1 箇所（`DEFAULT_MAX_RESPONSE_SIZE` または `opts.contentLengthLimit`）に集約
2. **GenericScrapingOptions まで透過**: `summaly` → `general` → `scpaping` → `getGotOptions` のチェーンで `useRange` を全て受け渡す。1 箇所でも漏れると Range が送られない（実装中に発覚し追加修正した）

## `allowedPlugins` オプション

`undefined` = 全有効、`string[]` = オプトイン許可リスト、`[]` = 組み込み全 disable。

**設計の決め手**:

1. **組み込みプラグインのみフィルタ対象**: `opts.plugins`（外部プラグイン）はカスタム性を尊重してフィルタしない（導入者責任）
2. **`name` を持たない外部プラグインは自動的に除外**: `p.name != null && allowedPlugins.includes(p.name)` 条件で安全に弾ける
3. **空配列 `[]` の意味を明確化**: 「組み込み全 disable」が意図的に呼べる選択肢として保持。汎用パスのみで運用したいケース用

## Fastify インメモリ LRU キャッシュ（phase4.1）

`lru-cache@11` を使い `inMemoryCache: true` でオプトイン提供。`Cache-Control` を解釈しない HTTP クライアント (Got / node-fetch) でもサーバ単独で重複リクエストを抑制できる。

**設計の決め手**:

1. **キー区切り文字は NULL byte (`\0`)**: `lang` クエリに空白を含む不正値が来てもキー衝突しない。半角スペースだと「URL 末尾スペース + lang」と「URL + lang 先頭スペース」が同一キーになり偽ヒットの危険
2. **エラーをキャッシュする際は plain object に正規化**: `Error` インスタンスを直接保存すると `JSON.stringify` で `{}` になりレスポンスから情報が消える。`{ message, name }` に変換し、HIT/MISS 両方で同じシリアライズ結果になるよう MISS 側でも同じ変換を適用
3. **TTL はコンストラクタに渡さず set() ごとに指定**: 成功 / エラーで TTL が違うため、コンストラクタに既定 TTL を渡すと「全エントリこの TTL」と誤読される。各 `set(key, value, { ttl })` で指定して意図を明示
4. **キャッシュキーの正規化はフラグメント除去のみ**: クエリ順正規化等はキャッシュヒット率と引き換えに「異なる結果を返すべき URL」を同一視する危険があるため第一版では行わない
5. **5xx エラーキャッシュの罠を README に明記**: サーバ復旧後も TTL 切れまでエラーが返り続ける挙動。インメモリキャッシュは「再起動で消える」点が外部キャッシュと異なるため運用者向けに警告を書く
6. **thundering herd は意図的に未対応**: 同時リクエストはそれぞれ origin に到達する。dedup の複雑さを避け、単純な LRU のみで第一版完結

## PDF レスポンス対応のハング対策5層（phase5.1）

`pdf-parse@2` で PDF からタイトル取得をオプトイン提供。ハング・メモリ膨張のリスクが高いため多段防衛を入れる。

| 層 | 対策 | 実装ポイント |
|---|---|---|
| ① 受信前 | `contentLengthLimit` (デフォルト 10 MiB) | content-length ヘッダ + downloadProgress で超過を検出して `req.cancel()` |
| ② 受信中 | `useRange` 併用で先頭領域だけ取得 | サーバが Range 未対応なら通常 GET にフォールバック |
| ③ パース直前 | pdf-parse v2 の `getInfo()` のみ呼ぶ | 「1 ページのみパース」より安全（document-level metadata だけ読む、本文ページのテキスト解析は走らない）|
| ④ パース時 | `withTimeout(getInfo(), 5000)` | `Promise.race` + finally で setTimeout を必ず clear（リーク防止）、エラー経路でも `parser.destroy()` を呼ぶ |
| ⑤ ランタイム | `enablePdf: true` または `SUMMALY_ENABLE_PDF=true` | デフォルト無効。関数オプションが環境変数より優先 |

### withTimeout のリーク防止パターン

`Promise.race([promise, timeoutPromise])` は race の勝者が決まっても **負けた側が破棄されない** (Promise はキャンセル不可)。setTimeout を clear せずに置くと:

- vitest が「open handle」警告を出す
- Node プロセスが timer リファレンスで shutdown が遅れる

正しいパターン:

```ts
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message = 'timeout'): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutHandle != null) clearTimeout(timeoutHandle);
    }
}
```

汎用的なヘルパとして export しておくとユニットテストも書きやすい（永遠に解決しない promise + 短い timeout で reject 確認、即解決 promise + 長い timeout で leak 防止確認）。

### 動的 import のコスト

`pdf-parse` (`pdfjs-dist` 約 30 MB) は `await import('pdf-parse')` で初回だけロード。コールドスタートではなく **最初の PDF リクエスト** に数十ミリ秒の追加レイテンシが乗ることを README に明記する。

### Buffer / Uint8Array の互換性

Node の `Buffer` は `Uint8Array` のサブクラスなので、`buffer instanceof Uint8Array` は常に true。`new Uint8Array(buffer)` 変換は dead code になる。`PDFParse({ data: buffer })` のような API には Buffer をそのまま渡せる。

## 関連

- [object-assign-mutable-target.md](object-assign-mutable-target.md) — オプション扱いの落とし穴
- [plugin-infrastructure-patterns.md](plugin-infrastructure-patterns.md) — getJson / name / BROWSER_UA / KNOWN_SHORT_HOSTS（phase2.1）
