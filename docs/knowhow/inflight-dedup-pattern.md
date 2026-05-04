# in-flight リクエスト dedup パターン（thundering herd 緩和）

> phase4.2 で導入。Fastify ハンドラに「同 URL の並列リクエストを 1 本化」する仕組みを入れたときの設計知見。

## 問題: キャッシュ完成前の並列リクエストは origin に集中する

LRU キャッシュ（phase4.1）も `Cache-Control` ヘッダ（phase1.1）も「先頭リクエストが完了してから」しか効かない。Misskey のユーザーストリーミングのように 1 本のリンクが瞬時に多数のクライアントから引かれるケースでは、**先頭リクエストが origin にスクレイピング中** に来た N 並列リクエストが全て origin に到達してしまう。origin から見ると DDoS 同然。

## 解決: in-flight Map に Promise を共有する

```ts
const inFlight = new Map<string, Promise<CacheEntry>>();
```

ハンドラのフロー:
1. **LRU HIT** → そのまま返す（既存）
2. **LRU MISS かつ in-flight に同 key の Promise** → その Promise を `await` して結果を返す（origin には行かない）
3. **両方 miss** → 新規 Promise を `inFlight.set(key, ...)`、settle 後に LRU `set()` + `inFlight.delete(key)`

## 設計判断

### 判断 1: Promise の resolve 値にエラーを埋め込む（reject させない）

「エラー時は Promise が reject で全 waiter に伝搬」を素直に書くと、`try/finally` 内の `let entry: CacheEntry` が definite-assignment 違反になり ESLint の `no-non-null-assertion` を踏む。

代わりに **`Promise<CacheEntry>` の resolve 値に成功/エラーをタグ付き union で持たせる**:

```ts
type CacheEntry =
  | { kind: 'success'; value: SummalyResult }
  | { kind: 'error'; error: unknown };

const fetchEntry = async (): Promise<CacheEntry> => {
  try {
    const summary = await summaly(url, { ... });
    return { kind: 'success', value: summary };
  } catch (e) {
    return { kind: 'error', error: serializableError(e) };
  }
};
```

`fetchEntry` が常に resolve するため:
- `try/finally` 不要 → ESLint の警告を踏まない
- 全 waiter が同一の `errorPayload` を確実に受け取る（`Error` の serialize は leader 1 箇所のみ）
- LRU にもエラーをそのままキャッシュできる（成功と同じパスで `cache.set`）

### 判断 2: LRU set → inFlight delete の順序

順序が逆だと「LRU 未書き込み・inFlight 削除済み」の窓で、新規リクエストが MISS 経路に入って origin を叩いてしまう。先に LRU を埋めてから delete することでヒット率を最大化する。

`fetchEntry` が throw しないなら `try/finally` を使わず線形に書ける:

```ts
const promise = fetchEntry();
inFlight.set(cacheKey, promise);
const entry = await promise;
if (cache) cache.set(cacheKey, entry, { ttl });
inFlight.delete(cacheKey);
```

### 判断 3: dedup と LRU は独立した有効化フラグにする

「キャッシュは要らないが dedup は欲しい」要望に応えるため `inFlightDedup` と `inMemoryCache` を独立フラグに。dedup 単独でも「並列の集中だけは抑える」効果があり、kacheless 運用の選択肢が広がる。

両方 OFF のときのみ X-Cache ヘッダ非付与（既存互換）。`emitCacheHeader = cache != null || inFlight != null` で 1 箇所で判定する。

### 判断 4: dedup のスコープは Fastify ハンドラレベルだけ

ライブラリ (`summaly()` 関数) レベルで dedup すると、異なる呼出元が異なる opts で呼んだとき（lang 違いなど）の判定が複雑になる。Fastify ハンドラレベルだけに留めることで「URL + lang」のシンプルな key で済む。

JSDoc で「Fastify モード**専用**、`summaly()` 関数に渡しても無視される」を明記して誤用を防ぐ。

## X-Cache ヘッダの拡張

| 状態 | X-Cache | 意味 |
|---|---|---|
| LRU HIT | `HIT` | キャッシュから返した |
| in-flight 待ちで完了 | `HIT-COALESCED` | 並列リクエストの先頭結果を共有した（dedup 効果あり） |
| 完全な MISS | `MISS` | 自分が origin に行った |
| dedup・LRU 共に無効 | （ヘッダなし） | 既存挙動 |

`HIT-COALESCED` を追加することで運用者が「dedup がどれくらい効いているか」を可視化できる。

## テストパターン: ワーストケース dedup 検証

`Promise.all` で 5 並列リクエストを同期的に発射し、origin 側に 200-300ms の `setTimeout` ディレイを入れる:

```ts
async function setupSlowOriginAndProxy(opts: { delayMs?: number; failWith?: number }) {
  app.get('/', async (_req, reply) => {
    originHits++;
    await new Promise(r => setTimeout(r, opts.delayMs ?? 200));
    return reply.send(content);
  });
  ...
}

test('5 並列リクエストで origin ヒットは 1 件、4 件は HIT-COALESCED', async () => {
  const responses = await Promise.all(Array.from({ length: 5 }, () =>
    proxyApp!.inject({ method: 'GET', url: '/', query: { url: host } })));
  expect(getOriginHits()).toBe(1);
  const cacheHeaders = responses.map(r => r.headers['x-cache']).sort();
  expect(cacheHeaders).toEqual(['HIT-COALESCED', 'HIT-COALESCED', 'HIT-COALESCED', 'HIT-COALESCED', 'MISS']);
});
```

`Promise.all` で同期的に `inject` を起動するため、**全 5 リクエストが先頭の Promise 登録より前に来ることはない** が、Fastify の inject はマイクロタスクで進むため、N 並列が in-flight Map を確実に共有する。フレーキー要素はない。

エラー伝搬テストは origin が 500 を返すサーバを `failWith: 500` でセットし、3 並列で全 waiter が同じ error を受け取ることを確認する。

## 既存テストへの影響

`inFlightDedup` デフォルト true により X-Cache ヘッダがデフォルトで付与されるため、既存の「inMemoryCache 未指定で X-Cache が付かない」テストは `inMemoryCache: false, inFlightDedup: false` を両方明示する形に書き換えが必要。CHANGELOG に「X-Cache ヘッダの追加が純粋な互換性影響だが改善方向」と明記して Breaking Change と見做さない判断を残しておく。

## 参考

- [docs/plans/phase4.2-inflight-dedup.md](../plans/phase4.2-inflight-dedup.md) — 設計プラン
- [src/index.ts](../../src/index.ts) — Fastify ハンドラ実装（`fetchEntry` / `inFlight` / `respondWithEntry`）
- [test/index.test.ts](../../test/index.test.ts) — `describe('Fastify in-flight dedup (phase4.2)')`
