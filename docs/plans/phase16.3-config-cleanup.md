# phase16.3 — config 整理 + 経路依存 fail-fast

## 背景

phase16.1 / 16.2 で「経路優先システム」を主軸にドキュメント整理した結果、`config.example.toml` の以下の問題が浮き彫りになった:

1. **半端に有効値が残っている** — デフォルト値で十分なキーが `categories = [...]` 等で明示されており、運用者は「これは変えるべきか?」と迷う
2. **TOML 設定項目が多すぎる** — `categories` / `domains` のような「コード側で最適管理すべきもの」が運用者の責任に渡されている
3. **依存関係が黙って失敗する** — `[scraping.strategy_cache]` の bootstrap.jsonl が `yodobashi.com → curl_cffi` を指定していても `[scraping.curl_cffi].enabled = false` だと cache fast path で gate 不通過 → 通常 scpaping → 失敗、という「動かないが破壊的でもない」状態に陥る
4. **`[server].publicUrl` の置き場が embed 専用にもかかわらず server セクション** — 概念整理が不徹底
5. **`[embed].allowedPlugins` の二重管理** — `[plugins].allowed` と分かれており「片方からだけ除外」という低頻度ニーズへの対応コストが大きい

## 方針

**互換性は破壊する**。riin-summaly はオレオレ運用で利用者が限定されており、silent migration / forward-compat の運用負担より「**設定が間違っていれば即起動失敗**」の方が運用上正しい (静かに動かない状態で 1 週間気付かない方がコストが大きい)。

- 旧キーは silent ignore せず **TOML エラーで起動失敗** (smol-toml の forward-compat 設計に逆らう例外を `expectKnownKeys` 風に明示)
- 経路依存の bootstrap entry と `enabled` 状態の不整合は **起動時 fail-fast** + 「どちらを直すか」の指示メッセージ
- デフォルト値で十分な項目は example から消す (デフォルト依存に任せる)
- `categories` / `domains` の運用者選択責任を撤廃 (コード側に固定 / bootstrap から自動導出)

## Step 1: config.example.toml 整理 (config-only)

### 順序変更

`[scraping.strategy_cache]` を `[summaly]` 直後に移動 (全体感のある戦略として目立たせる)。新順序:

```
[server]
[summaly]
[summaly.cache]
[summaly.pdf]
[scraping.strategy_cache]    ← 上に持ち上げる
[scraping.proxy]
[scraping.curl_cffi]
[scraping.fallback]
[plugins]
[diagnostics]
[embed]
```

### 半端な有効値を削除 (コメントアウト or 削除)

デフォルト値で十分な箇所:

- `[summaly]`: `responseTimeout` / `operationTimeout` / `contentLengthLimit` / `contentLengthRequired` / `useRange` (Step 4 で default true 化)
- `[summaly.cache]`: `errorMaxAge` (`maxAge` だけは運用判断あり、残す)
- `[scraping.proxy]`: `categories` / `timeoutMs` (categories は Step 2 で削除)
- `[scraping.curl_cffi]`: `uvPath` / `impersonate` / `categories` / `timeoutMs` (categories は Step 2 で削除)
- `[scraping.fallback]`: `categories` (Step 2 で削除)
- `[scraping.strategy_cache]`: `maxEntries` / `consecutiveFailureThreshold` / `compactionThreshold`

残すもの:
- 各 `enabled = true/false` (常に明示状態が分かりやすい)
- 環境依存パス (`projectDir`、`runtimePath`、`bootstrapPath`、`publicUrl`)

## Step 2: 設定項目の整理 (breaking、code change)

### 削除する TOML キー (旧 config を持つユーザーは起動失敗、エラーで指示)

- `[scraping.proxy].categories` — コード側 default `['origin_error', 'bot_blocked']` に固定
- `[scraping.proxy].domains` — bootstrap JSONL から自動導出 (`strategy === "proxy"` の host を集めて allowlist 化)
- `[scraping.curl_cffi].categories` — コード側 default `['timeout', 'connection_dropped', 'bot_blocked']` に固定
- `[scraping.curl_cffi].domains` — bootstrap JSONL から自動導出 (`strategy === "curl_cffi"` の host を集めて allowlist 化)
- `[scraping.fallback].categories` — コード側 default `['bot_blocked', 'connection_dropped']` に固定
- `[embed].allowedPlugins` — 削除。`renderEmbed` を実装したプラグインで `[plugins].allowed` に入っているものを自動採用

### 移動する TOML キー

- `[server].publicUrl` → `[embed].publicUrl`
  - 旧 `[server].publicUrl` は **エラーで起動失敗** (`config: '[server].publicUrl' was moved to '[embed].publicUrl' in phase16.3, please update`)

### `expectKnownKeys` 風の unknown key 検出

`bin/config-loader.ts` で各セクションの allowed key を明示し、未知キーは起動失敗:

```typescript
function expectKnownKeys(obj: Record<string, unknown>, allowed: string[], path: string): void {
    for (const k of Object.keys(obj)) {
        if (!allowed.includes(k)) {
            throw new RangeError(
                `config: unknown key '${path}.${k}'. valid keys: ${allowed.join(', ')}. ` +
                `(phase16.3 で削除/移動された旧キーかもしれません — DEPRECATED.md を参照)`
            );
        }
    }
}
```

これで `parseFailureLogEndpoint = true` のような旧キー silent ignore も廃止して fail-fast 化。

## Step 3: 経路依存 fail-fast (sanity check)

`bin/config-loader.ts` (もしくは `src/index.ts` の Fastify auto-init) で、起動時に以下を確認:

```
[scraping.strategy_cache].enabled === true (デフォルト true)
かつ
bootstrap.jsonl に strategy === "proxy" の entry が存在
かつ
[scraping.proxy].enabled === false
→ 起動失敗
```

エラーメッセージ例:

```
config: bootstrap '/path/to/data/domain-strategy-bootstrap.jsonl' は以下の host に対し
'proxy' 経路を必須としていますが、[scraping.proxy].enabled = false です:
  - amazon.co.jp/dp
  - amazon.com/dp
  - store.jp.square-enix.com

以下のいずれかで対処してください:
  (a) [scraping.proxy].enabled = true にして proxy をセットアップ (tools/cf-proxy-worker/README.md 参照)
  (b) [scraping.strategy_cache].bootstrapPath = "" で bootstrap を無効化 (該当ホストのプレビューは取得できなくなります)
  (c) bootstrap.jsonl からエントリを削除
```

`curl_cffi` についても同様 (`yodobashi.com` で確認失敗するケース)。

## Step 4: `useRange` の internal default を true に

- `src/general.ts` / `src/utils/got.ts` で `opts?.useRange ?? true` 系の流れに変更
- `[summaly].useRange` を明示しない場合は **Range header を送る** がデフォルト
- example も `useRange` 行を削除 (デフォルト依存)

## Step 5: parseFailureLog の Path デフォルト化

- `parseFailureLog = true` で path 未指定なら自動デフォルト適用
  - `parseFailureLogJsonlPath` デフォルト: `./data/parse-failures.jsonl` (cwd 相対)
  - `parseFailureLogBlockedJsonlPath` デフォルト: `./data/parse-failures-blocked.jsonl`
- ペア制御: 片方だけ Path を指定する config はエラー (両方明示 or 両方デフォルト)
- `.gitignore` に `data/parse-failures*.jsonl` を追加 (`bootstrap.jsonl` と区別)

## Step 6: ドキュメント更新

- `DEPRECATED.md` に **phase16.3 削除/移動キー** セクション追加 (旧 → 新の対応 + 起動失敗時のエラーメッセージ例 + 移行スニペット)
- `docs/SETUP.md`:
  - `[scraping.proxy]` / `[scraping.curl_cffi]` / `[scraping.fallback]` セクションから `categories` / `domains` 設定の説明削除 (「コード側で管理されるため設定不要」と明記)
  - `[embed]` セクションから `allowedPlugins` の説明削除 (`[plugins].allowed` で管理と明記)
  - `[server].publicUrl` 言及を `[embed].publicUrl` に変更
  - 経路依存 fail-fast の動作説明を新規セクションで追加
- `docs/Library.md`: `embedConfig` / `proxyFallback` / `curlCffiFallback` の TypeScript 型から削除されたフィールドを反映
- `config.example.toml` (Step 1 で整理済) と `docs/deploy-examples/summaly-config.example.toml` (両方更新)
- `CHANGELOG.md` に **breaking change** セクションを明示

## Step 7: テスト更新

- `bin/config-loader.test.ts` (もしあれば、もしくは `test/config-loader.test.ts`):
  - 旧キー指定で起動失敗するテスト追加 (4 ケース最低: `[scraping.proxy].categories` / `[scraping.proxy].domains` / `[server].publicUrl` / `[embed].allowedPlugins`)
  - bootstrap × `enabled = false` の依存エラーで起動失敗するテスト追加
  - 削除キーが silent ignore されないことのテスト
- `test/config-example-plugins.test.ts` の挙動が変わらないか確認 (allowed プラグイン名抽出は影響なし)

## Step 8: 品質ゲート

- `pnpm build` / `pnpm eslint` / `pnpm typecheck` / `pnpm test`
- 手動確認: `pnpm serve config.example.toml` で起動できる (デフォルトに依存して動く)
- 手動確認: `[scraping.proxy].enabled = false` のまま起動すると意図したエラーで停止する
- ADDF code-review-agent

## サイズ

M〜L (コード変更 + テスト追加 + ドキュメント大幅整理 + 設定 example 全面書き直し)

## 確認しておく論点 (実装中に決定)

- `parseFailureLogJsonlPath` の デフォルト `./data/parse-failures.jsonl` で OK か (もしくは `./parse-failures.jsonl` cwd 直下、または `process.env.STATE_DIRECTORY` 系の OS 標準を見るか)
- `expectKnownKeys` の granularity — TOML セクションごとに list を持つか、横断的に管理するか
- bootstrap から domains 自動導出するロジックの場所 — `config-loader.ts` で導出してから got.ts に渡すか、got.ts 側で必要なときに lookup するか

## 実装完了状況 (2026-05-09)

- ✅ Step 2.1 / 2.2 / 2.3: `[scraping.proxy]` / `[scraping.curl_cffi]` / `[scraping.fallback]` の `categories` / `domains` TOML キー削除、コード側 default 固定 + bootstrap.jsonl から domains 自動導出 (`loadBootstrapHostsByStrategy`)
- ✅ Step 2.4: `[server].publicUrl` → `[embed].publicUrl` 移動 (旧位置は未知キーで起動失敗)
- ✅ Step 2.5: `[embed].allowedPlugins` 削除 (Fastify auto-init で `renderEmbed` × `[plugins].allowed` から auto-fill)
- ✅ Step 2.6: `expectKnownKeys` 全セクション追加 (旧キー silent ignore 撤廃、起動失敗化)
- ✅ Step 3: 経路依存 fail-fast (`buildBootstrapDependencyError` でエラーメッセージ + 3 択対処案内)
- ✅ Step 4: `useRange` の internal default を true に (`src/utils/got.ts` で `?? true` に変更)
- ✅ Step 5: `parseFailureLog` Path のペア + デフォルト適用 (`./data/parse-failures*.jsonl`)
- ✅ Step 6: `.gitignore` に `data/parse-failures*.jsonl` / `data/domain-strategy-runtime.jsonl` 追加
- ✅ Step 1: `config.example.toml` + `docs/deploy-examples/summaly-config.example.toml` 全面書き直し (順序変更 + デフォルト依存化、`[scraping.strategy_cache]` を `[summaly]` 直後に移動)
- ✅ Step 7: テスト全面書き直し (`test/config-loader.test.ts` 559 件 pass)
- ✅ Step 8.4: ドキュメント更新 (`DEPRECATED.md` に phase16.3 セクション追加 / `CHANGELOG.md` breaking change エントリ / `docs/SETUP.md` の `[server].publicUrl` → `[embed].publicUrl` / `[embed].allowedPlugins` 削除言及 / `docs/Library.md` の `proxyFallback` / `curlCffiFallback` の `categories` / `domains` 説明更新)

## フォロー候補 (別 phase 検討)

- **phase16.4**: `docs/SETUP.md` の `[scraping.proxy]` / `[scraping.curl_cffi]` / `[scraping.fallback]` セクションの詳細表 (`categories` / `domains` 設定例) を全面整理。phase16.3 ではコア変更を完成させ、SETUP.md の表面的整合性のみ取った状態で commit している
- src/index.ts L281 のコメント `Fastify モードでは [embed].publicUrl から自動投入される` を反映済 (phase16.3 で対応)
