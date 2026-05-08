# phase16.1 — ドキュメント網羅性更新 (経路優先システムを目玉特徴に位置づけ)

## 背景

phase11.9 / 12.1 / 12.5 / 12.6 / 14 を経て、**取得経路を 4 種類 (Summaly UA / SNS Preview Bot UA / Proxy / curl_cffi) に整理し、host + path prefix 単位で経路学習キャッシュ + bootstrap JSONL から第一選択肢を選ぶ** 構造が完成した。phase14 Step 4 で `forceCurlCffiFallback` / `forceProxyFallback` プラグイン側フラグも廃止し、プラグインは「extraction の自在性」専用、経路選択は経路学習キャッシュ専用、と責務分離されている。

これは riin-summaly の独自軸として強い差別化要素 (本家・mei23 のいずれにも該当機能なし) だが、現状 README.md は phase12.1 の dev サーバ proxy 言及だけで、**経路優先システムとして俯瞰した位置づけが無い**。SETUP.md / Library.md の奥でしか語られておらず、新規利用者が riin-summaly を採用する判断材料として届かない。

加えて phase15.2 で追加した `kakuyomu` プラグインが README プラグイン表に未反映 ([test/config-example-plugins.test.ts](../../test/config-example-plugins.test.ts) は `config.example.toml` と `docs/deploy-examples/...` の 2 ファイルしか守っていないため、README は対象外で人力チェック頼みになっている)。Feedback.md の phase11.4 / 6.1 系で繰り返し起きている example 同期漏れと同種の構造的見落とし。

## 目的

1. **経路優先システムを README の目玉特徴として位置づける** — 4 経路 + 経路学習キャッシュ + bootstrap を俯瞰セクションに整理
2. **プラグイン表に `kakuyomu` 行追加** + 各プラグインがどの経路を使うかを「経路」列で明示
3. **docs/Library.md / docs/SETUP.md** の phase14 進捗表現の古い箇所 (「予定」表現が残っている部分) を「同梱済 / 廃止済」に修正
4. **README プラグイン表の構造的チェックを test に追加** (再発防止、`config-example-plugins.test.ts` パターンの README 拡張)

## 経路カテゴリの整理 (4 経路 + 抽出戦略)

phase14 経路学習キャッシュのキー (`default` / `fallback_ua` / `proxy` / `curl_cffi`) と一致する fetch 戦略軸:

| 経路 | 内部キー | 概要 | 採用例 |
|:--|:--|:--|:--|
| **Summaly UA** | `default` | デフォルト UA `SummalyBot/<version>` で got 経由スクレイプ。最初の選択肢 | 大多数のサイト |
| **SNS Preview Bot UA** | `fallback_ua` | `facebookexternalhit/1.1` / `Twitterbot/1.0` 等の SNS bot UA に偽装。WAF allowlist に入ったり PV カウント除外を狙ったりする | nintendo-store (Akamai 突破), kakuyomu (PV 除外), phase11.9 汎用 fallback |
| **Proxy 経由** | `proxy` | Cloudflare Workers Free を outbound proxy として経由。Vultr Tokyo IP 等の datacenter IP block を CF の AS13335 経由で救援 | amazon (`amazon.co.jp` の 500 救援), sqex (DC IP block) |
| **curl_cffi** | `curl_cffi` | `tools/curl-cffi-fetcher/` の Python CLI を spawn し、Chrome / Firefox / Safari の TLS フィンガープリント (JA3) を完全再現 | yodobashi (TLS layer bot block / HTTP/2 INTERNAL_ERROR) |

これらと直交する **抽出 (extraction) 戦略** は別軸:

- 公式 JSON API / oEmbed 直叩き: HTML スクレイプ自体しない (wikipedia, npmjs, syosetu, twitter cdn.syndication, youtube oEmbed, spotify oEmbed)
- DOM 直接抽出: amazon (`#title` / `#productDescription` / `#landingImage`)
- HTML 内 state JSON parse: kakuyomu (`__NEXT_DATA__` の Apollo state)
- 汎用 OG / TwitterCard / oEmbed: 大多数のサイト

抽出戦略は経路と独立して選べる (例: kakuyomu は SNS Preview Bot UA で取得した HTML から `__NEXT_DATA__` をパース)。

## Step 1: README.md 改修

### 1.1 「経路優先システム」セクション新設

「対応サイト（プラグイン一覧）」セクションの直前に追加:

- 4 経路の概要表 (上記)
- 経路学習キャッシュ + bootstrap JSONL の 1 段落 (host + path prefix 2 段で第一選択肢を学習・JSONL 永続化、`data/domain-strategy-bootstrap.jsonl` 同梱で初回コスト回避、N 連続失敗で entry 破棄)
- phase14 のリファクタリング強調 (プラグイン側 `forceX` フラグを廃止し、経路選択を経路学習キャッシュに集約)

### 1.2 「riin-summaly で拡張された運用機能」表に追加

| 機能 | 概要 | 関連 |
|:--|:--|:--|
| **経路学習キャッシュ + bootstrap** | host + path prefix 単位で 4 経路 (default / fallback_ua / proxy / curl_cffi) を学習・JSONL 永続化。bootstrap 同梱で初回コスト回避 | `[scraping.strategy_cache]` |
| **CF Workers proxy fallback** | Vultr Tokyo IP block (amazon.co.jp 500 等) を Cloudflare Workers の AS13335 経由で救援。HMAC-SHA256 認証 + 8 層防御 | `[scraping.proxy]` |
| **curl_cffi TLS 偽装** | TLS / HTTP/2 layer の bot block (yodobashi 級 INTERNAL_ERROR) を Chrome JA3 完全再現で突破 | `[scraping.curl_cffi]` |

### 1.3 vs 本家 / mei23 比較表に 3 行追加 (上記 3 機能、本家・mei23 ともに —)

### 1.4 プラグイン表

- `kakuyomu` 行を追加
- **「経路」列を追加**: 各プラグインの fetch 経路 (4 経路 + 公式 API 直叩きの計 5 種類) を簡潔記号で
  - 例: `Summaly UA`, `SNS Bot UA`, `Proxy`, `curl_cffi`, `公式 API`

### 1.5 dev サーバセクション

- 「proxy fallback の手元再現 (phase12.1)」を **「経路優先システムの手元再現」** に拡張 (proxy + curl_cffi の両 env 対応であることを明示)

## Step 2: docs/Library.md

- L94 `domainStrategyCache` 文言: 「Step 3 で bootstrap.jsonl 同梱**予定**」「Step 4 で `forceX` フラグ**廃止予定**」 → 「**Step 3 で同梱済**」「**Step 4 で廃止済**」

## Step 3: docs/SETUP.md

冒頭 (現在の `[scraping.proxy]` セクションの直前) に「**経路優先システム俯瞰図**」を追加:

- 4 経路の責務分担と fallback chain (default → fallback_ua → proxy → curl_cffi の優先順序、各経路の発火条件)
- 経路学習キャッシュが「初回 cascade」と「2 回目以降 fast path」の双方をどう繋げているか
- bootstrap JSONL の運用 (リポ管理 vs runtime 環境固有 gitignored)

## Step 4: test/readme-plugins.test.ts (構造的ガード)

- `src/plugins/*.ts` の `export const name` を全件抽出
- README.md 内のテキスト出現を確認 ([test/config-example-plugins.test.ts](../../test/config-example-plugins.test.ts) と同パターン)
- 新規プラグイン追加時の README 反映漏れを `pnpm test` で fail させる

## Step 5: 品質ゲート

- `pnpm build` / `pnpm eslint` / `pnpm typecheck` / `pnpm test`
- ドキュメント変更が中心なのでレビュー agent は文言整合性チェックを依頼
- knowhow 更新候補:
  - 「経路カテゴリの言語化が機能横断ドキュメントの軸になる」(本 phase の knowhow)
  - 「ドキュメント表のチェックは src の export と突き合わせる test で構造的に守る」(README プラグイン表チェックを `config-example-plugins.test.ts` から横展開した経験)

## サイズ

S〜M (ドキュメント中心、test 1 ファイル追加)

## 実装完了状況 (2026-05-08)

- ✅ Step 1.1〜1.5: README.md 改修完了 (経路優先システムセクション + 運用機能表 + 比較表 + プラグイン表 + dev サーバセクション)
- ✅ Step 2: docs/Library.md L94-95 文言更新 (「予定」→「済」、`embedBaseUrl` 対応プラグインに `kakuyomu` 追加)
- ✅ Step 3: docs/SETUP.md 目次 + 「経路優先システム俯瞰」セクション追加
- ✅ Step 4: test/readme-plugins.test.ts 追加 (584 件全パス確認)
- ✅ Step 5: 品質ゲート (build / lint / typecheck / test / ADDF tests 全パス)
- ✅ レビュー指摘 3 件反映:
  1. README L135 の SETUP.md アンカー `#経路学習キャッシュ-phase14` → `#経路学習キャッシュ-phase14-step-1` に修正
  2. dev サーバの「自動発火」表現を「設定が必要 → 設定が無い経路は cache fast path で gate を通れず通常 scpaping にフォールスルー」に正確化
  3. `twitter` 経路列を「公式 API」→「内部 CDN (非公式)」に修正 (実装コメントの「公式 API ではない」と整合)
- ✅ 派生修正: docs/knowhow/domain-strategy-cache.md の同種「予定」表現を「済」に整理 (Suggestion 反映)
- ✅ knowhow 追加: docs/knowhow/plugin-infrastructure-patterns.md に「ドキュメント表チェックを test で構造的に守る」セクション追加 (phase11.4 / phase15.2 / phase16.1 の同種失敗パターンを汎用化)
