# Phase 1.1 — Fastify Cache-Control の即修正（退化修正）

> 状態: **完了 (2026-05-03)**
> 種別: バグ修正 / 退化修正
> サイズ: **XS**
> 関連 issue: [misskey-dev/summaly#27](https://github.com/misskey-dev/summaly/issues/27)
> 依存: なし（最優先で着手可能）
> 後続: [phase4.1-fastify-in-memory-cache.md](phase4.1-fastify-in-memory-cache.md)（インメモリ LRU 拡張）

## 完了サマリ (2026-05-03)

- `SummalyOptions` に `cacheMaxAge`（デフォルト 604800）と `cacheErrorMaxAge`（デフォルト 3600）を追加
- Fastify ハンドラの成功・400・500 レスポンスに `Cache-Control` を付与
- `cacheMaxAge: 0` または `cacheErrorMaxAge: 0` で `Cache-Control: no-store` を出す
- 負数指定は `RangeError` で `done(err)` 経由で reject（plugin 初期化エラー）
- ヘルパ関数 `cacheControlHeader(maxAge)` を抽出
- テスト 9 件追加（成功/400/500/上書き/0/負数バリデーション）
- README に「Server caching」節を追加

副次的修正:
- ESLint 設定の `ignores` に `worktrees` を追加（Stage 1 ゲートを通すため）

派生フェーズ:
- 実装中に `summaly()` の `Object.assign(summalyDefaultOptions, options)` mutation バグを発見 → [phase1.2-options-mutation-fix.md](phase1.2-options-mutation-fix.md) として独立計画化（バグ分離ルールに従う）

## 目的・背景

[issue #27](https://github.com/misskey-dev/summaly/issues/27) で報告されている退化:

> Fastify化したときにキャッシュ機構が退化しているらしい
>
> Fastifyにする前にはちゃんと Cache-Control 吐いてたんだけど…（mei23）

現状の Fastify ハンドラ ([src/index.ts:148-181](src/index.ts#L148-L181)) は **`Cache-Control` ヘッダを一切付けていない**。これにより:

- 前段の nginx / Cloudflare 等のリバースプロキシ・CDN がキャッシュできない（`Cache-Control` 無し → 多くの実装でキャッシュ対象外）
- 結果として **Mastodon のリンクプレビュー DDoS 化問題** （[gigazine 記事](https://gigazine.net/news/20240502-mastodon-share-link-problem/)、[mastodon/mastodon#23662](https://github.com/mastodon/mastodon/issues/23662)）と同じく、Fediverse 全体で同じ URL に大量のサマリーリクエストが束になって対象サイトに到達する。

本フェーズでは **`Cache-Control` ヘッダを付け直す最小限の退化修正** だけを扱う。プロセス内インメモリキャッシュは [phase4.1](phase4.1-fastify-in-memory-cache.md) で別扱い。

---

## 現状分析

### 現状の Fastify ハンドラ

[src/index.ts](src/index.ts) の `default export`:

```ts
fastify.get('/', async (req, reply) => {
    const url = req.query.url as string;
    if (url == null) {
        return reply.status(400).send({ error: 'url is required' });
    }
    try {
        const summary = await summaly(url, { lang, followRedirects: false, ...options });
        return summary;
    } catch (e) {
        return reply.status(500).send({ error: e });
    }
});
```

`Cache-Control` ヘッダはどのパスでも付けていない。

### mei23 の参考実装

[worktrees/mei-summaly/src/server/index.ts](worktrees/mei-summaly/src/server/index.ts):

```ts
// 成功時
h3.setResponseHeader(event, 'Cache-Control', 'public, max-age=604800');  // 1週間
return summary;

// エラー時
h3.setResponseStatus(event, 422);
h3.setResponseHeader(event, 'Cache-Control', 'public, max-age=3600');     // 1時間
return 'error';
```

成功 1 週間・エラー 1 時間でキャッシュ。エラーキャッシュは「同じ壊れ URL に何度もリクエストして DDoS 増幅させない」工夫。

---

## 設計方針

### API 設計

```ts
type SummalyOptions = {
    // ... 既存 ...

    /** Fastify モード時の成功レスポンスの Cache-Control max-age（秒）。デフォルト 604800（1 週間） */
    cacheMaxAge?: number;

    /** Fastify モード時のエラーレスポンスの Cache-Control max-age（秒）。デフォルト 3600（1 時間） */
    cacheErrorMaxAge?: number;
};
```

ヘッダ書式: `public, max-age=<秒数>`

`max-age` を `0` にすると `no-store` を出すか `max-age=0` をそのまま出すかの判断 → `0` のときは `Cache-Control: no-store` を出す（明示的にキャッシュしないという意思表示として読める）。

### デフォルト値の根拠

mei23 互換（成功 604800 / エラー 3600）。長期の運用知見が乗った値であり、Fediverse のプレビュー利用パターンに合っている。

---

## 実装ステップ（チェックリスト）

各ステップで `pnpm eslint && pnpm test` を通す。

- [ ] **Step 1 — 成功レスポンスに `Cache-Control` を追加**
  - [src/index.ts](src/index.ts) の Fastify ハンドラ成功パスに `reply.header('Cache-Control', 'public, max-age=604800')`
  - 既存の Fastify テストに「成功レスポンスのヘッダに `Cache-Control` が含まれること」のアサートを追加
- [ ] **Step 2 — エラーレスポンスに `Cache-Control`**
  - 400 / 500 系に `reply.header('Cache-Control', 'public, max-age=3600')`
  - 不正 URL や origin 失敗のテストでヘッダが付与されることを確認
- [ ] **Step 3 — 設定可能化**
  - `SummalyOptions.cacheMaxAge?: number`（デフォルト 604800）を追加
  - `SummalyOptions.cacheErrorMaxAge?: number`（デフォルト 3600）を追加
  - `0` のときは `Cache-Control: no-store` を出す分岐
  - テスト: opts でオーバーライドした値が反映されること、`0` で `no-store` が出ること
- [ ] **Step 4 — README / CHANGELOG 更新**
  - 退化修正である旨と新オプション 2 種の説明
  - 「summaly サーバ運用時のキャッシュ戦略」節を追加（前段プロキシでキャッシュする運用）
  - issue #27 の参照リンク

---

## 完了条件 (Definition of Done)

- 成功・エラー両方のレスポンスに適切な `Cache-Control` ヘッダが付与される
- `cacheMaxAge` / `cacheErrorMaxAge` を opts で上書きできる
- `cacheMaxAge: 0` で `Cache-Control: no-store` が出る
- mei23 の挙動と互換のデフォルト値（成功 604800 / エラー 3600）が採用されている
- `pnpm build && pnpm eslint && pnpm test` が通る
- README に新オプションと運用ガイドが反映されている

---

## リスク・注意点

1. **エラーキャッシュ**: 5xx（一時的サーバ障害）の結果も TTL 中はキャッシュされうる。エラー TTL を短く（デフォルト 1 時間）保つことで影響を最小化。
2. **既存ユーザー影響**: ヘッダ追加は破壊的でないが、`reply.header` を返却前に呼ぶフローに変えるため、既存のフックや拡張で `reply` を弄っている利用者がいると影響しうる。CHANGELOG で明記。
3. **キャッシュキーの正規化**: 本フェーズでは扱わない（前段プロキシ側の責務）。phase4.1 のインメモリキャッシュで扱う。

---

## オープンクエスチョン / 次のアクション候補

- このフェーズは独立性が高く、即着手・即リリースが可能
- リリース後、必要に応じて [phase4.1](phase4.1-fastify-in-memory-cache.md)（インメモリ LRU キャッシュ）に進む
