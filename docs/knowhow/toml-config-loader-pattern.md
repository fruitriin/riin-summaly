# TOML 設定ファイル loader 設計パターン

> phase8.1 で導入。`fastify-cli --options config.json` から TOML ベースに移行したときの設計知見。

## 設計目標

1. **コメント・セクション分割**: JSON にできない「なぜこの値か」を残せる
2. **早期 fail**: 不正値で起動時に明示的なエラー（cryptic な runtime エラーを防ぐ）
3. **将来拡張用 placeholder**: `[plugins.<name>]` セクションを書ける（読まれないが構文は通る）
4. **ライブラリ用途への非影響**: `summaly()` 関数 / `fastify.register(Summaly, opts)` は変わらない

## ファイル配置の原則

config-loader は **`bin/` 配下に置く**。`src/` ではない。

理由:
- `src/` 配下に置くと「`src/index.ts` から間接的に import される将来的リスク」が生まれ、TOML パーサ（`smol-toml`）が npm 公開 bundle に混入する可能性がある
- TOML 設定はスタンドアロンサーバ起動 (`bin/summaly-server.ts`) でしか使われない運用ツール
- `bin/` は `tsdown.config.ts` の entry に含まれず、`npm publish` の `files: ["built","LICENSE"]` 対象外
- `tsconfig.dev.json` で `bin/**/*.ts` を typecheck し、ESLint は ignore（dev/ と同じ扱い）

`smol-toml` も `devDependencies` のままで OK（`bin/` がローカル開発・運用者の git clone デプロイ前提のため）。

## TOML スキーマの設計

セクションを目的別に分ける:

```toml
[server]                    # bind 設定（fastify.listen）
host = "127.0.0.1"
port = 3000

[summaly]                   # SummalyOptions のフラットな部分
responseTimeout = 20000
useRange = false

[summaly.cache]             # Cache-Control + LRU + dedup（運用 SLA に直結）
maxAge = 604800
inMemory = true
inFlightDedup = true

[summaly.pdf]               # PDF 機能（オプトイン）
enabled = false

[plugins]                   # プラグイン全体の許可リスト
allowed = ["amazon", "youtube"]

# [plugins.komiflo]         # 将来拡張用 placeholder（現状無視）
# preferredVariant = "346_mobile"
```

ポイント:
- フィールド名は **snake_case ではなく camelCase** で `SummalyOptions` のフィールド名と揃える（マッピング表が単純）
- ただしセクション分割で **冗長なプレフィックスを削る**（`cache.maxAge` は `cacheMaxAge` の代わり、`pdf.enabled` は `enablePdf` の代わり）
- `[plugins.<name>]` は構文上書ける（TOML の dotted keys は inline-table 化）が、loader が読み飛ばす placeholder にしておく → 将来プラグイン別 options 機構を追加するときに既存設定を壊さない

## 検証ロジックの設計

### 早期 fail

不正値は loader 段階で throw、`bin/summaly-server.ts` が `console.error` + `process.exit(1)`。runtime まで持ち越さない。

```ts
function expectType(value: unknown, expected: 'string'|'number'|'boolean', key: string): void {
	if (typeof value !== expected) {
		throw new TypeError(`config: \`${key}\` must be a ${expected}, got ${typeof value}`);
	}
}

function expectNonNegativeFiniteNumber(value: number, key: string): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new RangeError(`config: \`${key}\` must be a non-negative finite number, got ${value}`);
	}
}
```

### `host = ""` を必ず弾く

dev/server.ts の HOST 検証と同じ問題。`Fastify({}).listen({ host: '' })` は `::`（IPv6 全インターフェース）にバインドし、`SUMMALY_ALLOW_PRIVATE_IP=true` と組み合わさると **SSRF リレー化** する。

```ts
const h = (raw.host as string).trim();
if (h === '') {
	throw new RangeError('config: `server.host` must not be empty (use "127.0.0.1" or "0.0.0.0" explicitly)');
}
```

文字列値の TOML キーで「空文字列はおそらく入力ミス」のものは defensive に弾く。

### 未知キー / 未知セクションは silently 無視

将来追加されたキーで起動失敗するのを防ぐため、loader が知らないキーは黙ってスキップ。`[unknownSection]` も無視。テストでこの挙動を担保する:

```ts
test('未知のキーは無視する', () => {
	const cfg = parseTomlConfigString(`
		[summaly]
		responseTimeout = 5000
		unknownKey = "ignored"
	`);
	expect(cfg.summaly.responseTimeout).toBe(5000);
	expect((cfg.summaly as Record<string, unknown>).unknownKey).toBeUndefined();
});
```

### 検証関数のテストには `parseTomlConfigString` を使う

`parseTomlConfig(path)` はファイル I/O を含むのでテストで一時ファイルを作る必要がある。代わりに **TOML 文字列を直接受け取る `parseTomlConfigString` を export** し、テストはそれを使う。`parseTomlConfig` は thin wrapper。

```ts
export function parseTomlConfigString(toml: string): ParsedConfig { ... }
export function parseTomlConfig(path: string): ParsedConfig {
	const text = readFileSync(path, 'utf-8');
	return parseTomlConfigString(text);
}
```

## Breaking Change の進め方

旧 `--options config.json` は廃止だが、**サンプル JSON ファイルは 1 リリース残置**:

- `docs/deploy-examples/summaly-config.example.json` の冒頭に `_comment_` フィールドで DEPRECATED を明記
- `docs/deploy-examples/README.md` に **JSON → TOML マイグレーション手順** を表形式で記載（`cacheMaxAge` → `[summaly.cache] maxAge` 等）
- CHANGELOG で Breaking Change として太字で告知

旧 fastify-cli (`fastify-cli`) は **`devDependencies` から外さない**。テスト等で間接利用しているケースに備える。

## TOML パーサの選定

- ✅ `smol-toml`: 純 JS、依存ゼロ、~40KB、TOML 1.0 完全対応、メンテ活発
- ❌ `@iarna/toml`: メンテ停滞
- △ `@ltd/j-toml`: 高速だがやや重い

設定ファイル loader としてはサイズより仕様準拠とメンテ活発さが重要。

## 参考

- [docs/plans/phase8.1-toml-config.md](../plans/phase8.1-toml-config.md) — 設計プラン
- [bin/config-loader.ts](../../bin/config-loader.ts) — loader 実装
- [bin/summaly-server.ts](../../bin/summaly-server.ts) — サーバ起動エントリ
- [config.example.toml](../../config.example.toml) — スキーマ例
- [test/config-loader.test.ts](../../test/config-loader.test.ts) — テスト
