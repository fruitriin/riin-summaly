# TypeScript の `pnpm typecheck` セットアップ

bundler / test runner のトランスパイラ (tsdown / vitest 等) は **`noImplicitAny` のような strict 型チェックを実行しない**ため、`ts(7016)` (型定義欠如) のようなエラーは IDE では出ても CI / CLI では catch されない。

## 解決パターン

`tsc --noEmit` を `package.json` の独立 script として追加する。

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.test.json"
  }
}
```

## 本体コードとテストで tsconfig を分ける

bundler / test runner が使う `tsconfig.json` の `include` は通常 src/ のみで、test/ を含まない。同じ tsconfig で typecheck すると test ディレクトリ内のエラーを catch できないので、**typecheck 用の追加 tsconfig** を用意する。

```json
// tsconfig.test.json
{
  "extends": "./tsconfig.json",
  "include": ["./src/**/*", "./test/**/*", "./vitest.config.ts"]
}
```

src と test を別 tsconfig で順に走らせる利点:
- src 用 tsconfig は bundler が `tsconfig: true` で参照するものをそのまま再利用できる（ドリフト防止）
- test 用は include だけ拡張する extend 形式で重複定義を最小化
- 失敗箇所がどちらかすぐ分かる（src の問題と test の問題を切り分けやすい）

## 落とし穴

1. **vitest は型ゆるい**: vitest はテストを transpile して走らせるだけで、`noImplicitAny` 違反のテストもパスしてしまう。type-only import (`import type { X } from ...`) や `@types/*` 漏れを catch するには tsc が必須
2. **tsdown / esbuild も同様**: bundler の transpile はあくまでコード生成。型整合性チェックではないので「ビルド通る = 型 OK」ではない
3. **CI / 品質ゲートに組み込む**: 開発者個人が走らせるだけでは漏れる。`addf-dev` の Stage 1 や CI ワークフローに必ず入れる
4. **`ts(7016)` の対処**: `pnpm add -D @types/<pkg>` がまず最初。無ければ `src/@types/<pkg>.d.ts` に `declare module '<pkg>';` で workaround

## 実例

phase5.x 完了後に `encoding-japanese` の型定義欠如が IDE 上で発見された。`pnpm build` も `pnpm test` も通るのに IDE だけが警告していた状況。

対処:
1. `pnpm add -D @types/encoding-japanese` (npm に存在)
2. `tsconfig.test.json` を新設（src + test + vitest.config.ts を include）
3. `pnpm typecheck` を script に追加
4. 同時に発覚したテストファイルの未 import 型 (`SummalyOptions`) も修正
5. `CLAUDE.repo.md` のテストセクションと `ProgressTemplate.addf.md` の品質ゲート Stage 1 に追加
