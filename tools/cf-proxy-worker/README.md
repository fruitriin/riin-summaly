# summaly outbound proxy worker (phase12.1)

> 状態: **本番稼働中** (2026-05-06 GO 確定 + followup #1〜#4 で本番救援動作確認済み)
> 用途: Vultr Tokyo の outbound IP では amazon.co.jp が UA 関係なく 500 を返す問題（[knowhow/outbound-ip-reputation.md](../../docs/knowhow/outbound-ip-reputation.md)）を、Cloudflare Workers Free 経由のアウトバウンド proxy で救援。

## 本フェーズの位置づけ

phase12.1 [Plan](../../docs/plans/phase12.1-cf-workers-proxy-fallback.md) は **完了**。本 Worker は本番運用中で、`amzn.asia` 短縮 URL / 長 query 付き / bare hostname など全 URL バリエーションで Amazon 商品ページ取得が通る状態。

新規導入時の手順 (デプロイ + 認証セットアップ + 動作確認) は下記の各セクションを参照。

## 構成

```
tools/cf-proxy-worker/
├── package.json     — wrangler / workers-types のみ。**summaly 本体の package.json には影響しない**
├── tsconfig.json    — Workers 専用 (lib: ES2022, types: workers-types)
├── wrangler.toml    — Free プラン用設定 + ALLOWED_DOMAINS / MAX_BODY_BYTES env vars
├── src/index.ts     — ~150 行: HMAC 検証 + URL allowlist + fetch 透過
├── sign.mjs         — curl テスト用の HMAC 署名生成スクリプト (Node std crypto)
└── README.md        — 本ファイル
```

`tools/` ディレクトリは summaly のルート `package.json` の `files: ["built", "LICENSE"]` 対象外なので、**npm publish には含まれない**（summaly を `npm install` する利用者は影響を受けない）。

## デプロイ手順 (オーナー実行)

### 0. 前提

- Cloudflare アカウント（無料）が必要。アカウント作成 → wrangler ログイン:
  ```bash
  npx wrangler login
  ```

### 1. 依存インストール

リポジトリルートで:

```bash
cd tools/cf-proxy-worker
npm install   # pnpm から workspaces にしていないので独立 npm install
```

### 2. 共有シークレット設定

```bash
# 適当に強いシークレットを生成
SECRET=$(openssl rand -hex 32)

# Worker に設定（ローカルには保存しない）
echo "$SECRET" | npx wrangler secret put SHARED_SECRET
```

このシークレットは後で summaly 側にも `SUMMALY_PROXY_SECRET` 環境変数で渡す。`.env` 等に保存して紛失しないこと。

### 3. デプロイ

```bash
npx wrangler deploy
```

成功すると `https://summaly-proxy.<your-account>.workers.dev` のような URL が出る。これを以降の検証で使う。

## Step 1.3 — GO/NO-GO 実験手順

**目標**: CF Workers 経由で Amazon URL が 200 + HTML を返すか確認する。

### 検証コマンド

```bash
export SHARED_SECRET="<wrangler secret put した値>"

# 1. 署名済み curl コマンドを生成（出力を確認）
WORKER_URL="https://summaly-proxy.<your>.workers.dev"
node sign.mjs "https://www.amazon.co.jp/dp/B0C4LRBFX6" "$WORKER_URL"

# 2. 内容を確認した上で実行
node sign.mjs "https://www.amazon.co.jp/dp/B0C4LRBFX6" "$WORKER_URL" | bash | head -c 2000
```

> ⚠️ `| bash` で実行する前に、必ず生成された curl コマンドの内容を確認すること。`sign.mjs` は引数の URL 形式を検証しシェル危険文字を弾くが、防衛深度として目視確認を推奨する。

### 結果別の判断

| 結果 | 判断 |
|---|---|
| 200 + HTML（`<title>` や `<meta property="og:image">` を含む） | **GO** → Step 2 以降の summaly 側組み込みに進む |
| 500 / 503 / Amazon の bot 検知ページが返る | **NO-GO** → 撤退、worker 削除 + knowhow に「CF Workers でも Amazon は通らない」を追記 |
| 403 + `forbidden` のみ | Worker 内部のバリデーション失敗。`wrangler tail` でログ確認、HMAC やタイムスタンプを再確認 |
| ネットワークエラー | デプロイ自体が失敗している。`wrangler deploy` のログを確認 |

### NO-GO 時の撤退手順

```bash
npx wrangler delete
cd ../../   # リポルートに戻る
git rm -r tools/cf-proxy-worker/
# docs/knowhow/outbound-ip-reputation.md に「CF Workers Free でも Amazon は通らなかった (実証 YYYY-MM-DD)」を追記
# docs/plans/phase12.1-cf-workers-proxy-fallback.md に「撤退判定: <日付>」を明記
```

### GO 後の進捗 (履歴)

phase12.1 GO 確定 (2026-05-05) 後、Step 2〜7 + followup #1〜#4 まですべて完了済み。詳細は [Plan](../../docs/plans/phase12.1-cf-workers-proxy-fallback.md) 参照。残るのは Step 5 (pino `proxyAttempted`/`proxySucceeded` フィールド) のみで、これは phase11.6 deferral と合流予定。

## 動作確認 (`wrangler dev` ローカル実行)

デプロイ前にローカルでも動作確認できる:

```bash
cd tools/cf-proxy-worker
echo "test-secret" | npx wrangler secret put SHARED_SECRET --local  # ローカル secret
npx wrangler dev    # http://localhost:8787 で起動

# 別ターミナルで
export SHARED_SECRET="test-secret"
node sign.mjs "https://www.example.com/" "http://localhost:8787" | bash
```

## セキュリティ防衛層 (整理)

オープンプロキシ化を防ぐため、以下を多層で適用:

1. **HTTPS 限定** — `target.protocol !== 'https:'` は 403
2. **HMAC-SHA256 + 共有シークレット** — `target_url\ntimestamp` を署名。秘密鍵を知らないと有効リクエストを作れない
3. **タイムスタンプ窓 ±5 分** — replay 攻撃の有効期間を 5 分に限定
4. **ドメイン allowlist (Worker 側)** — `wrangler.toml` の `ALLOWED_DOMAINS` env var (Worker 環境変数で上書き可)
5. **ドメイン allowlist (summaly 側)** — `[scraping.proxy].domains` で独立に持つ。Worker 側と summaly 側の **両方で許可されないと通らない**
6. **受信ボディ上限** — `MAX_BODY_BYTES` (デフォルト 5 MiB)、巨大ファイル送り込み防止
7. **定数時間比較** — HMAC 検証でタイミング攻撃を防ぐ
8. **403 で詳細を返さない** — attacker に情報を与えない（理由は Worker のログに残るだけ）

## Free プランの上限

- **100,000 req/day** — Amazon 失敗の頻度（1 日数十〜数百件と推定）から見て十分
- **10ms CPU/req** — `fetch` の subrequest 待ち時間は CPU 時間に含まれない
- **超過時の挙動**: 429 を返すだけ。**金額課金は発生しない**（Paid プランへの自動切替は無い設計）

## 型チェック

Worker の TypeScript は **メイン summaly の `pnpm typecheck` 対象外** です（独立 tsconfig + workers-types 使用）。Worker 側の型チェックは:

```bash
cd tools/cf-proxy-worker
npm install
npx tsc --noEmit
```

CI に組み込む場合は Step 2 (Worker 本実装) で別 GitHub Actions ジョブとして追加する想定。

## 監視 / ログ

```bash
# リアルタイムログ
npx wrangler tail

# 過去ログ (Workers Analytics)
# https://dash.cloudflare.com/<account>/workers-and-pages/view/summaly-proxy
```

## 関連

- [docs/plans/phase12.1-cf-workers-proxy-fallback.md](../../docs/plans/phase12.1-cf-workers-proxy-fallback.md) — Plan
- [docs/knowhow/cf-workers-outbound-proxy.md](../../docs/knowhow/cf-workers-outbound-proxy.md) — Worker 設計と運用知見 (followup #1〜#5)
- [docs/knowhow/amazon-url-normalization.md](../../docs/knowhow/amazon-url-normalization.md) — Amazon URL 正規化と短縮 URL 対応
- [docs/knowhow/outbound-ip-reputation.md](../../docs/knowhow/outbound-ip-reputation.md) — 背景となる Vultr/Amazon 問題の実証データ
- [docs/knowhow/bot-block-ua-retry.md](../../docs/knowhow/bot-block-ua-retry.md) — phase11.9 (UA レイヤ救援) の知見
