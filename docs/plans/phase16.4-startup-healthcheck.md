# phase16.4 — 起動時 healthcheck (placeholder + 疎通検証)

## 背景

phase16.3 で config 整理を行ったが、**`enabled = false` 状態でも有効化時に必要なキー (`url` / `secret` / `projectDir` / `uvPath`) を `config.example.toml` に placeholder のまま書いておきたい** ニーズがある:

- 運用者が `enabled = true` にするだけで「次に何を埋めるべきか」が一目で分かる
- 全部コメントアウトにすると、必須キーの存在自体に気づかず TOML エラー (`url is required`) で混乱する可能性がある

しかし「placeholder のまま `enabled = true` にして起動」してしまうと、proxy 経由のリクエストで `https://summaly-proxy.<your>.workers.dev` に DNS 解決失敗するまでわからない。**起動時にヘルスチェックを走らせて placeholder のままなら起動失敗** にすることで、設定漏れを早期検出できる。

## ゴール

- proxy / curl_cffi の `enabled = true` 時、起動時に **設定値の placeholder 検出 + 疎通検証** を fail-fast で走らせる
- placeholder のまま起動 = 起動失敗、エラーメッセージで具体的な対処を案内
- 実 HTTP / spawn 検証で「設定したが Worker が deploy されていない / uv が PATH に無い」も検出

## Step 1: `bin/healthcheck.ts` 新設

`runConfigHealthchecks(config: ParsedConfig): Promise<void>` を export。`bin/summaly-server.ts` から起動時 1 回呼ぶ (library mode = 直接 `summaly()` 呼び出しでは走らない、Fastify モード専用)。

### proxy のヘルスチェック

```typescript
if (config.summaly.proxyFallback?.enabled) {
    const { url, secret } = config.summaly.proxyFallback;

    // placeholder 検出 (config.example.toml の `<your>` / `...` を吸収)
    if (/<[^>]*>/.test(url) || url.includes('summaly-proxy.<')) {
        throw new Error(`config: scraping.proxy.url が placeholder のままです: ${url}`);
    }
    if (secret === '...' || secret === '' || /<[^>]*>/.test(secret)) {
        throw new Error(`config: scraping.proxy.secret が placeholder のままです`);
    }

    // 軽量 URL の疎通テスト (HMAC 付きで Worker 経由で example.com 取得)
    // TODO: Worker 側に /health endpoint を追加するのが理想だが、
    //        phase16.4 ではまず placeholder 検出のみとし、実疎通は Step 2 follow-up に切る
}
```

### curl_cffi のヘルスチェック

```typescript
if (config.summaly.curlCffiFallback?.enabled) {
    const { projectDir, uvPath } = config.summaly.curlCffiFallback;

    // placeholder 検出
    if (projectDir.includes('/path/to/') || /<[^>]*>/.test(projectDir)) {
        throw new Error(`config: scraping.curl_cffi.projectDir が placeholder のままです: ${projectDir}`);
    }
    // 存在確認
    if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
        throw new Error(`config: scraping.curl_cffi.projectDir が存在しません or ディレクトリでない: ${projectDir}`);
    }
    // uv 実行可能性 (spawnSync で `uv --version`)
    const result = spawnSync(uvPath, ['--version'], { encoding: 'utf-8', timeout: 5000 });
    if (result.error || result.status !== 0) {
        throw new Error(
            `config: scraping.curl_cffi.uvPath で uv が実行できません: ${uvPath}\n`
            + `  詳細: ${result.error?.message ?? result.stderr ?? 'unknown'}`
        );
    }
}
```

### embed のヘルスチェック (副次的)

```typescript
if (config.summaly.embedConfig?.enabled && !config.summaly.embedBaseUrl) {
    // [embed].enabled = true だけど publicUrl 未設定 → 警告ログ (起動は通す)
    process.stderr.write(`[summaly][embed] enabled = true ですが publicUrl 未設定です。player.url が組み立てられません\n`);
}
```

## Step 2: `bin/summaly-server.ts` で起動時呼び出し

```typescript
import { parseTomlConfig } from './config-loader.js';
import { runConfigHealthchecks } from './healthcheck.js';

const config = parseTomlConfig(configPath);
await runConfigHealthchecks(config);  // placeholder / spawn 検証 fail-fast
// Fastify register...
```

## Step 3: テスト追加 (`test/healthcheck.test.ts` 新設)

- placeholder URL `<your>.workers.dev` 検出 → throw
- placeholder secret `...` 検出 → throw
- placeholder projectDir `/path/to/` 検出 → throw
- 存在しない projectDir 検出 → throw
- uvPath が PATH に無い → throw (mock spawn)

## Step 4: ドキュメント更新

- `CHANGELOG.md` に phase16.4 エントリ
- `config.example.toml` に「**enabled = true にする前に**」セクション追加 + healthcheck の動作説明
- `docs/SETUP.md` に healthcheck セクション (1 段落)

## Step 5: 品質ゲート

- pnpm build / eslint / typecheck / test
- 手動確認: placeholder のまま enabled = true で起動 → 起動失敗
- 手動確認: 実 setup 後の起動 → 通常起動

## サイズ

S〜M (新規ファイル 1 + テスト 1 + 既存 2 ファイル微更新)

## フォロー (別 phase 候補)

- **proxy 実 HTTP 疎通テスト**: Worker 側に `/health` エンドポイント追加 + summaly 起動時に HMAC なしで GET → 200 確認。phase16.4 では placeholder 検出のみで止め、実 HTTP は別 phase で (TODO.md phase16.6 として登録済)

## 実装完了状況 (2026-05-09)

- ✅ Step 1: `bin/healthcheck.ts` 新設 — `runConfigHealthchecks(config)` で proxy / curl_cffi / embed の `enabled = true` 時の placeholder + 実体検証
- ✅ Step 2: `bin/summaly-server.ts` で `parseTomlConfig` 直後に呼び出し
- ✅ Step 3: `test/healthcheck.test.ts` 14 件 (placeholder URL / placeholder secret / 存在しない projectDir / uv 実行不可 / embed publicUrl 等)
- ✅ Step 4: `config.example.toml` の冒頭基本方針コメントに phase16.4 を追記、`CHANGELOG.md` に feat エントリ
- ✅ Step 5: 品質ゲート全パス (build / lint / typecheck / test 573 件)
