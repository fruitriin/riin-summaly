# phase15.3 — DMM (FANZA) プラグイン

## 背景

オーナーから新規プレビュー対象の URL `https://video.dmm.co.jp/av/content/?id=ailb00009` (FANZA AV) が提示され、「年齢認証画面が先に挟まる」との指摘 (2026-05-10)。

skill `/url-preview-check` Phase 1〜3 で切り分けた結果、**fail mode G (SNS bot allowlist 経由で救援可)** パターンと確定。

| UA | 挙動 |
|---|---|
| SummalyBot / `Mozilla/5.0` ブラウザ UA | 302 → `https://www.dmm.co.jp/age_check/=/?rurl=...` 認証ゲート HTML (34 KB、空 OGP) |
| **`facebookexternalhit/1.1` / `Twitterbot/1.0`** | **ゲート素通り、実コンテンツ HTML (375 KB、OGP 完備)** |

`nintendo-store` プラグイン (phase12.3) と完全に同じ構造で対応可能。Phase 2 の curl 比較で取得した OGP は title / description / image / site_name / type すべて健全に揃っており、`parseGeneral()` でそのまま処理できる。

### 別ドメイン調査結果

- `fanza.jp` / `www.fanza.co.jp` / `video.dmm.com` は **DNS 解決失敗** — DMM/FANZA ブランドは `dmm.co.jp` 配下のみで展開されている
- `www.dmm.co.jp/digital/...` も `age_check` ゲート → fb_bot UA で素通り → 内部リダイレクトで `video.dmm.co.jp/av/...` 等に展開 → 完璧な OGP 取得

つまり対応すべきは **`dmm.co.jp` 全サブドメイン (age_check ゲート自身を除く)** のみで完結。

### サブドメインと sitename

| サブドメイン | 例 | site_name |
|---|---|---|
| `video.dmm.co.jp` | `/av/content/?id=...` (FANZA AV) | FANZA |
| `book.dmm.co.jp` | `/product/.../...` (電子書籍) | DMM / FANZA (一般 / アダルトで分岐) |
| `dlsoft.dmm.co.jp` | `/detail/...` (PC ゲーム DL) | DMM / FANZA |
| `games.dmm.co.jp` | `/detail/...` (ブラウザゲーム) | DMM GAMES / FANZA |
| `www.dmm.co.jp` + `/mono/`, `/digital/`, `/dvd/` 等 | 通販・物販・DVD | DMM / FANZA |

site_name は OGP の `og:site_name` がサイト側で適切に設定されているため、プラグイン側で固定せず **OGP 任せで自動分岐** させる。

## ゴール

DMM/FANZA の全サブドメインで preview を生成できるようにする。

- `dmm.co.jp` の全サブドメイン (`age_check` パスを除く) にマッチするプラグイン `dmm` を新設
- `facebookexternalhit/1.1` UA 固定で `scpaping()` → `parseGeneral()` で OGP 抽出
- `sensitive: true` 固定 (DMM 全体が age_check 経由なので保守的に NSFW 扱い)
- NSFW 慣例に従い `docs/deploy-examples/summaly-config.example.toml` の `[plugins].allowed` ではコメントアウト (オプトイン形式)

## 設計詳細

### マッチ条件

```typescript
export function test(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const isDmmHost = host === 'dmm.co.jp' || host.endsWith('.dmm.co.jp');
  if (!isDmmHost) return false;
  // age_check ゲート自身は弾く (= summaly が gate URL を受け取った時に無限ループ回避)
  if (url.pathname.startsWith('/age_check')) return false;
  return true;
}
```

### summarize 実装 (nintendo-store と同型)

```typescript
const FB_BOT_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

export async function summarize(url: URL, opts?: GeneralScrapingOptions): Promise<Summary | null> {
  const res = await scpaping(url.href, {
    ...opts,
    userAgent: FB_BOT_UA,
    fallbackUserAgent: undefined,
    fallbackRetryCategories: undefined,
  });
  const summary = await parseGeneral(url, res);
  if (!summary) return null;
  return { ...summary, sensitive: true };
}
```

### `skipRedirectResolution = true` の必要性

`src/index.ts` の `summaly()` 入口で `followRedirects: true` (デフォルト) のとき、`resolveRedirect` が **HEAD probe を `SummalyBot` UA で送る**。DMM は `Vary: User-Agent` で UA 別に挙動を分けるため、HEAD probe 時点で `age_check` ゲート URL に書き換わってしまう (実測: `final=https://www.dmm.co.jp/age_check/=/?rurl=...`)。

その状態で `summarize(resolved_url)` が呼ばれても、`test(age_check_url)` は (上記の `age_check` 除外条件により) false を返すため、`general()` フォールバックで空 OGP の preview ができてしまう。

これを防ぐため、プラグイン側で **`export const skipRedirectResolution = true`** を宣言する (`yodobashi` プラグインと同じパターン、phase14 cache とは独立した個別最適化)。

### sensitive フラグ

DMM/FANZA は全サブドメインが `age_check` ゲート経由になっており、一般作品も含めて R-18 適合確認を運営側が要求している。Misskey 側の preview 表示でも保守的に NSFW 扱いするのが安全と判断し、**プラグイン側で `sensitive: true` を強制セット**する。

将来的にサブドメイン別 (`games.dmm.co.jp` / `dmm.com/dmm-tv/` 等の完全一般カテゴリ) で分岐したくなった場合は別 phase で再検討。

## 実装ステップ

### Step 1: プラグイン本体

- [x] `src/plugins/dmm.ts` を新設 (上記設計通り)
- [x] `src/plugins/index.ts` の `plugins` 配列に登録 (末尾に追加)

### Step 2: テスト

- [x] テスト追加 (**方針からの変更**: 既存パターン (`nintendo-store` / `sqex` / `yodobashi`) はすべて `test/index.test.ts` に集約されているため、新規ファイル作成ではなく同ファイルに統合)
  - [x] `test()` のマッチ判定 (各サブドメイン true / `age_check` パス false / 詐称ドメイン false)
  - [x] `skipRedirectResolution = true` 宣言の確認
  - [x] `summarize()` の fastify mock テスト (UA が fb_bot で送られる + sensitive: true セット + OGP 抽出)
- [x] 既存テスト (`pnpm test`) 全件パス (662 件)

### Step 3: 設定 example 同期 (phase11.4 / 6.1 派生バグの教訓)

- [x] `config.example.toml` の `[plugins].allowed` に `# "dmm",` を追加 (**方針からの変更**: 当初プランではアクティブ形式と書いたが、既存 NSFW プラグイン群 `dlsite` / `iwara` / `komiflo` / `nijie` がルート config でもコメントアウトで並んでいるため、両 example でコメントアウトに統一する形に修正)
- [x] `docs/deploy-examples/summaly-config.example.toml` の `[plugins].allowed` に `# "dmm",` を追加 (NSFW 慣例でコメントアウト)
- [x] `test/config-example-plugins.test.ts` で自動検証されることを確認 (コメントアウト形式 `# "<name>",` も「運用者が判断で活性化できる」のでパス扱いされるロジック)

### Step 4: ドキュメント

- [x] `CLAUDE.repo.md` の「対応形式（組み込みプラグイン）」表に dmm 行追加
- [x] `docs/Plugins.md` に `dmm (FANZA)` セクションを追加 (目次にも反映)
- [x] `README.md` のプラグイン表に `dmm` 行を追加 (経路列 = SNS Bot UA、※印で運用者向けコメントアウトデフォルトを明示)
- [x] `dev/sample-urls.ts` の NSFW セクション (旧名 `dlsite / iwara / komiflo / nijie`) に FANZA video サンプルを追加
- [x] `CHANGELOG.md` unreleased セクション冒頭に `feat (plugin: dmm)` を記録

### Step 5: 本番動作確認 (デプロイ後)

skill `/url-preview-check` Phase 6 の **4〜5 URL バリエーション** で叩く:

| バリエーション | URL 例 |
|---|---|
| 元提示 URL (FANZA AV) | `https://video.dmm.co.jp/av/content/?id=ailb00009` |
| `www.dmm.co.jp/digital/` 経由 (内部リダイレクトあり) | `https://www.dmm.co.jp/digital/videoa/-/list/` |
| サブドメインバリエーション (book / dlsoft / games / mono) | 実在 URL を本番動作確認時にオーナーから取得 |
| query / fragment 付き | `?...&af_id=xxx` 等 (アフィリエイト ID 付き) |

期待: 全 URL で title / description / thumbnail / sitename が返り、`sensitive: true` がセットされること。

## リスクと判断

- **オープンプロキシ化リスク**: 無し。`dmm.co.jp` 配下に限定したホスト判定 + 通常の `scpaping()` 経路 (private IP ガードあり) なので、SSRF / proxy 化リスクは導入されない
- **サイトポリシー上のリスク**: DMM が `facebookexternalhit/1.1` UA を **意図的に allowlist** している = OGP を share させたい意思があるため、UA 偽装ではなく「サイトの share 用導線に乗る」使い方として許容範囲 (nintendo-store と同じ倫理判断)
- **NSFW 設定の運用**: deploy example でコメントアウトデフォルトのため、運用者が明示的にオプトインしなければ DMM プラグインは起動しない。riin-summaly 本番では `[plugins].allowed` に `"dmm"` を追加してデプロイ
- **将来 DMM 側が allowlist を狭めた場合**: fb_bot UA でも 302 → age_check になったら、curl_cffi or proxy fallback 等の経路に切り替える必要が出る可能性あり (要監視)

## 関連 knowhow / 関連プラグイン

- [src/plugins/nintendo-store.ts](../../src/plugins/nintendo-store.ts) — 完全に同じ構造の先例 (Akamai Bot Manager の SNS bot allowlist パターン、phase12.3)
- [src/plugins/yodobashi.ts](../../src/plugins/yodobashi.ts) — `skipRedirectResolution = true` の先例
- [docs/knowhow/plugin-infrastructure-patterns.md](../knowhow/plugin-infrastructure-patterns.md) — プラグイン基盤
- skill `/url-preview-check` の **fail mode G** 項

## 将来検討 (本 phase スコープ外)

- **`unwrapAgeAuthUrl` 相当の追加**: ユーザーが age_check URL (`https://www.dmm.co.jp/age_check/=/?rurl=<encoded>`) を直接 summaly に渡した場合に、`?rurl=` パラメータから元 URL を取り出して再度 `summaly()` に流す対策 (syosetu の `unwrapAgeAuthUrl` パターン)。現状は `test()` で `/age_check` を弾く → `general()` フォールバックで空 OGP の preview ができる失敗パターンになるが、ユースケースとして稀のため別 phase で対応判断。`docs/knowhow/age-gate-bypass-pattern.md` の対策 2 に該当 (レビュー S-4)

## サイズ

S (実装規模 ~50 行 + テスト 3 件 + ドキュメント、nintendo-store コピペベース)
