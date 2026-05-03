# Phase 1.2 — `summaly()` のオプション mutation バグ修正

> 状態: **完了 (2026-05-03)**
> 種別: バグ修正
> サイズ: **XS**
> 発見元: phase1.1 のテスト追加時、`content-length limit` テスト後に追加した Fastify テストで `maxSize exceeded (274 > 16)` エラーが伝播
> 依存: なし

## 目的・背景

[src/index.ts:81](src/index.ts#L81) の `summaly()` 関数内で:

```ts
const opts = Object.assign(summalyDefaultOptions, options);
```

これは `Object.assign(target, source)` の意味で **target = `summalyDefaultOptions` を mutate** している。`summalyDefaultOptions` はモジュールレベルの定数オブジェクトなので、**1 回呼び出すと以降の全呼び出しに前回の opts が漏れる**。

具体例（実際に phase1.1 のテストで観測）:

```ts
await summaly('http://...', { contentLengthLimit: 16 });
// この時点で summalyDefaultOptions.contentLengthLimit = 16 が残る

await summaly('http://...');  // contentLengthLimit を渡していない
// しかし内部では contentLengthLimit: 16 で動く！ → maxSize exceeded
```

ライブラリ利用者にとっても:
- 同じ `summaly()` を異なる opts で連続呼出ししたとき、前回の opts が次回に漏れる
- マルチテナント運用（Misskey の summaly proxy で異なる呼び出し元から異なる opts を受ける構成）で**他テナントの設定が混入する**

これは明確なバグで、ユーザーから見ても再現性がある問題。

---

## 現状分析

[src/index.ts:78-82](src/index.ts#L78-L82):

```ts
export const summaly = async (url: string, options?: SummalyOptions): Promise<SummalyResult> => {
    if (options?.agent) setAgent(options.agent);

    const opts = Object.assign(summalyDefaultOptions, options);
    // ...
};
```

`summalyDefaultOptions` は `export const summalyDefaultOptions = { lang: null, followRedirects: true, plugins: [] }` で、export されている。**ライブラリのドキュメント上はデフォルト値の参照用**として export されているが、実装が上書き対象に使っているため、利用者が `summalyDefaultOptions.followRedirects` を読み取ると最後の呼び出しの値が見える、という別の混乱もある。

---

## 設計方針

### 修正

`Object.assign(summalyDefaultOptions, options)` → `Object.assign({}, summalyDefaultOptions, options)`

新しい空オブジェクトを target にすることで `summalyDefaultOptions` を mutate しなくなる。

または同等の `{ ...summalyDefaultOptions, ...options }` でも良い（モダン構文、可読性が高い）。**スプレッド構文を採用** する方針。

### 互換性

- API は完全互換（戻り値・挙動とも変わらない、正しい挙動になるだけ）
- `summalyDefaultOptions` を export している以上、ライブラリ利用者が「前回の呼び出しで値が変わっている」ことに依存しているコードは無いはず（あるとすれば誤用）

### テストに残された回避策の撤去

[test/index.test.ts](test/index.test.ts) の `Fastify plugin: Cache-Control` の `setupOriginAndProxy` で、phase1.1 で入れた以下の回避策を本フェーズで撤去する:

```ts
// summalyDefaultOptions が mutate される既知の課題（別 phase で扱う）への
// テスト独立性確保のため contentLengthLimit を明示的に渡す
await proxyApp.register(summalyPlugin, { contentLengthLimit: 10 * 1024 * 1024, ...pluginOptions });
```

→

```ts
await proxyApp.register(summalyPlugin, pluginOptions);
```

### 回帰テスト追加

「異なる opts で連続呼出ししても前回の opts が漏れない」ことを担保するテストを追加:

```ts
test('summalyDefaultOptions が連続呼び出しで mutate されないこと', async () => {
    // ... origin セットアップ ...
    await summaly(host, { contentLengthLimit: 16 }).catch(() => {});  // 失敗しても OK
    // 直後に opts なしで呼ぶと、デフォルト 10 MiB で動くべき
    const summary = await summaly(host);
    expect(summary).toBeDefined();
});
```

---

## 実装ステップ（チェックリスト）

各ステップで `pnpm eslint && pnpm test` を通す。

- [x] **Step 1 — 修正**
  - [src/index.ts](src/index.ts) の `Object.assign(summalyDefaultOptions, options)` を `{ ...summalyDefaultOptions, ...options }` に置換
- [x] **Step 2 — 回帰テスト追加**
  - [test/index.test.ts](test/index.test.ts) に新規 describe `options 不変性` を追加し、2 件のテストを追加（連続呼び出しでの opts 漏れ検証・`summalyDefaultOptions` 自体の不変性検証）
- [x] **Step 3 — phase1.1 で入れた回避策の撤去**
  - [test/index.test.ts](test/index.test.ts) の `Fastify plugin: Cache-Control` の `setupOriginAndProxy` および 500 エラーテストから `contentLengthLimit: 10 * 1024 * 1024` の明示渡しを撤去
  - 撤去後も全テスト通過確認済み
- [x] **Step 4 — CHANGELOG / リリースノート**
  - [CHANGELOG.md](../../CHANGELOG.md) の `(unreleased)` に「`summaly()` の opts mutation バグ修正」を追記
  - ライブラリ利用者向けに「前回の opts が次回に漏れなくなった」挙動変更を明記

---

## 完了条件 (Definition of Done)

- 連続呼出で `summalyDefaultOptions` が mutate されない
- phase1.1 のテストから回避策（明示 `contentLengthLimit`）を撤去しても全テストが通る
- 回帰テストが追加されている
- `pnpm build && pnpm eslint && pnpm test` が通る

---

## リスク・注意点

1. **`summalyDefaultOptions` を読んでいる利用者**: 現状 `summaly()` 1 回呼出後にこの定数が変化する挙動に依存しているコードがあれば壊れる。**そのような利用は誤用**であり、CHANGELOG で挙動変更として記録する
2. **修正範囲**: 本フェーズの修正は 1 行のみ。リスクは極小

---

## オープンクエスチョン

- `summalyDefaultOptions` の export を維持するか、オブジェクトを `Object.freeze()` するかは別議論。本フェーズでは export のまま、freeze もしない（変更点を最小化）
