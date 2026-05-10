# phase18 — Hedged fallback (champion / challenger 並列発火) で経路選定を全自動化

## 背景

phase14 で経路学習キャッシュ (`pathKey → strategy`) を導入し、bootstrap JSONL で「人間が観測した最適経路」を初期登録できるようになった。これにより yodobashi (curl_cffi) / sqex (proxy) などの新サイトを bootstrap 1 行追加で救援できる構造が確立した。

ただし以下の課題が残っている:

1. **新サイト追加に人間の観察が必要**: 新しく救援したいサイトについて、どの経路が valid を返すか手動で curl 比較してから bootstrap に書く必要がある (このスキル `/url-preview-check` の Phase 2〜4 が手作業)
2. **`[scraping.curl_cffi].domains` / `[scraping.proxy].domains` の allowlist が運用者依存**: bootstrap に書かれていても、運用者が config の domains にも書かないと curl_cffi/proxy 経路は発火しない (二重管理)
3. **学習キャッシュが間違ったときの自動 recovery が無い**: 過去 strategy が使えなくなった (サイト側 TLS 仕様変更 / WAF ルール変更 / 復旧) ときに毎回失敗を繰り返してしまう
4. **monotaro クラスのサイトを救援するたびに phase 起票が必要**: 経路問題だけのサイト (TLS 偽装で取れる、URL 正規化や DOM 直読みは不要) でも個別対応の手数が大きい

オーナーからの提案:

> 第一候補が失敗したら、もしくは2番目以降の候補が解決に5秒以上時間がかかる場合は残りの方法全部を並列で実行して、Validな結果が取得できるもので最速なものを採用、優先経路に拾い上げる
>
> 第一候補だけは特権で、第二候補からは並列リクエスト候補という扱い
>
> 永久除外はサイト側の要因だし、それこそ500エラーとかの可能性もあるし、タイムアウトするようなリクエスト投げたって、繰り返すわけじゃないなら投げちゃったっていい

これは Google "The Tail at Scale" の hedged request パターンに champion / challenger 階層を組み合わせた設計。

## ゴール

- **champion / challenger pool 構造** を導入: 学習キャッシュは pathKey → 1 strategy (= champion) のみ記録、それ以外は順位なしの challenger プール
- **champion 失敗 or 5 秒遅延** をトリガに challenger 全員を **並列起動 (`Promise.any`)**、最速 valid 結果を採用
- **勝者を即座に新 champion に昇格** (1 回で昇格、N 連続要件なし)
- **降格・除外メカ無し** (オーナー判断: 並列発火がレアイベントなら無駄経路への投入も許容)
- `[scraping.curl_cffi].domains` / `[scraping.proxy].domains` の **allowlist 撤廃** (経路選定はすべて hedged race で動的決定)
- curl_cffi 経路に **Python 側 SSRF ガード追加** (allowlist 撤廃の代替防御)
- 結果として: **monotaro クラス (経路問題だけのサイト) は phase 起票なしで自動救援される** + **sqex / yodobashi のような「経路問題だけのプラグイン」は plugin ファイル不要になる可能性が出てくる** (引き出し方の自在性が必要なプラグインだけ残す)

## 設計詳細

### 状態構造

```typescript
// 永続化対象 (phase14 既存構造をそのまま流用)
interface DomainStrategyEntry {
  pathKey: string;
  strategy: 'default' | 'fallback_ua' | 'proxy' | 'curl_cffi'; // = champion
  successCount: number;
  consecutiveFailures: number;
  lastSuccessAt: number;
  lastAttemptAt: number;
}

// 動的導出 (永続化しない)
type Challengers = ReadonlySet<Strategy>;
// = ALL_STRATEGIES - champion - 連続失敗除外 (※ phase18 では除外なし、全 strategy - champion)
```

### 経路一覧 (固定)

```typescript
const ALL_STRATEGIES = ['default', 'fallback_ua', 'proxy', 'curl_cffi'] as const;
```

将来 `playwright` (phase15.1) を追加する際もこの配列に足すだけで全 path で hedge 候補入りする。

### 発火ロジック

```
1. lookup pathKey → champion (phase14 既存ロジック流用)
2. champion strategy で fetch 開始 (AbortController A 紐付け)
3. champion が 5 秒以内に valid を返す
   → そのまま採用、challenger 起動なし (= 安定状態の通常経路)
4. champion が 5 秒経過 or 失敗
   → challengers (= ALL - champion) を全員並列起動 (それぞれ AbortController B/C/D 紐付け)
   → champion も継続実行 (cancel しない、まだ valid を返す可能性ある)
5. Promise.any 相当で「最速の valid 結果」を採用
   → 採用した経路以外を全部 abort
6. 勝者が champion でなければ → 即座に新 champion へ昇格 (phase14 のキャッシュ更新 hook)
```

### 「Valid」判定基準

`isThinSummary` (phase10.1 / 11.7) を流用。preview HTML 詐欺 / SPA shell / Akamai challenge 等の thin な結果を invalid 扱いして他経路を待つ。

```typescript
function isValidResult(summary: Summary | null, url: URL): boolean {
  if (summary == null) return false;
  if (isThinSummary(summary, url)) return false;
  return true;
}
```

注意点: 全経路が thin を返すケースもある (= 構造的に preview 取れないサイト)。この場合は thin な結果のうち最速を採用 (fail mode I 等は救援不能、user 体感は preview なし)。

```typescript
// Promise.any で valid を待ち、全部 invalid なら最速の thin/error を返す
async function hedgedRace(strategies: Strategy[]): Promise<Summary | null> {
  const promises = strategies.map((s) => fetchByStrategy(s));
  try {
    return await Promise.any(promises.map((p) => p.then((r) => isValidResult(r, url) ? r : Promise.reject(r))));
  } catch {
    // 全 reject = 全 invalid。最速の結果を返す
    return await Promise.race(promises);
  }
}
```

### timeout 設計

経路ごとに独立 timeout を設定:

| 経路 | timeout | 理由 |
|---|---|---|
| default (got) | 20s | phase14 既存維持 |
| fallback_ua (got) | 20s | phase14 既存維持 |
| proxy (CF Workers) | 25s | Worker fetch + upstream の合算余地 |
| curl_cffi | 30s | Python subprocess spawn + libcurl-impersonate のオーバーヘッド |

並列発火後の **全体 timeout** は 35s (= 最長経路 + 安全マージン) 程度で打ち切り、それでも valid が出なければ `category: timeout` 返却。

### 昇格ロジック

オーナー判断: **1 回で昇格、N 連続要件なし**。

理由:
- 並列発火 = 「champion が 5 秒で返せなかった or 失敗」という負シグナル
- 並列で勝者が出た = 「勝者は valid を 5 秒未満 (or champion より速く) で返せた」という正シグナル
- → 統計的揺らぎは並列発火そのものが内包している、追加 hysteresis 不要
- 揺らぎが起きても自然収束 (champion = 5s 以内 valid が安定状態の attractor)

### 降格 / 除外ロジック

オーナー判断: **無し**。

理由:
- 失敗の原因は一時的 (5xx / ネットワーク) の可能性があり永久除外は危険
- 並列発火がレアイベントなら、無駄経路への投入も許容コスト
- 構造的失敗経路 (yodobashi の got) は champion = curl_cffi が確立すれば 99.9% 並列発火しないので、got への無駄投入は実質起きない

phase14 既存の「N 連続失敗で champion invalidate」は維持 (champion 単位の再選定トリガとして必要)。

### SSRF 防御の置き換え

旧設計: `[scraping.curl_cffi].domains` / `[scraping.proxy].domains` allowlist が SSRF 兼用防御だった。phase18 で allowlist を撤廃するため、各経路で独立した SSRF ガードが必要:

| 経路 | SSRF ガード |
|---|---|
| default / fallback_ua | 既存 (`got.ts` の ipaddr.js による unicast チェック) |
| proxy | Worker 側の `ALLOWED_DOMAINS` (これは維持、Worker 自体が public proxy 化しないため) |
| curl_cffi | **Python 側に新規追加**: `tools/curl-cffi-fetcher/fetch.py` で URL parse → 名前解決 → ipaddr 範囲チェック → private/loopback/link-local 拒否 |

curl_cffi 側 SSRF ガードの実装目安 (Python):

```python
import socket, ipaddress
from urllib.parse import urlparse

def assert_public_ip(url: str) -> None:
    host = urlparse(url).hostname
    if host is None:
        raise ValueError("invalid url")
    for af, _, _, _, sockaddr in socket.getaddrinfo(host, None):
        ip = ipaddress.ip_address(sockaddr[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved:
            raise PermissionError(f"private IP rejected: {ip}")
```

`SUMMALY_ALLOW_PRIVATE_IP=true` でテスト時のみバイパス可能にする (Node 側既存仕様と一致)。

### proxy allowlist (Worker 側) は維持

- Worker `wrangler.toml` の `ALLOWED_DOMAINS` は **オープンプロキシ化を防ぐ層** として残す (summaly 側からは撤廃するが Worker 自体は public endpoint なので必要)
- summaly 側からは「Worker が知らないドメインを投げて 403 返ってきたら proxy 経路 invalid 扱い」で hedge race の通常フローに乗る (= Worker が暗黙の allowlist 役)

### config 簡素化

phase18 完了後の `[scraping]` セクション (deploy example):

```toml
[scraping]
# 経路選定は hedged race で動的決定。allowlist 不要

[scraping.proxy]
enabled = true
url = "https://summaly-proxy.example.workers.dev/"
secret = "..."
# domains = [...] ← 撤廃

[scraping.curl_cffi]
enabled = true
binary = "uv"
script_dir = "/path/to/tools/curl-cffi-fetcher"
# domains = [...] ← 撤廃

[scraping.fallback]
enabled = true
hedged_threshold_ms = 5000   # ★ 新規: 並列発火しきい値
# categories = [...] ← 撤廃 (hedged race ですべての failure category が並列に乗る)
```

## ステップ

### Step 1: hedged race コアロジック実装

- `src/utils/hedged-fetch.ts` 新設: `hedgedRace(url, champion, challengers)` 関数
- `Promise.any` + `AbortController` 連携
- `isValidResult()` (= `!isThinSummary` ラッパ) 追加
- ユニットテスト: モック strategy で「champion 即勝ち」「champion 5s 遅延 + challenger 勝ち」「全 invalid」「abort 動作」の 4 ケース

### Step 2: 既存 cascade fetch (`getResponseWithCurlCffiFallback` 等) を hedged race ベースに置換

- `src/utils/proxy-fallback.ts` / `src/utils/curl-cffi-fetch.ts` の発火条件 (`shouldUseProxy(category)` / `shouldUseCurlCffi(category)`) を撤廃
- `src/general.ts` / `src/utils/got.ts` の `scpaping()` を `hedgedRace()` 呼び出しに統合
- phase14 の経路学習キャッシュ hook はそのまま流用 (champion lookup + 勝者 promotion)

### Step 3: SSRF ガード追加 (curl_cffi 側)

- `tools/curl-cffi-fetcher/fetch.py` に `assert_public_ip()` 追加
- 環境変数 `SUMMALY_ALLOW_PRIVATE_IP=true` でバイパス
- pytest で private/public IP の判定テスト追加

### Step 4: domains allowlist 撤廃

- `bin/config-loader.ts` の `[scraping.proxy].domains` / `[scraping.curl_cffi].domains` schema を **読み込み廃止**
  - 旧 config を持つユーザーが起動失敗しないよう、smol-toml の silent ignore を活用 (phase11.5 と同じパターン)
  - `test/config-loader.test.ts` に「`domains = [...]` を渡しても無視される」forward-compat テスト
- `src/utils/proxy-fallback.ts` / `src/utils/curl-cffi-fetch.ts` の domains チェックロジック削除
- `config.example.toml` + `docs/deploy-examples/summaly-config.example.toml` の **両方** から domains 行を削除 (CLAUDE.repo.md ステップ 4.5)
- `[scraping.fallback].categories` も同様に廃止 (hedged race ですべての failure が並列に乗るため categorize 不要)
- `[scraping.fallback].hedged_threshold_ms` を新規追加 (デフォルト 5000)

### Step 5: 「経路問題だけのプラグイン」候補の棚卸し

- `sqex` / `nintendo-store` / `yodobashi` の各プラグインを精査
  - **削除候補**: `test()` で host match + `summarize()` が `parseGeneral()` 呼ぶだけのもの (= 経路フラグの hint 役だけだったプラグイン)
  - **残す**: URL 正規化・DOM 直読み・公式 API 直叩き・skipRedirectResolution 等の「引き出し方の自在性」を実装するもの
- 削除した plugin の bootstrap entry は維持 (= 初期 champion ヒント役は引き続き有効)
- `config.example.toml` の `[plugins].allowed` から削除した plugin 名を外す
- `test/config-example-plugins.test.ts` で同期確認

### Step 6: pino ログ追加

- hedge 発火イベントに `hedge_fired: true`, `champion: 'curl_cffi'`, `winner: 'proxy'`, `losers: ['default', 'fallback_ua']`, `latency_ms: { default: 5012, fallback_ua: 5043, proxy: 1234, curl_cffi: 4567 }` 等を記録
- 学習機構のチューニング (将来 `hedged_threshold_ms` の調整 / 構造的失敗経路の検出 / playwright 追加判断) に必須

### Step 7: ドキュメント更新

- `docs/SETUP.md`: `[scraping.fallback]` セクション全面書き換え (hedged race 設計・新キー `hedged_threshold_ms` 追加)
- `docs/SETUP.md`: `[scraping.proxy].domains` / `[scraping.curl_cffi].domains` セクション削除 (DEPRECATED.md に移送)
- `DEPRECATED.md`: 上記 domains keys + `[scraping.fallback].categories` を「旧 / 新 / 廃止理由 / 移行手順」一貫構成で追加 (phase16.2 と同形式)
- `CLAUDE.repo.md` の「対応形式」表で削除した plugin の行を削除 / 残した plugin の経路列を更新
- `CHANGELOG.md` (unreleased): **BREAKING** で domains 廃止 + hedged race 導入を明記
- `docs/knowhow/hedged-fallback.md` (新規): 設計判断と運用知見を記録

### Step 8: 動作確認

実 URL バリエーション (`/url-preview-check` Phase 6 と同形式):

| サイト | 期待される champion | 期待される hedge 動作 |
|---|---|---|
| `https://www.google.com/` | default (即返却) | 並列発火しない |
| `https://www.amazon.co.jp/dp/B0XXXXXXXX` | default → 5s 経過時 proxy 並列 → proxy 勝利で昇格 | 初回のみ並列、2 回目以降 proxy 直行 |
| `https://www.yodobashi.com/product/...` | bootstrap で curl_cffi、即返却 | 並列発火しない |
| `https://www.monotaro.com/p/7281/1123/` | 初回 default → 5s 経過時 hedge → curl_cffi 勝利で昇格 | 初回のみ並列、2 回目以降 curl_cffi 直行 (★ phase18 が解決した新規サイト) |
| `https://store.jp.square-enix.com/...` | bootstrap で proxy、即返却 | 並列発火しない |

## 想定されるリスク・トレードオフ

### コスト

並列発火時に最大 4 経路同時アクセス (got + UA fallback + proxy + curl_cffi)。

| リソース | 影響 |
|---|---|
| 自分の Vultr instance CPU | curl_cffi spawn (Python プロセス) が並列発火時のみ +1 同時実行 — 個人運用 instance なら無視できる |
| CF Workers Free 枠 | proxy 経路への余分な request — 月 100k req まで無料、個人 Misskey の preview 量なら余裕 |
| upstream サイトへの負荷 | 同一 IP からの 2 経路 (got + UA fallback) + 別 IP 2 経路 (proxy + curl_cffi) — レアイベントなので bot 判定リスクは低い |

champion が安定状態に達すれば並列発火そのものが起きないため、**定常コストは現状とほぼ同じ**。

### 学習の収束時間

新規サイト初回アクセスは必ず「default で 5s 経過 → 並列発火 → 勝者昇格」のフルコースを踏む。**初回 5〜10s** の体感劣化あり。2 回目以降は champion 直行で改善。

bootstrap JSONL に主要サイトを事前登録することで初回コストを回避する戦略は phase14 から継続可能。

### 「経路問題だけのプラグイン」削除の判断

Step 5 で精査するが、慎重判断が必要:

- `sqex` プラグインの `skipRedirectResolution = true` フラグは hedge race と独立した最適化 (HEAD probe を切る) なので維持
- `yodobashi` プラグインも同フラグ維持理由から残す
- `nintendo-store` プラグインの `userAgent: 'facebookexternalhit/1.1'` 固定は **fallback_ua 経路と等価**なので削除候補

削除対象は最終的に 0〜1 個に留まる可能性が高い (= phase18 の主目的は「将来の新規サイトで plugin 起票が不要になる」効果)。

### SSRF ガード追加の Python 側コスト

`getaddrinfo` 呼び出しが各リクエストに 1 回追加。OS の DNS キャッシュが効くため実コストは ms 単位。SSRF 防御の代替手段が他にないため必須。

## 完了条件

- [x] `hedgedRace()` ユニットテスト pass (10 ケース、Step 1)
- [x] 既存 cascade fetch を hedged race に置換、回帰テスト整備 (`pnpm test` 619 件 pass、Step 2)
- [x] curl_cffi Python 側 SSRF ガード追加 (`assert_public_ip`、Step 3、スポット動作確認 OK)
- [x] config.example.toml + deploy-examples/summaly-config.example.toml 両方更新 (Step 4)
- [x] forward-compat テスト追加 (`hedgedThresholdMs` 4 ケース、Step 4)
- [x] CHANGELOG.md (unreleased) BREAKING 記載 (Step 7)
- [x] docs/knowhow/hedged-fallback.md 新設 + INDEX 反映 (Step 7)
- [ ] `domains` allowlist 物理撤廃 (将来 phase: 内部 schema 温存で workload 抑制)
- [ ] DEPRECATED.md 移送 (`fallbackRetryCategories` のみ deprecation 通知、本フェーズは CHANGELOG で十分)
- [ ] 動作確認 5 サイト (Step 8 表) で期待通りの hedge 動作 (本番デプロイ後)
- [ ] 本番デプロイ後に monotaro が plugin / config 編集なしで preview 取れる (運用者検証)

## レビュー指摘 (将来 phase に分離する課題)

- **M-2 (abort error カテゴリ分離)**: hedge race 勝者確定後の cancellation で発生する abort 由来の Error が `categorizeError` の `/aborted/i` regex で `timeout` カテゴリに誤分類される問題。`HedgeAbortedError` クラスは本 phase で用意したが、`categorizeError` で `errorName === 'HedgeAbortedError'` を special case として `'unknown'` (or 新規 `'hedge_aborted'` カテゴリ) に分類する変更は `SummalyErrorCategory` ユニオン拡張 + TOML 検証 + parse-failure-log.ts の波及があり phase 外に分離。実害は学習機構の精度低下のみで、機能的な誤動作はない。
- **M-3 (curl_cffi の TOCTOU)**: `getaddrinfo` → `requests.get(allow_redirects=True)` の間に DNS rebinding 攻撃のウィンドウがある構造的限界。redirect 後の最終 URL 再検証は実装済みだが per-hop 検証は curl_cffi の API 制約で困難。Python 側に NOTE コメント追加で許容リスクとして文書化済み (個人運用 Misskey 相当の脅威モデルでは現実的攻撃シナリオに入りにくい)。
- **L-1 (gate_failed の causes 不親切)**: 全経路 gate_failed のときの `HedgedRaceAllFailedError.causes` が「gate failed (no strategy enabled)」という汎用メッセージ。pino ログ伝搬が将来 phase なので現状ブロッキングではない。
- **L-3 (proxy.secret === '' チェック dead code 可能性)**: phase16.4 起動時 healthcheck と二重だが defense-in-depth として温存。

## 方針からの変更

- **Step 4 のスコープ縮小**: `domains` allowlist の物理撤廃 (proxy-fallback.ts / curl-cffi-fetch.ts の interface から `domains` field 削除) は test 影響範囲が広いため将来 phase に分離。phase18 では「`fetchByStrategy` 内で `domains` チェックを skip」+ 「`hedgedThresholdMs` 新規 TOML キー追加」+ 「forward-compat テスト」までを完了。
- **Step 5 のスコープ縮小**: 「経路問題だけのプラグイン棚卸し」は精査して結果を Plan に記録するに留め、実際の削除は将来 phase 化。`nintendo-store` プラグインは fallback_ua 経路 (デフォルト UA = `facebookexternalhit/1.1`) で代替可能だが、削除すると CLAUDE.repo.md / README / プラグイン allowlist に広範な影響が出るため温存。bootstrap entry を追加するのが推奨アクション。`sqex` / `yodobashi` は `skipRedirectResolution = true` 等の独立最適化を持つため維持。
- **Step 6 のスコープ縮小**: pino ログへの hedge イベント追加は `recState.hedgeFired / hedgeOutcomes / hedgeLatencyMs` への格納まで実装 (Step 2 で同時実装済み)。`summaly()` レイヤから Fastify pino logger への伝搬統合は将来 phase。
- **`fallbackRetryCategories` の扱い**: 機能上は意味を持たなくなったが (hedge race ですべての retryable error で並列発火)、TOML キーと SummalyOptions field は forward-compat 維持。CHANGELOG で deprecation 通知済み。

## 関連 Plan / knowhow

- [phase14-domain-strategy-cache.md](phase14-domain-strategy-cache.md) — 経路学習キャッシュの根幹 (champion 永続化構造はそのまま流用)
- [phase12.1-cf-workers-proxy-fallback.md](phase12.1-cf-workers-proxy-fallback.md) — proxy 経路の実装基盤
- [phase12.5-curl-cffi-fetcher.md](phase12.5-curl-cffi-fetcher.md) — curl_cffi 経路の実装基盤
- [phase11.9-bot-block-ua-retry.md](phase11.9-bot-block-ua-retry.md) — fallback_ua 経路の実装基盤
- [phase15.1-playwright-fallback.md](phase15.1-playwright-fallback.md) — 将来追加候補の経路 (`ALL_STRATEGIES` に `playwright` 追加で hedge 候補入り)
- [phase16.3-config-cleanup.md](phase16.3-config-cleanup.md) — config 整理の前例 (silent ignore + forward-compat テストパターン)
- [docs/knowhow/domain-strategy-cache.md](../knowhow/domain-strategy-cache.md) — phase14 の運用知見
- [docs/knowhow/cf-workers-outbound-proxy.md](../knowhow/cf-workers-outbound-proxy.md) — proxy 経路の knowhow
- [docs/knowhow/curl-cffi-tls-impersonation.md](../knowhow/curl-cffi-tls-impersonation.md) — curl_cffi 経路の knowhow

## 起票の経緯

`/url-preview-check https://www.monotaro.com/p/7281/1123/` の調査セッション中、fail mode H (TLS impersonation で救援可、yodobashi と同型) の典型例が発見された。当初 monotaro 個別救援 (`phase15.4-curl-cffi-fallback-categorized.md` 案) として起票しかけたが、オーナーから「ドメインリスト追加なしで curl_cffi をフォールバック候補に入れる」「第一候補が失敗 or 5 秒遅延で残り全部並列、最速 valid 採用」「第一候補だけ特権、第二候補からはプール扱い」「永久除外なし」と段階的に設計が拡張され、**経路問題だけのサイトは plugin / config 編集なしで自動救援される** 設計に到達した。
