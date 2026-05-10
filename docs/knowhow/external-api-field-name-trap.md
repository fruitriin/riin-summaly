# 外部 API のフィールド名・意味の検証 (なろう API トラップ事例)

> syosetu (なろう) プラグインで踏んだ 2 種類のバグを契機に整理した、外部 JSON API の interface 化で必ず実機検証すべき 2 軸。コミット 8ad0afc。

## 課題: TypeScript の interface だけでは外部 API の仕様を保証できない

外部 JSON API のレスポンスを受ける TypeScript の interface 定義は、**実 API レスポンスとの整合性を一切保証しない**。

```typescript
export interface SyosetuNovelData {
  // typo していてもコンパイル通る (実 API と一致するかは別)
  novel_type?: unknown;  // 公式 API は `noveltype` (アンダースコア無し) を返す
  end?: unknown;          // 公式仕様: 0=完結済/短編、1=連載中 (直感と逆)
}

function asNumber(v: unknown): number | null { ... }

// novel.novel_type は常に undefined → asNumber(undefined) === null
// → 短編/連載/完結の三分岐が常に else パスに落ちる
const novelType = asNumber(novel.novel_type);
const end = asNumber(novel.end);
const status = novelType === 2 ? '短編' : (end === 1 ? '完結済' : '連載中');
//                                              ^^^^^^^^^^^^^^^^^^^^^^^^^^
//                                              意味が逆 (公式仕様: end=1 が連載中)
```

**バグが lint / typecheck / unit test を全て通過する**:
- フィールド名 typo: `novel.novel_type` は `unknown` 型なのでアクセス自体は許される
- 値の意味反転: テスト側が同じ前提で書かれていれば pass する (実 API と無関係)

## なろう API で踏んだ 2 つのトラップ

### トラップ 1: フィールド名 `noveltype` (アンダースコア無し)

公式ドキュメント (https://dev.syosetu.com/man/api/) が **「noveltype※novel_typeではございません」** と注記するレベルの罠。`of=nt` で要求するとレスポンスフィールド名は `noveltype` で返る。

リクエストの of パラメータ (`nt`) と response field 名 (`noveltype`) が独立している API では類似トラップが起きやすい。

### トラップ 2: `end` 値の意味反転

公式仕様: **「短編作品と完結済作品は 0、連載中は 1」** (直感では完結 = end = 1 と思いがち)。

実例: `end: 0` の作品が「連載中」、`end: 1` の作品が「完結済」と表示されるバグが、すべての連載/完結作品で起きていた。

## 検証パターン

### Step 1: 実 API レスポンスを目視確認

interface 定義する前に必ず実 API を叩いて生レスポンスを確認する:

```bash
curl -s 'https://api.syosetu.com/novelapi/api/?ncode=n4830bu&out=json&of=t-w-s-bg-g-nt-e-ir15-izk-ibl-igl-k' \
  | python3 -m json.tool
```

レスポンス:
```json
[
  { "allcount": 1 },
  {
    "title": "...",
    "writer": "...",
    "noveltype": 1,   // ← novel_type ではない
    "end": 0,          // ← この作品は「完結済」(連載中なら 1)
    ...
  }
]
```

### Step 2: 公式ドキュメントで意味を確定

API ドキュメントを 1 行ずつ読んで、各フィールドの取りうる値と意味を引用付きでコメントに残す:

```typescript
export interface SyosetuNovelData {
  /** なろう公式 API は `noveltype` (アンダースコア無し)。`of=nt` で要求するが
   * レスポンスは `noveltype` で返る (公式ドキュメント注記)
   * https://dev.syosetu.com/man/api/ */
  noveltype?: unknown; // 1=連載, 2=短編

  /** 公式仕様: 短編作品と完結済作品は **0**、連載中は **1** (直感と逆)
   * https://dev.syosetu.com/man/api/ */
  end?: unknown; // 0=完結済/短編, 1=連載中
}
```

`composeDescription` / `composeEmbedHtml` 等の利用側でも同じ仕様コメントを再掲して、保守時の取り違えを構造的に防ぐ。

### Step 3: 実 API レスポンスと一致するサンプルでテスト

```typescript
// 連載中作品のサンプル (実 API レスポンスを縮小したもの)
const SAMPLE_NOVEL: SyosetuNovelData = {
  noveltype: 1,  // 1=連載
  end: 1,         // 1=連載中
  // ...
};

test('連載中', () => {
  expect(composeDescription(SAMPLE_NOVEL)).toContain('連載中');
});
test('完結済', () => {
  expect(composeDescription({ ...SAMPLE_NOVEL, end: 0 })).toContain('完結済');
});
```

`SAMPLE_NOVEL` を **実 API レスポンス由来** の値で構築すると、サンプル定義と利用側のロジックが両方間違っていても発覚しない。**サンプルと公式仕様コメントの意味を独立に確認する**運用が必要。

## プロジェクトへの適用

新規プラグインで外部 JSON API を直叩きするとき:

1. **interface 定義の前に必ず実 API を叩く** (curl + jq で目視確認)
2. **公式ドキュメントで各フィールドの意味を確定** + interface コメントに引用付きで記録
3. **テストサンプルは実 API レスポンスから縮小** + 公式仕様コメントで二重確認
4. レビュー時、`addf-code-review-agent` に「外部 API の interface 定義は実 API レスポンスと一致しているか?」を観点として渡す
5. ESLint / typecheck / unit test の全 pass は外部 API 仕様の正確性を一切保証しない、と認識して運用する

## 注意点・制約

- **OpenAPI / JSON Schema が公開されている API なら interface を自動生成すべき** (例: openapi-typescript)。なろう API のような独自仕様の API では手動定義が避けられない
- **filter / projection パラメータがある API は要注意**: `of=nt` のように short alias で要求してフルネーム (`noveltype`) で返るパターンは類似 API でも発生 (Twitter X API, GraphQL の field alias 等)
- **boolean 風の数値フィールドは値の意味を必ず公式ドキュメントで確認**: `end: 0/1` のような単純な int は「直感的にどっちが完結か」を考えても外す。書き出す側の都合 (短編/完結済を同じ「コンテンツ完了状態」として 0 にまとめる設計) があり得る
- **TypeScript の `unknown` 型はランタイム検証なしでは何も保証しない**: `asNumber` / `asString` 等の guard を経由するパターンでも、フィールド名 typo は guard が常に null を返す sliently fail を引き起こすため、定期的な実 API との突き合わせが必要

## 参照

- [src/plugins/syosetu.ts](../../src/plugins/syosetu.ts) — `SyosetuNovelData` interface, `composeDescription`, `composeEmbedHtml`
- [test/syosetu.test.ts](../../test/syosetu.test.ts) — `SAMPLE_NOVEL` 定義 (`noveltype: 1, end: 1` で連載中)
- https://dev.syosetu.com/man/api/ — なろう公式 API ドキュメント
- コミット 8ad0afc — `novel_type` → `noveltype` 修正 + `end` 意味反転修正
