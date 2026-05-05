# Cloudflare Workers を outbound proxy として使うパターン

> phase12.1 で導入。Vultr Tokyo IP から amazon.co.jp が IP レピュテーション層で 500 を返す問題を救援する設計。

## 適用判断

このパターンが効くケース:

- ターゲットサイトが **IP レピュテーション層で遮断** している（UA 切替で救えない 5xx / 完全沈黙）
- 自前サーバの outbound IP が datacenter / VPS 帯にある（Vultr / Linode 等）
- Cloudflare の AS13335（Workers/CF edge 帯）からは通る

実証: `https://www.amazon.co.jp/dp/B0C4LRBFX6` で Vultr 500 vs CF Workers 経由 200 (2.6 MB / 1.81 秒)。詳細は [outbound-ip-reputation.md](outbound-ip-reputation.md)。

このパターンが**効かない**ケース:

- IP レピュテーション差ではなく **JA3 fingerprint や Cloudflare Bot Management** で弾かれている → Workers fetch も同じ Cloudflare スタックなので救えない可能性
- TLS バージョン / 暗号スイート差で弾かれている → 同上
- アカウント認証必須のページ → cookie をどう持つか別問題

## ミニマル実装パターン

```ts
// tools/cf-proxy-worker/src/index.ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 1. method/parameters 検証
    if (request.method !== 'GET') return forbidden('method');

    // 2. タイムスタンプ窓検証 (replay 対策、HMAC 計算前にコスト節約)
    const ts = Number(request.headers.get('x-summaly-ts'));
    if (Math.abs(Date.now() - ts) > 5 * 60 * 1000) return forbidden('ts');

    // 3. HMAC 検証 (定数時間比較)
    const expected = await hmacSha256Hex(env.SHARED_SECRET, `${target}\n${ts}`);
    if (!constantTimeEqual(expected, sigHeader)) return forbidden('sig');

    // 4. URL allowlist 検証 (HTTPS only + suffix-match)
    if (target.protocol !== 'https:') return forbidden('https');
    if (!isAllowedDomain(target.hostname, env.ALLOWED_DOMAINS)) return forbidden('domain');

    // 5. fetch + redirect 後の allowlist 再検証 (open proxy 化防止)
    const upstream = await fetch(target.href, { redirect: 'follow' });
    if (!isAllowedDomain(new URL(upstream.url).hostname, env.ALLOWED_DOMAINS)) {
      return forbidden('redirect-bypass');
    }

    // 6. body cap でストリーミング読み取り
    const body = await readWithLimit(upstream, MAX_BYTES);

    // 7. 透過プロキシ (一部ヘッダだけフィルタ)
    return new Response(body, { status: upstream.status, headers: cleanHeaders(upstream.headers) });
  },
};
```

## 設計の決め手

### Web Crypto API ↔ Node std crypto の相互運用

Worker 側 (`crypto.subtle.sign('HMAC')`) と Node 側 (`crypto.createHmac('sha256')`) は **HMAC-SHA256 標準実装** なので、message format を一致させれば相互運用できる:

```ts
// Worker (Web Crypto)
const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${url}\n${ts}`));
// → hex(sig)

// Node std (sign.mjs / src/utils/proxy-fallback.ts)
const sig = createHmac('sha256', secret).update(`${url}\n${ts}`).digest('hex');
```

両方が同じ hex を出す。`\n` 区切りは TOML/YAML 等で混入しにくい安全文字。

### 定数時間比較は length も均一化

```ts
function constantTimeEqual(a: string, b: string): boolean {
  // 長さの差を diff に織り込み、max 長で全ループ
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}
```

`if (a.length !== b.length) return false` の early-return は「特定長を送ったときだけレイテンシが変わる」観測を許す。HMAC hex は固定 64 文字なので実害は薄いが、設計の整合性として全ループ。

### redirect 後の allowlist 再検証 (Critical)

`fetch(target, { redirect: 'follow' })` は CF Workers 内で自動追跡する。allowlist 検証を最初の `target` でしか行わないと、`amazon.co.jp` → `attacker.com` のリダイレクトを許す形でオープンプロキシ化する。**最終 URL (`upstream.url`) の hostname も allowlist 検証する** ことで防ぐ:

```ts
const finalUrl = new URL(upstream.url);
if (!isAllowedDomain(finalUrl.hostname, env.ALLOWED_DOMAINS)) {
  return forbidden('redirect led to non-allowlisted domain');
}
```

これは phase12.1 のレビューで Critical として指摘され修正された。

### suffix-match の境界文字

```ts
function isAllowedDomain(hostname: string, allowedCsv: string): boolean {
  for (const d of allowedCsv.split(',')) {
    if (hostname === d) return true;
    if (hostname.endsWith('.' + d)) return true;  // ← '.' を含めて境界明示
  }
  return false;
}
```

`hostname.endsWith(d)` だけだと `evil-amazon.co.jp` が `amazon.co.jp` の suffix としてマッチする。`'.' + d` で境界を明示するのが定石。

### `redirect: 'manual'` ではなく `'follow'` を選ぶ理由

Plan の初期案では `'manual'` で 3xx を呼出側に返す案もあったが、Amazon の `/dp/<asin>` は内部で 301 →最終商品ページにリダイレクトするケースが普通で、これを Worker 側で解決した方が summaly 側は単純化される。リダイレクト先の allowlist 再検証で安全性を保つ。

### Body の cap はストリーミング読み取り

```ts
async function readWithLimit(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return concatChunks(chunks, total);
}
```

`res.arrayBuffer()` だと cap 越えを事前検知できない。`getReader()` でチャンク単位に累積し、cap 越え時点で `cancel()` する。Workers Free のメモリ上限 (128 MB) を考えると `MAX_BYTES = 5 MiB` でも複数同時ハンドル可能。

## summaly 側組み込みの設計

### 3 段リトライの構造

`getResponse()` (phase11.9 の `getResponseWithFallback` の更に外側) として `getResponseWithProxyFallback()` を被せる:

```
getResponseWithProxyFallback(args, uaFallback, proxyConfig)
├─ try { getResponseWithFallback(args, uaFallback) }   // 1+2 段目 (UA fallback まで)
└─ catch (err) {
     if (proxy 発火条件) viaProxyWorker(args, proxyConfig)   // 3 段目
     else throw err
   }
```

レイヤを混ぜないため、phase11.9 の `getResponseWithFallback` には**触らない**で外側で判定する。phase11.9 の責務は UA 切替のみ。

### 動的 import で循環参照回避

`scpaping()` (got.ts) は `proxy-fallback.ts` を呼び、`proxy-fallback.ts` は got.ts の `getResponseWithFallback` を呼ぶ循環。**動的 import** でランタイム解決にすることで型レベル循環を回避:

```ts
const { getResponseWithProxyFallback } = await import('@/utils/proxy-fallback.js');
```

scpaping の hot path で 1 度だけ呼ばれるためコストは無視できる。

### `Got.Response<string>` への整形

Worker のレスポンスを got の型に擬装する必要がある（`scpaping` は `getResponse` が `Got.Response<string>` を返す前提）:

```ts
const result = {
  ...proxyResponse,
  body: rawBody.toString('utf8'),
  url: finalUrl,           // x-summaly-final-url ヘッダから
  ip: undefined,           // proxy 経由なので unicast 検査はバイパス
} as unknown as Got.Response<string>;
```

`scpaping` が見るのは `rawBody` (encoding 検出) / `headers` (content-type) / `statusCode` / `url` だけなので、最低限揃えれば動く。

## TOML スキーマ + シークレット管理

```toml
[scraping.proxy]
enabled = true
url = "https://summaly-proxy.<your>.workers.dev"
# secret は env SUMMALY_PROXY_SECRET 経由を推奨（TOML 直書き禁止）
categories = ["origin_error"]
domains = ["amazon.co.jp", "amazon.com"]
timeoutMs = 30000
```

シークレットの解決順:
1. `process.env.SUMMALY_PROXY_SECRET`
2. `config.toml` の `secret`
3. どちらも無ければ **stderr に warning + 機能無効化**（起動失敗にしないことで「公開リポに config をコミットしても安全」という運用が可能）

## コスト・運用上の心配点

| 項目 | Free プラン | 留意点 |
|---|---|---|
| Requests | 100,000 / day | Amazon 失敗の頻度から見て十分 |
| CPU 時間 | 10 ms / req | subrequest 待ち時間は含まれない |
| 帯域 | 上限なし | subrequest 単位で 50/req |
| 課金 | **超過しても 429 のみ、金額発生なし** | Paid プランへの自動切替なし |

## 撤退条件

Step 1.3 で実機検証して **NO-GO ならコード捨てる**設計。phase12.1 では GO 確定 (2.6 MB / 200 / 1.81s) したが、将来 Workers fetch の TLS スタック変更や Amazon 側の bot 対策強化で通らなくなる可能性はある。再判定する場合は同じ手順で:

```bash
node tools/cf-proxy-worker/sign.mjs "https://www.amazon.co.jp/dp/B0C4LRBFX6" "$WORKER_URL" | bash | head -c 2000
```

## 関連

- [outbound-ip-reputation.md](outbound-ip-reputation.md) — 背景となる Vultr/Amazon 問題の実証データ
- [bot-block-ua-retry.md](bot-block-ua-retry.md) — phase11.9 (UA レイヤ救援) の知見
- [docs/plans/phase12.1-cf-workers-proxy-fallback.md](../plans/phase12.1-cf-workers-proxy-fallback.md) — Plan
- [tools/cf-proxy-worker/README.md](../../tools/cf-proxy-worker/README.md) — Worker デプロイ手順
- [src/utils/proxy-fallback.ts](../../src/utils/proxy-fallback.ts) — summaly 側組み込み
