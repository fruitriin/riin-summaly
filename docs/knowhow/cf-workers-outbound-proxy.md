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

## phase12.1 followup で得た運用上の落とし穴

GO 判定 + Step 1〜7 完了後、**本番ログを観察しながら 4 回の followup を経て** ようやく実用稼働。設計時には予見できなかった現実問題と対処パターンを記録する。

### #1: `Rejected by type filter undefined` は隠れた bot block

**症状**: 本番ログに `category: "unsupported_type"` で `errorMessage: "Rejected by type filter undefined"` が出る。proxy fallback は `categories: ["origin_error"]` だけをデフォルト発火対象にしていたため救援されない。

**原因**: Amazon が Vultr Tokyo IP に対して **`200 OK + content-type ヘッダ欠落`** という malformed response を返す bot block 形態を持つ。`getResponse` の typeFilter 検証が undefined content-type で reject → "Rejected by type filter undefined" → categorize が `unsupported_type` に分類。

**対処**:
- `categorizeError` で `Rejected by type filter undefined` だけを `bot_blocked` に振り分ける（明示的な非 HTML PDF などは引き続き `unsupported_type`）
- proxy fallback の default categories を `['origin_error', 'bot_blocked']` に拡張

**教訓**: **「200 + 異常ヘッダ」は bot block の隠れた形態として頻繁に使われる**。HTTP ステータスコードだけ見ていると見逃すので、エラーメッセージに含まれる malformed signal も category 判定に組み込む。

### #2: 本番ログの stack trace が問題箇所を秒で特定する

**症状**: ある Amazon URL だけ proxy 経由でも 500 が返る。

**ログの黄金行**:
```
StatusError: 500 Internal Server Error
    at viaProxyWorker (/root/summaly/src/utils/proxy-fallback.ts:165:9)
    at scpaping (/root/summaly/src/utils/got.ts:150:19)
    at general (/root/summaly/src/general.ts:181:14)   ← これ重要
```

`general` フレームが見えた瞬間「**amazon プラグインを通っていない**」が確定。`amazon.test()` の `===` 比較で `www.amazon.co.jp` 限定だったため、bare `amazon.co.jp` が general パスに流れていたバグが見えた。

**教訓**: pino でエラー stack を出すなら `err.stack` 全文を残す。「どの関数経由で来たか」が原因切り分けの 90% を占める。phase11.8 で `err` を手動シリアライズしているが、`stack` は必ず含める設計を維持。

### #3: 認証スキームミスマッチを段階的に切り分けるデバッグ手順

**症状**: 本番 summaly が proxy 経由で 403 / 500 を受け取るが、curl 直叩きでは Worker は 200 を返す。

**根本原因**: 本番 Worker が **HMAC-based** から **token-based** にスキーマ変更されていて、summaly 側 (HMAC を送る) と非互換だった。さらに secret も不一致のケースがあった。

**段階的切り分け手順** (`tools/cf-proxy-worker/test-auth-stages.sh` で自動化):

| Stage | コメントアウトを外す範囲 | 期待動作 |
|---|---|---|
| 1 | 全 auth コメントアウト | ヘッダ無し GET → 200 (透過プロキシのみ) |
| 2 | param 必須チェック | sig/ts ヘッダ無しは 403 / ダミー値で 200 |
| 3 | timestamp 窓チェック | 古い ts は 403 / 現在時刻なら 200 |
| 4 | HMAC 完全検証 | 正しい sig (sign.mjs) で 200 / 不正は 403 |

各 Stage で「どの認証層で壊れたか」をピンポイント特定できる。**段階的に絞り込めば 4 段階で必ず原因にたどり着く**。

### #4: allowlist は **両側同期義務** を明文化する

Worker `wrangler.toml` の `ALLOWED_DOMAINS` と summaly `[scraping.proxy].domains` は独立に管理される。**片方だけ更新すると proxy 発火と Worker 側許可が乖離して混乱**する。

phase12.1 followup #4 で `amzn.asia` を summaly 側 domains に追加したとき、Worker 側にも同期する必要があった。手順を docs に明記:

```bash
# 1. Worker 側
vim tools/cf-proxy-worker/wrangler.toml   # ALLOWED_DOMAINS に追加
cd tools/cf-proxy-worker && npx wrangler deploy

# 2. summaly 側
vim /etc/summaly/config.toml              # [scraping.proxy].domains に同じ値
sudo systemctl restart summaly
```

将来的には Worker から `/api/config-check` 等で allowlist を取得して summaly が自動同期する設計余地はあるが、現状は **目視 + コメント** での同期義務管理。

### #5: 本番テスト URL は **複数バリエーション** で踏み込み調査する

phase12.1 GO 判定 (Step 1.3) で `dp/B0C4LRBFX6` 1 件で GO したが、**実は `dp/<asin>?long_query` や `amzn.asia/d/xxx` (短縮 URL) は別挙動**だった。

教訓: 「Amazon が proxy 経由で取れる」を実証する curl テストは:
- 短い canonical URL (`/dp/<asin>`)
- 長い query 付き (`/dp/<asin>?_encoding=...&ref_=...`)
- SEO slug 付き (`/<日本語slug>/dp/<asin>/`)
- bare hostname (`amazon.co.jp/...` without www)
- 短縮 URL (`amzn.asia/d/<id>`)

**4〜5 パターン全部叩いて動作確認**するのが正しい GO 判定。1 パターンだけだと本番で穴が残る。

## phase12.6 で発見: エラーシグナルなし IP block (HTTP 200 + 404 ページボディ)

**症状**: SQEX e-STORE (`store.jp.square-enix.com/item/MWFF140773_2.html`) を本番 (Vultr Tokyo) から取得すると、ステータスは `HTTP/200 OK`、`content-type: text/html;charset=utf-8` で完全に正常レスポンス。**だがボディは正規の 404 ページ HTML** (`<title>404 NOT FOUND</title>` 入り)。ローカル MacOS から curl すると同 URL で 200 + 完璧な OGP (`og:title` / `og:description` / `og:image` / `og:site_name`) が返る。

**意味**: **データセンター IP レンジ全般を CDN 段で広く弾く** タイプ。SQEX は CloudFront 経由で配信していて、Vultr Tokyo の IP レンジを「悪い IP」として認識し、200 で 404 ページを返却する設計。HTTP 層では何のエラーシグナルも出ない (status code, content-type, content-length すべて妥当) ため、phase12.1 の `getResponseWithProxyFallback` (エラーカテゴリベース発火) では **救援できない**。

### 救援パターン: 経路学習キャッシュ + bootstrap (phase14 で `forceProxyFallback` を廃止)

phase12.6 では `forceProxyFallback: true` (1〜2段目スキップして CF Workers proxy 直行) フラグでこの新パターンを救援していたが、**phase14 Step 4 で廃止**。

代替: phase14 Step 3 で導入した `data/domain-strategy-bootstrap.jsonl` に `store.jp.square-enix.com → proxy` エントリを入れることで、`scpaping()` 冒頭の cache hit fast path が proxy を直接呼ぶ経路に統合された。`forceX` フラグを書く代わりに bootstrap.jsonl に 1 行追加するだけで新サイトを登録できる仕組み。

**設計の進化**:

```
phase12.6 (旧):
  プラグイン → forceProxyFallback: true → got.ts で proxy 直行分岐

phase14 Step 4 (新):
  bootstrap.jsonl: {"pathKey":"store.jp.square-enix.com","strategy":"proxy",...}
  → scpaping() 冒頭で cache lookup → hit → fetchByStrategy('proxy') → viaProxyWorker
```

### 「`forceCurlCffiFallback` と `forceProxyFallback` の排他性」 (歴史的記述)

phase12.6 時点では両方 `true` を指定した場合 `forceCurlCffiFallback` が優先される設計だったが、phase14 Step 4 で両フラグが廃止されたため、本記述は**歴史的な経緯のみ**。経路学習キャッシュでは entry の `strategy` フィールドが 1 つの値 (`default` / `fallback_ua` / `proxy` / `curl_cffi`) を持ち、排他性が型レベルで保証されている。

### 教訓: 「黒箱比較」が切り分け早さを決める

切り分けの最速ルートは、ローカルから curl + 本番から curl の **黒箱比較**:

```bash
# ローカル (我が家の IP) — 200 + OGP 完備
curl -sS -L -A 'SummalyBot/...' "$URL" -o /tmp/local.html
grep -oE '<title[^>]*>[^<]+</title>' /tmp/local.html  # → ファイナルファンタジーXIV...

# 本番 (Vultr Tokyo IP) — 200 だがボディが 404 ページ
ssh summaly "curl -sS -L ... | grep -oE '<title[^>]*>[^<]+</title>'"  # → 404 NOT FOUND
```

**1 分で fail mode 確定**できる。pino ログの段階的計測より黒箱比較の方が情報密度が高い。skill `/url-preview-check` の Phase 1 (本番ログ) より前段に「ローカル vs 本番の curl 比較」を置くと診断が速い (phase12.5 followup の `time curl` 比較セッションで得た教訓と同根)。

## 関連

- [outbound-ip-reputation.md](outbound-ip-reputation.md) — 背景となる Vultr/Amazon 問題の実証データ
- [bot-block-ua-retry.md](bot-block-ua-retry.md) — phase11.9 (UA レイヤ救援) の知見
- [amazon-url-normalization.md](amazon-url-normalization.md) — Amazon URL の canonical 化と短縮 URL 対応 (phase12.1 followup の Amazon 特化編)
- [docs/plans/phase12.1-cf-workers-proxy-fallback.md](../plans/phase12.1-cf-workers-proxy-fallback.md) — Plan
- [tools/cf-proxy-worker/README.md](../../tools/cf-proxy-worker/README.md) — Worker デプロイ手順
- [tools/cf-proxy-worker/test-auth-stages.sh](../../tools/cf-proxy-worker/test-auth-stages.sh) — 認証段階的復活デバッグ
- [src/utils/proxy-fallback.ts](../../src/utils/proxy-fallback.ts) — summaly 側組み込み
