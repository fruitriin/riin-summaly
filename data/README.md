# `data/` — リポ同梱データ

> 導入: phase14 Step 3 (2026-05-08)。bootstrap データの設計詳細は `docs/knowhow/domain-strategy-cache.md` 参照。


このディレクトリには summaly が起動時に読むリポ知見データが入っています。`package.json` の `files` で npm publish 対象に含まれており、利用者の `node_modules/@misskey-dev/summaly/data/` 配下に配備されます。

## `domain-strategy-bootstrap.jsonl`

経路学習キャッシュ (phase14) の **bootstrap データ**。host + path prefix 1〜2 段ごとに「過去の運用でこの経路が正解と判明している組」を 1 行 1 エントリで記録しています。

### スキーマ

各行は `DomainStrategyEntry` (TypeScript) の JSON シリアライズ:

```jsonc
{
  "pathKey": "yodobashi.com",          // host または host/segment[/segment]
  "strategy": "curl_cffi",              // 'default' | 'fallback_ua' | 'proxy' | 'curl_cffi'
  "successCount": 1,                    // 名目上 1 (bootstrap は「初期値」、実際の学習は runtime で蓄積)
  "consecutiveFailures": 0,             // bootstrap は常に 0 (bootstrap ロード時に強制 0 にリセットされる)
  "lastSuccessAt": 0,                   // bootstrap origin = epoch (実際の値は実行時に上書き)
  "lastAttemptAt": 0                    // 同上
}
```

### 挙動

- `summaly` (Fastify モード) が起動時に `[scraping.strategy_cache].enabled = true` のとき、`bootstrapPath` 未指定なら本ファイルを自動的にロードする (Step 3 で配備済)
- ファイル末尾に近い行が後勝ち (= 同 pathKey が複数行あれば末尾優先)
- `consecutiveFailures` は **bootstrap ロード時に常に 0 にリセット** される (誤って `>= threshold` の値を書いてもエントリが消えない、phase14 Step 1 設計判断)

### 新サイト追加の流れ

「このサイトはこの経路でしか取れない」と判明したら:

1. **(従来)** プラグインに `forceCurlCffiFallback: true` 等を追加 → コミット → デプロイ
2. **(現在)** 本ファイルに 1 行追加 → コミット → デプロイ

プラグインを書く必要は「独自 DOM パース」「公式 API 直叩き」「URL 正規化」 等の **「引き出し方の自在性」** が必要なケースのみ。経路選択 (どの強度の bot block 回避を使うか) は経路学習キャッシュに任せる。

### エントリ選定基準

- **`curl_cffi`**: TLS layer で bot 切断するサイト (HTTP/2 INTERNAL_ERROR / 即時 socket 切断)。yodobashi が典型例
- **`proxy`**: データセンター IP レピュテーションで弾かれるサイト (HTTP 5xx, または HTTP 200 + 正規 404 ページ)。Vultr Tokyo IP からの amazon.co.jp / sqex e-STORE が典型例
- **`fallback_ua`**: SummalyBot 文字列で WAF が弾くが他 UA で通るサイト。**bootstrap には基本入れない** (phase11.9 の動的 UA リトライで救援可能、bootstrap で固定すると将来の WAF 変化で追従しにくい)
- **`default`**: 通常の OGP 取得で取れるサイト。**bootstrap には基本入れない** (デフォルト挙動なので明示する意味が薄い)

### 個別エントリの判断メモ (S-2 review feedback)

- **`amazon.com/gp` を入れていない理由**: phase12.1 followup の実証は `amazon.co.jp` 中心 (Vultr Tokyo IP 起点)。`amazon.com` の `/gp` 配下も同じ IP block の対象になりうるが、運用環境 (US 拠点等) では Cloudfront エッジ近接で救援不要なケースもあるため、実証データが揃うまで bootstrap には入れない方針。`amazon.com` で `/gp` 関連の取得が遅い / 失敗する報告が来たら 1 行追加する

### 運用上の注意

- 削除されたサイトのエントリを残しておいても無害 (lookup 時は HTTP リクエストでエラーになり cache 側で N 連続失敗で破棄される)
- 巨大化した場合は手動で整理。1 サイト = 1〜数行が標準
- **PR レビュー時のチェック**: 新規エントリが `curl_cffi` / `proxy` であれば、対応する config (`[scraping.curl_cffi].domains` / `[scraping.proxy].domains`) にも対象 host が含まれているか確認 (allowlist 通らないと bootstrap 値があっても fast path で gate-fail neutral fallthrough になる)
