# curl_cffi (libcurl-impersonate) で TLS layer bot block を救援

## 課題

一部のサイトは **TLS layer での bot detection** を実装している:

- JA3 / JA4 フィンガープリント検査 (TLS ClientHello の cipher suite / extension 順序)
- HTTP/2 settings frame の検査
- ブラウザ固有の HTTP ヘッダ送信順 / 値検査

**Node.js (undici / Node TLS)** や **Cloudflare Workers fetch** は TLS フィンガープリントが
固定で、ブラウザを偽装できない。`got` の `User-Agent` を変えても TLS layer で先に弾かれる。

実例:

- `yodobashi.com` — HTTP/2 INTERNAL_ERROR で即時切断 (UA を変えても回避不可)
- 多くの EC / メディアサイトが同様の挙動を見せる

## 解決策

[curl_cffi](https://github.com/lexiforest/curl_cffi) は
[libcurl-impersonate](https://github.com/lwthiker/curl-impersonate) の Python バインディングで、
**Chrome / Firefox / Safari の TLS フィンガープリントを完全再現** する。

```python
from curl_cffi import requests
res = requests.get(url, impersonate='chrome120')
# TLS ClientHello / HTTP/2 settings / header 順 すべて Chrome 120 を再現
```

### 動作確認 (2026-05-06)

- 対象: `https://www.yodobashi.com/product/100000001003176109/`
- 結果: `status: 200`、`text/html;charset=UTF-8`、body 約 300 KB
- OGP 完全取得確認: `og:title` / `og:description` / `og:image` / `og:url` / `og:site_name`
- 既存実装 (`got` + UA 偽装) では HTTP/2 INTERNAL_ERROR で取得不能だった

## 統合パターン

Node.js から呼ぶには **stdio JSON で疎結合** な spawn-per-request が最も単純。
phase12.5 Step 2 で実装した [src/utils/curl-cffi-fetch.ts](../../src/utils/curl-cffi-fetch.ts) のパターン:

### 段階的フォールバック (4 段カスケード)

既存の proxy fallback (phase12.1) と同じ構造で **4 段目** として組み込む:

```text
1. デフォルト UA で取得 (got)
2. 失敗 + UA レイヤで救えるカテゴリ → fallback UA リトライ (phase11.9)
3. それでも失敗 + categories 一致 + domains 一致 → CF Worker proxy (phase12.1)
4. それでも失敗 + curl_cffi categories 一致 + curl_cffi domains 一致 → curl_cffi (phase12.5)
```

`getResponseWithCurlCffiFallback` が `getResponseWithProxyFallback` をラップする形:

```ts
// scpaping (got.ts) からの動的 import で循環参照を回避
const { getResponseWithCurlCffiFallback } = await import('@/utils/curl-cffi-fetch.js');
const response = await getResponseWithCurlCffiFallback(args, fallback, opts?.proxyFallback, opts?.curlCffiFallback);
```

### spawn-per-request の防衛パターン

```ts
const proc = spawn(cfg.uvPath, [
    'run', 'fetch', url,
    '--impersonate', cfg.impersonate,
    '--timeout', String(responseTimeoutSec),
    '--max-bytes', String(maxBytes),
], {
    cwd: cfg.projectDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    // shell: false (デフォルト) — argv が直接 execve される。shell injection 不可能
});

// `error` と `exit` の両方が発火するケース (signal 終了等) で resolve/reject が
// 二重に呼ばれないよう settle ガード必須
let settled = false;
const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(killTimer);
    fn();
};

const killTimer = setTimeout(() => {
    proc.kill('SIGKILL');
    settle(() => reject(new Error(`spawn timeout`)));
}, cfg.timeoutMs);

proc.on('error', err => settle(() => reject(/* ENOENT for uv 等 */)));
proc.on('exit', code => settle(() => resolve({ stdout, exitCode: code })));
```

### 8 層防御 (proxy fallback と同等)

1. **`spawn` を `shell: false` (デフォルト) で呼ぶ** — argv が直接 execve、shell injection 不可能
2. **URL は `https:` 限定** — wrapper の gating でプロトコル検証 (二重防御)
3. **ドメイン allowlist (suffix-match)** — 任意 URL ブラウザ偽装の悪用防止
4. **categories gating** — 4 段目発火条件を最小限に絞る (デフォルト `[timeout, connection_dropped, bot_blocked]`)
5. **子プロセス timeout** — `setTimeout` + `SIGKILL` で強制終了
6. **type filter 再検証** — CLI の `content_type` を呼出側 typeFilter で再検証
7. **body サイズ cap** — `--max-bytes` (CLI 側) + Node 側 `contentLengthLimit` の二重防御
8. **final URL の安全な再検証** — `new URL()` で http(s) 限定 + 不正なら args.url を維持

### エンコーディング契約 (重要)

`got` 経路では `rawBody` (バイト列) を `detectEncoding` → `toUtf8` で再変換するが、
**curl_cffi 経路では Python 側で既にデコード済みのため二重変換しない**。CLI の
`fetch.py` は `curl_cffi.requests.Response.text` (Content-Type charset または chardet で
デコード済み) を JSON 文字列に乗せて返す。Node 側は `Buffer.from(body, 'utf8')` で
固定的に UTF-8 として扱う。

non-UTF-8 (古い ISO-8859-1 等) サイトで万が一文字化けが起きた場合は、CLI 側を
`body_base64` で生バイト列を返すスキーマに拡張するのが正攻法 (現状未実装)。

### TOML config の設計

```toml
[scraping.curl_cffi]
enabled = false                                    # デフォルト false (オプトイン)
projectDir = "/path/to/tools/curl-cffi-fetcher"   # 必須 (絶対 or cwd 相対)
uvPath = "uv"                                      # PATH 上に `uv` があれば省略可
impersonate = "chrome120"                          # firefox120 / safari17_0 等
categories = ["timeout", "connection_dropped", "bot_blocked"]
domains = ["yodobashi.com"]                        # 必須、空配列禁止
timeoutMs = 30000
```

`enabled = false` がデフォルトで **オプトイン制御**。`domains` 必須 + 空配列禁止で
allowlist の明示性を強制。`uv` 未インストールの production 環境でも summaly 起動は
失敗しない (4 段目発火時に ENOENT で詳細メッセージ付き throw、原エラーは proxy 段から伝播)。

実装本体は [tools/curl-cffi-fetcher/](../../tools/curl-cffi-fetcher/) と
[src/utils/curl-cffi-fetch.ts](../../src/utils/curl-cffi-fetch.ts) を参照。

## 設計判断

### Python / uv を選んだ理由

- `curl_cffi` は libcurl-impersonate の最もメンテされているバインディング
- `uv` でプロジェクト隔離 → summaly 本体の pnpm 環境に Python 依存を持ち込まない
- 通信は stdio JSON で疎結合 (HTTP / Unix socket より単純)

### 撤退条件

- spawn コストが許容できない (1 リクエスト 500ms 超える等)
  → daemon 化 (stdin で URL 連続受信) に移行
- production 環境で `uv` 配備の運用負担が大きすぎる
  → CF Workers 経由に戻す or 諦めて `got` で `null` 返す
- vendor が curl_cffi の偽装を検知し始める
  → impersonate target を更新、それでも無理なら撤退

### npm publish 対象から外す

- `tools/` 配下は `package.json` の `files: ["built", "LICENSE"]` で **publish 対象外**
- 利用者が `npm install summaly` しても Python ツールは降りない
- production server で別途 `cd tools/curl-cffi-fetcher && uv sync` する設計

### 許可ドメイン制御の必要性

- curl_cffi で叩ける URL は **summaly 側で allowlist** すべき
- 任意 URL を ブラウザ偽装で叩けるツールを scraping bridge として晒すと、
  unauthorized access / scraping 不当利用のリスクが上がる
- yodobashi / nintendo-store 等の **OGP 取得目的に限定** し、
  ログイン・購入などの自動化用途では使わない

## 関連 phase

- phase11.9: bot block UA リトライ (UA 偽装は層が違うが類似目的)
- phase12.1: CF Workers proxy fallback (IP block 救援、TLS は CF の固定 fp に依存)
- phase12.4: yodobashi プラグイン (proxy categories 拡張、TLS は未対応)
- phase12.5: curl_cffi 統合 (本 knowhow が記録する実験フェーズ)
