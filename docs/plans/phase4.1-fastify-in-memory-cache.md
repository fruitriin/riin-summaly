# Phase 4.1 — Fastify インメモリ LRU キャッシュ

> 状態: **完了 (2026-05-04)**
> 種別: 機能拡張 / 運用最適化
> サイズ: **M**
> 依存: [phase1.1](phase1.1-fastify-cache-control.md)（`cacheMaxAge` / `cacheErrorMaxAge` オプション）
> 関連 issue: [misskey-dev/summaly#27](https://github.com/misskey-dev/summaly/issues/27)、[mastodon/mastodon#23662](https://github.com/mastodon/mastodon/issues/23662)

## 目的・背景

[phase1.1](phase1.1-fastify-cache-control.md) で `Cache-Control` ヘッダを復活させたが、利用側のクライアント実装次第ではこのヘッダだけでは不十分:

- Misskey が使う Got / node-fetch は `Cache-Control` を**実際にはキャッシュしない**（library レベルで完全な HTTP cache を実装していない）
- リバースプロキシ / CDN / nginx の `proxy_cache` は `Cache-Control` を尊重するため、ヘッダ単独でも前段でキャッシュは効く
- ただし、**summaly サーバ単独（前段プロキシ無し）の運用** では、Got 由来のリクエストが毎回 origin に届いてしまう

本フェーズでは **summaly サーバ自身がプロセス内で結果を保持する LRU キャッシュ機構** を **オプトインで** 提供する。

---

## 現状分析

### 利用側のキャッシュ実装状況（issue #27 の記述から）

- Misskey の Got / node-fetch は `Cache-Control` を実装していない
- nginx / Cloudflare は `Cache-Control` を尊重する
- → 「`Cache-Control` を付けるだけでは不十分。サーバ自身がキャッシュするのが望ましい」が結論（mei23）

### 前提

[phase1.1](phase1.1-fastify-cache-control.md) で導入された:
- `SummalyOptions.cacheMaxAge?: number`（成功 TTL、デフォルト 604800）
- `SummalyOptions.cacheErrorMaxAge?: number`（エラー TTL、デフォルト 3600）

これらの値を **インメモリキャッシュの TTL としてそのまま流用** する。

---

## 設計方針

### API 設計

```ts
type SummalyOptions = {
    // ... phase1.1 で追加 ...
    cacheMaxAge?: number;
    cacheErrorMaxAge?: number;

    /**
     * Fastify モードでサーバー自身が LRU ベースのインメモリキャッシュを持つかどうか。デフォルト false。
     * true にすると、cacheMaxAge 内の同一 URL リクエストは origin に到達せず、サーバー内のキャッシュから返す。
     */
    inMemoryCache?: boolean;

    /** インメモリキャッシュの最大エントリ数。デフォルト 1000 */
    inMemoryCacheMaxEntries?: number;
};
```

### キャッシュキー

- 正規化された URL + `'\0'` + `lang || ''`
- フラグメント除去（`url.hash` を捨てる）。**過剰な正規化（クエリ順、トレーリングスラッシュ等）は別 issue で扱う**（過剰正規化はキャッシュヒット率と引き換えに「異なる結果を返すべき URL」を同一視するリスクを生む）
- `lang` を含めるのは「日本語ユーザーの結果を英語ユーザーに返す」汚染を防ぐため

### キャッシュエントリ

- 値: `SummalyResult` をそのまま保持（シリアライズしない）
- エラー結果も別キーでキャッシュ（壊れ URL への連続リクエストを増幅させない）
- TTL は `cacheMaxAge`（成功）/ `cacheErrorMaxAge`（エラー）を流用

### LRU 実装

- `lru-cache` パッケージを採用（既に Node エコシステムで広く使われ、型もしっかりしている）
- `max: inMemoryCacheMaxEntries`（エントリ数で上限）
- `ttl: cacheMaxAge * 1000`（ミリ秒換算）
- メモリ消費は読みづらいので、**バイト単位ではなくエントリ単位で上限**（運用しやすい）

### `X-Cache: HIT/MISS` ヘッダ

レスポンスに `X-Cache: HIT` または `X-Cache: MISS` を付与:

- ヒット時: `X-Cache: HIT`
- ミス時: `X-Cache: MISS`
- インメモリキャッシュ無効時: ヘッダを付けない

これにより運用者が「キャッシュが効いているか」を確認できる。nginx 側からも参照可能。

### Fastify ハンドラの構造

```ts
fastify.get('/', async (req, reply) => {
    const url = req.query.url as string;
    const lang = req.query.lang as string | undefined;
    if (url == null) { /* 400 */ }

    const cache = options.inMemoryCache ? getOrCreateCache(options) : null;
    const cacheKey = cache ? normalizeKey(url, lang) : null;

    if (cache && cacheKey) {
        const hit = cache.get(cacheKey);
        if (hit) {
            reply.header('Cache-Control', `public, max-age=${options.cacheMaxAge ?? 604800}`);
            reply.header('X-Cache', 'HIT');
            return hit.value;
        }
    }

    try {
        const summary = await summaly(url, { lang, followRedirects: false, ...options });
        if (cache && cacheKey) {
            cache.set(cacheKey, { value: summary }, { ttl: (options.cacheMaxAge ?? 604800) * 1000 });
        }
        reply.header('Cache-Control', `public, max-age=${options.cacheMaxAge ?? 604800}`);
        if (cache) reply.header('X-Cache', 'MISS');
        return summary;
    } catch (e) {
        if (cache && cacheKey) {
            cache.set(cacheKey, { error: serializableError(e) }, { ttl: (options.cacheErrorMaxAge ?? 3600) * 1000 });
        }
        reply.header('Cache-Control', `public, max-age=${options.cacheErrorMaxAge ?? 3600}`);
        if (cache) reply.header('X-Cache', 'MISS');
        return reply.status(500).send({ error: e });
    }
});
```

---

## 実装ステップ（チェックリスト）

各ステップで `pnpm eslint && pnpm test` を通す。

- [x] **Step 1 — `lru-cache` 依存追加**
  - `package.json` の `dependencies` に `lru-cache`（最新安定版）を追加
  - 型定義の動作確認（`@types/lru-cache` は v10 以降で同梱）
- [x] **Step 2 — キャッシュインスタンスの初期化**
  - Fastify プラグイン関数内で `options.inMemoryCache` が truthy のときだけ `LRUCache` を生成
  - max は `options.inMemoryCacheMaxEntries ?? 1000`
  - 同じ Fastify プラグインの 2 回目以降の register でも同じインスタンスを使う（プラグインスコープ内 singleton）
- [x] **Step 3 — キャッシュルックアップ・保存ロジック**
  - 上記「Fastify ハンドラの構造」の通り実装
  - キャッシュキー正規化関数 `normalizeKey(url, lang)` を抽出
  - エラーをシリアライズ可能な形に変換するヘルパ `serializableError(e)`
- [x] **Step 4 — `X-Cache` ヘッダ**
  - HIT / MISS で適切に付与
  - インメモリキャッシュ無効時はヘッダを付けない
- [x] **Step 5 — テスト**
  - 同一 URL 2 回目で origin への HEAD リクエストが発生しないこと（モック origin で確認）
  - `X-Cache: HIT` / `MISS` が正しく付与されること
  - TTL 経過後に再リクエストが origin に届くこと（タイマーモック）
  - エラーキャッシュが `cacheErrorMaxAge` で切れること
  - `lang` 違いで別キーになること
  - `inMemoryCacheMaxEntries: 2` で 3 件目を入れたとき LRU で古いものが evict されること
- [x] **Step 6 — README / CHANGELOG 更新**
  - 新オプション `inMemoryCache` / `inMemoryCacheMaxEntries` の説明
  - 「summaly サーバ運用時のキャッシュ戦略」節に追記（前段プロキシ vs インメモリ vs 両方）
  - 「キャッシュはプロセス再起動で消える」旨を明記
  - issue #27 の参照を追加

---

## 完了条件 (Definition of Done)

- `inMemoryCache: true` で同一 URL の 2 回目アクセスがキャッシュから返る
- `X-Cache: HIT` / `MISS` ヘッダで HIT/MISS が確認できる
- TTL 経過後にキャッシュが切れる
- `lang` 違いはキャッシュ別エントリ
- LRU エントリ上限を超えると古いものが evict される
- 既存ユーザーの呼び出しが破壊的変更を受けていない（`inMemoryCache` 未指定なら従来通り）
- `pnpm build && pnpm eslint && pnpm test` が通る
- README に新オプションと運用ガイドが反映されている

---

## リスク・注意点

1. **キャッシュ汚染**: 5xx（一時的サーバ障害）の結果も TTL 中はキャッシュされる。`cacheErrorMaxAge` が短い（デフォルト 1 時間）ことで影響を最小化。将来的には「5xx は短く / 4xx は長く」と分ける拡張も検討可能
2. **メモリ消費**: `inMemoryCacheMaxEntries: 1000` がデフォルトとして妥当か運用次第。1 エントリ数 KB 仮定で 1000 エントリで数 MB。これを超える運用が出てきたら設定可能であることを README で強調
3. **キャッシュキーの正規化**: 第一版ではフラグメント除去のみ。クエリ順正規化等は別 issue で扱う（過剰正規化のリスクを避ける）
4. **プロセス再起動でキャッシュ消失**: 仕様。永続キャッシュは別実装（要望が出てきたら別フェーズで Redis 等を検討）
5. **`lru-cache` のバージョン**: v10 以降は型定義同梱、API も整理されている。古いバージョンは API が違うので注意
6. **競合**: 同じ URL に同時リクエストが来た場合、両方が origin にリクエストを発行してしまう（thundering herd）。本フェーズでは扱わない（in-flight dedup を入れたければ将来 issue）
