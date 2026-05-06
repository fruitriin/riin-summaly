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

Node.js から呼ぶには **stdio JSON で疎結合** な spawn-per-request が最も単純:

```ts
import { spawn } from 'node:child_process';
const proc = spawn('uv', ['run', 'fetch', url], { cwd: TOOL_DIR });
let stdout = '';
proc.stdout.on('data', chunk => { stdout += chunk; });
await new Promise(resolve => proc.on('exit', resolve));
const result = JSON.parse(stdout);  // {status, body, headers, ...}
```

実装本体は [tools/curl-cffi-fetcher/](../../tools/curl-cffi-fetcher/) を参照。

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
