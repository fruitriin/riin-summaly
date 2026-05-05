# Outbound IP レピュテーションが原因のスクレイピング失敗

> 2026-05-05 記録。「ローカルで再現しないが本番で再現する」型のスクレイピング失敗の典型パターン。
> phase11.9 (UA フォールバック) では救えない、別レイヤの対処が要る案件として知見化。

## 課題

`summaly` Fastify モードを Vultr Tokyo にデプロイした構成で、amazon.co.jp が一貫して **500 Internal Server Error** を返す。
ローカル開発機（住宅 ISP）から同じ URL・同じ UA で叩くと **200 OK** で取れる。

```
本番 (Vultr Tokyo, 45.32.254.0/23): SummalyBot/5.3.0 → 500
ローカル (ARTERIA / JP 住宅 ISP):   SummalyBot/5.3.0 → 200
```

エラーカテゴリは `origin_error`（[src/utils/parse-failure-log.ts](../../src/utils/parse-failure-log.ts) の `categorizeError` で 5xx に分類）。本番ログには `StatusError: 500 Internal Server Error` が出るだけで原因の手がかりが少ない。

## 真因: 「UA × IP の複合判定」を行うサイトが存在する

Amazon は **「IP レピュテーション × UA」の複合判定** で bot を弾いている強い実証データがある:

| 経路 | UA | 結果 |
|---|---|---|
| ローカル (ARTERIA / JP 住宅 ISP) | `SummalyBot/5.3.0` | ✅ 200 |
| ローカル (ARTERIA / JP 住宅 ISP) | `facebookexternalhit/1.1` | ❌ **500** |
| ローカル (ARTERIA / JP 住宅 ISP) | ブラウザ Mozilla | ✅ 200 |
| 本番 (Vultr Tokyo)               | `SummalyBot/5.3.0` | ❌ 500 |

ポイント:

- **ローカル住宅 IP からでも `facebookexternalhit` UA を名乗ると 500** が返る → Amazon は「住宅 IP でも『あえて社外 IP から fb bot を名乗る』のは怪しい」と判定している
- 逆に **住宅 IP からの `SummalyBot/...` は素通し** → IP がクリーンなら多少怪しい UA でも通す
- 本番 (Vultr datacenter IP) では UA に関係なく 500 → **IP レピュテーション側が dominant な要因**

つまり、**「UA だけ変えても datacenter IP からは通らない」** タイプの遮断。phase11.9 で導入した UA フォールバックは、このカテゴリには無力。

## 検証手順（再現性のあるレシピ）

「ローカルで再現しないが本番で再現する」を踏んだとき、以下の順で切り分ける:

### Step 1. 本番 origin の outbound IP を確認

`summaly.example.com` が Cloudflare proxy 配下だと DNS では origin IP がわからないので、本番サーバ側で確認する:

```bash
ssh production "curl -sS https://api.ipify.org && echo"
# 例: 45.32.255.225
```

### Step 2. その IP の AS / ISP 種別を whois で確認

```bash
whois 45.32.255.225
# OrgName: The Constant Company, LLC（= Vultr の親会社）
# NetType: Direct Allocation
# Reassigned to: Vultr Holdings, LLC（JP, Tokyo 大田区平和島）
```

主要 datacenter ISP（**Vultr / DigitalOcean / Linode / Hetzner / OVH / Contabo** 等）は Amazon を含む多くの大手サイトで強くフィルタされる傾向がある。AWS 内部 IP は **Amazon に対しては比較的緩い**（Amazon が自社）が、他のサイト（X / Akamai 系）では別途フィルタされる。

### Step 3. 本番から直接 curl で再現を確認

```bash
ssh production "curl -sS -A 'SummalyBot/5.3.0' -o /dev/null -w '%{http_code}\n' 'https://amazon.co.jp/dp/<ASIN>'"
# 500 が返れば確実に IP レピュテーション層
# 200 が返れば summaly コード側に差がある可能性（Node バージョン差・TLS fingerprint 差等）
```

### Step 4. UA × IP マトリクスで 4 象限テスト

ローカル × 本番 / UA = SummalyBot × ブラウザ で 4 通り叩く。本記事冒頭のテーブルがそれ。
**「住宅 IP × ブラウザ UA」だけが必ず通る** なら IP レピュテーション層の遮断と確定する。

### Step 5. Node バージョン / TLS fingerprint 差を排除

```bash
ssh production "node --version"
node --version  # ローカル
```

メジャーバージョン差（v18 ↔ v20）があると TLS ClientHello の構成が変わり、JA3/JA4 fingerprint が変動する。Amazon は JA3 ベースの bot 検知も入れていることが知られている。同じ Node バージョンで揃えても再現するなら fingerprint 説は消える。

## 仮説の優先順位（経験則）

「ローカルで再現しないが本番で再現する」型のスクレイピング失敗を踏んだとき:

| 仮説 | 確度（経験則） | 切り分け |
|---|---|---|
| **A. IP レピュテーション差** | 70% | Step 1〜3、本番 outbound IP の whois を見るだけで決着することが多い |
| **B. Accept-Language の違い** | 10% | 本番ログの `lang=en-US` 等とローカル curl のヘッダ差をチェック |
| **C. TLS fingerprint (JA3/JA4) 差** | 15% | Node バージョンを揃えて再検証 |
| **D. 累積レートリミット** | 3% | 時間帯を変えて再検証 |
| **E. Cookie / セッション差** | 2% | got は cookieless なので通常関与しない |

A が圧倒的に多い。先に A を消してから B〜E に進む。

## summaly 側の対処選択肢（重い順）

### 案 1. **Outbound proxy 経由**
- 住宅 ISP / モバイル回線 / **residential proxy SaaS**（Bright Data / Smartproxy 等）経由で出ていく
- **コスト**: 商用 residential proxy は月 $100〜
- **複雑性**: SSRF ガード再設計が必要（[src/utils/got.ts](../../src/utils/got.ts) の `setAgent()` でカスタム agent を入れるとプライベート IP ガードが無効化されるため、proxy 越しのリクエストにも別途プライベート IP 検査が要る）
- **倫理**: residential proxy はサイト規約違反になりうる
- 自宅サーバがあるなら **自前で薄い HTTP proxy** を立てて Vultr→自宅→Amazon の経路を作る軽量版もあり

### 案 2. **公式 API への迂回（サイトごとに）**
- Amazon: Product Advertising API (PA-API)。ただし Amazon アソシエイト登録 + 過去 180 日の売上維持が要件で、一般運用者には高ハードル
- npmjs.com は phase11.4 で同パターン（Cloudflare 配下 HTML を諦め registry API 直叩き）を採用済み。サイト固有プラグインで「公式 API があるならそっちを使う」の実例
- **長所**: スクレイピングよりはるかに安定
- **短所**: サイトごとに調査・契約が必要

### 案 3. **OGP-as-a-service への委譲**
- Microlink.io / OpenGraph.io 等の第三者 OGP API に丸投げ
- **コスト**: 月数千円〜
- summaly の責務外に近いが、運用者の現実解として価値はある

### 案 4. **諦める**
- summaly は「scraping できる範囲」とし、Amazon 等の高難度サイトは Misskey 側で別 UI（リンクのみ表示）にフォールバックさせる
- 一番楽。UX は若干落ちるが、運用負担はゼロ

### 案 5. **summaly を AWS / Cloudflare Workers に移す**
- AWS 内部からの amazon.co.jp は緩い傾向（Amazon が自社）
- Cloudflare Workers の egress IP は別の IP 帯で再評価が必要
- インフラ移行コストが大きい

### 推奨判断（個人運用 / 中小規模インスタンス）

- **Amazon 1 サイトだけのために proxy を入れる ROI は低い**。案 4 (諦める) が現実解
- 失敗ログを観測しつつ「proxy 入れる価値ある件数か？」を継続評価する
- 大規模インスタンスなら案 1 の自前 proxy か案 3 の OGP-as-a-service に倒す

## phase11.9（UA リトライ）との関係

phase11.9 は **UA レイヤだけの bot block** を救う設計（`playing-games.com` / `shorturl.at` / `minenest.com` 等）。
本記事の **IP レピュテーション層の遮断** は phase11.9 の射程外で、`fallbackUserAgent` をどう設定しても通らない。

[bot-block-ua-retry.md](bot-block-ua-retry.md) には「IP block は射程外」と明記されているが、その「IP block」の典型例として **Amazon vs Vultr** をここに押さえておく。両者を行き来して理解する。

## 教訓

1. **「ローカルで再現しないが本番で再現する」型は IP レピュテーション差を最初に疑う**。Step 1〜3 で whois を見るだけで決着がつくことが多い
2. **大手サイトの bot 検知は UA 単独ではない**。UA × IP × Accept-Language × TLS fingerprint の複合判定が普通
3. **データセンタ IP（Vultr / DO / Linode / Hetzner / OVH / Contabo 等）からのスクレイピングは「通らない場合がある」前提で設計する**。エラーが致命的に困る用途なら案 1〜3 の対処を最初から組み込む
4. **AWS 内部 IP は Amazon 自身に対しては緩い**（自社）が、他社サイトに対しては逆に強くフィルタされることもある（盗難・攻撃の出元として）。「AWS なら万能」ではない
5. **失敗ログだけ見ても IP レピュテーションは見えない**。ローカル再現テストと本番 outbound IP の whois を必ずセットで持つこと
6. **summaly のような「他人のサイトを叩く」サービスは、サイト側に拒否される権利を尊重する**。proxy で強引に通すのは技術的には可能だが、運用倫理として線引きが要る
