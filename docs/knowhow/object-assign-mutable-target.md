# Object.assign(constant, override) はモジュール定数を mutate するアンチパターン

## 結論

`Object.assign(target, ...sources)` は **target を mutate** する。
モジュールレベルの「デフォルト定数」を target に渡すと、呼び出し側の override 値が
定数に書き込まれ、**以降の全呼び出しに漏れる**。

正しいのは新規オブジェクトを target にするか、スプレッド構文を使う:

```ts
// NG: summalyDefaultOptions が呼び出し側の値で上書きされる
const opts = Object.assign(summalyDefaultOptions, options);

// OK
const opts = Object.assign({}, summalyDefaultOptions, options);
const opts = { ...summalyDefaultOptions, ...options };  // 推奨（モダン）
```

## 検出パターン

`grep -rn 'Object.assign(' src/` の結果に対して、第1引数がモジュールレベルで
`const FOO = {...}` として宣言されているシンボルなら疑う。
特に `const default*` / `*Defaults` / `*Options` / `*Config` という命名は要注意。

## 回帰テスト

「同じエクスポートされた API を **異なる opts で連続呼び出し** したとき、
**1回目の opts が 2回目に漏れない**」ことを直接検証する:

```ts
test('連続呼び出しで前回の opts が漏れないこと', async () => {
    await fn(url, { someLimit: 16 }).catch(() => {/* 失敗しても良い */});
    const result = await fn(url);  // opts なし → デフォルト値で動くべき
    expect(result).toBeDefined();
});
```

加えて、定数自体のスナップショットを取って `toEqual` 比較すれば mutation を直接検出できる。

## 関連する追加防御

- `Object.freeze(constant)` を加えれば実行時にも検出可能（破壊的代入が TypeError を投げる）
- ただし定数が export されていて、利用者が読み取り専用前提で参照していない場合は
  互換性に注意（本リポでは将来検討、現状未適用）

## 周辺の落とし穴

スプレッド構文はシャローコピー。ネストした配列・オブジェクト（例: `plugins: []`）は
**同一参照のまま**コピーされるので、コピー後に `.push()` 等で mutate すれば元の定数も汚染される。
本リポの `summalyDefaultOptions.plugins` は読み取り専用パス（`builtinPlugins.concat(opts.plugins ?? [])` で
新配列を生成）のため実害なし。

## 発見・対処履歴

- phase1.1（Fastify Cache-Control 修正）のテスト追加中、`contentLengthLimit: 16` を
  渡した先行テストの値が後続テストに漏れて `maxSize exceeded (274 > 16)` で失敗
- phase1.2 として独立計画化、`Object.assign(summalyDefaultOptions, options)` →
  `{ ...summalyDefaultOptions, ...options }` に置換、回帰テスト 2 件を追加
