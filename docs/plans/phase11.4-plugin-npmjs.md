# Phase 11.4 — npmjs.com プラグイン（Registry API 経由）

> 状態: **完了 (2026-05-05)**
> 種別: 機能拡張 / プラグイン追加
> サイズ: **S**
> 依存: [phase2.1](phase2.1-plugin-infrastructure.md)（`getJson`、`name` フィールド規約）
> 並列可: [phase11.1](phase11.1-deps-update.md)、[phase11.2](phase11.2-error-category.md)

## 目的・背景

`https://www.npmjs.com/package/<pkg>` を summaly で取得すると **403 Forbidden** が返る。原因は npm が Cloudflare Bot Management の "managed challenge"（`cf-mitigated: challenge`）で蓋をしていることで、SummalyBot UA・ブラウザ模倣 UA・Discordbot/Twitterbot/Slackbot/facebookexternalhit 等の正規 bot UA でもローカルからは全部 403 になる（Cloudflare 側で IP / rDNS まで verified bot を検証するため）。

X (Twitter) や Discord で npm パッケージリンクの OG カードが表示されているのは、各社の verified bot が IP allowlist に登録されているためであって、HTTP レイヤで突破できる類の問題ではない。

ただし **npm Registry API (`https://registry.npmjs.org/<pkg>`)** は Cloudflare 保護の対象外で、`SummalyBot/x.y.z` UA でも素通しで 200 / `application/json` を返してくれる。description / homepage / repository 等のパッケージメタも揃っている。

そこで **`/package/...` URL は HTML をスクレイプせず Registry API JSON を直接叩いて Summary を組み立てる** プラグインを足す。

### curl 検証済み（2026-05-05）

| 経路 | 結果 |
|---|---|
| `curl -A SummalyBot/5.2.1 https://www.npmjs.com/package/mfm-renderer` | ❌ 403 + Cloudflare challenge HTML |
| `curl -A SummalyBot/5.2.1 https://registry.npmjs.org/mfm-renderer` | ✅ 200 / `application/json` / 7.5KB |
| `curl -A SummalyBot/5.2.1 https://registry.npmjs.org/@misskey-dev%2Fsummaly` | ✅ 200 / 37KB（scoped は `/` を `%2F` に） |
| `curl -A SummalyBot/5.2.1 https://static-production.npmjs.com/58a19602036db1daee0d7863c94673a4.png` | ✅ 200 / 120×120 PNG |

## 設計方針

### マッチ範囲（広めに取る）

- ホスト: `www.npmjs.com` または `npmjs.com`
- パス: `/package/<name>` 以下を全部マッチ（`/v/<ver>` `/tutorial` `/security` 等のサブパスも含む）
- バージョン指定があっても **常に `dist-tags.latest` を返す**（version 別表示は upstream の OG にも無いので簡素化優先）
- scope 付きパッケージ `/package/@scope/name` も対応

### URL → パッケージ名抽出

```
/package/mfm-renderer          → "mfm-renderer"
/package/mfm-renderer/v/0.0.1  → "mfm-renderer"
/package/@misskey-dev/summaly  → "@misskey-dev/summaly"
/package/@scope/name/tutorial  → "@scope/name"
```

実装イメージ:

```ts
const m = url.pathname.match(/^\/package\/(@[^/]+\/[^/]+|[^/]+)/);
if (!m) return null;
const pkg = m[1];
const apiUrl = `https://registry.npmjs.org/${encodeURIComponent(pkg).replace('%40', '@')}`;
// scope の @ は残し、/ だけ %2F にする ＝ encodeURIComponent('@misskey-dev/summaly') == '%40misskey-dev%2Fsummaly'
// なので %40 → @ に戻すか、自前で組み立てる
```

正確には `@` は registry 側でも生のまま受けてくれるが、`/` は **必ず `%2F` にエンコード必須**。`encodeURIComponent` で全部エンコードしてから `%40` を `@` に戻す形で組み立てる（registry URL の慣例に合わせる）。

### Registry レスポンスから Summary 組み立て

```ts
const latest = body['dist-tags']?.latest;
const v = body.versions?.[latest] ?? {};

return {
  title: body.name,                                                         // "@scope/name" or "name"
  description: body.description ?? v.description ?? null,                   // top-level 優先、無ければ v.description
  thumbnail: 'https://static-production.npmjs.com/58a19602036db1daee0d7863c94673a4.png',
  icon:      'https://static-production.npmjs.com/58a19602036db1daee0d7863c94673a4.png',
  player: { url: null, width: null, height: null, allow: [] },
  sitename: 'npm',
  sensitive: false,
  activityPub: null,
  fediverseCreator: null,
};
```

#### フィールド戦略

- **title**: `body.name`（パッケージ名そのもの）。「pkg-name - npm」のような装飾はしない（OG の挙動を観察してから必要なら追加）
- **description**: トップレベル `description` を最優先、なければ `versions[latest].description`、それも無ければ null（既存プラグインの挙動と整合）
- **thumbnail / icon**: 両方 npm 固定ハッシュ PNG（120×120、`58a19602036db1daee0d7863c94673a4.png`）。陳腐化リスクは将来のメンテで対応
- **player**: 空（`url: null` の placeholder）。npm はインタラクティブ player 持たない
- **sitename**: `'npm'` 固定

### `general()` を呼ばない完全置き換え

`bluesky` プラグインのような「`parseGeneral` に流す」パターンではなく、`wikipedia` / `amazon` のような **完全独自実装** にする。Registry API JSON のみで Summary が組める以上、HTML スクレイプは不要。

## 実装ステップ（チェックリスト）

各ステップで `pnpm eslint && pnpm test` を通す。

- [x] **Step 1 — プラグイン本体**
  - [src/plugins/npmjs.ts](../../src/plugins/npmjs.ts) を新設
    - `export const name = 'npmjs';`
    - `test(url)`: ホスト `(www\.)?npmjs\.com$` かつ pathname が `^/package/` で始まる
    - `summarize(url, opts)`:
      - パッケージ名を抽出（scope 対応）
      - `getJson('https://registry.npmjs.org/<encoded>')` で取得（`opts` をそのまま渡して UA / timeout を継承）
      - `dist-tags.latest` を取り、`versions[latest]` をマージ
      - `Summary` を組み立て
      - `dist-tags.latest` が無い場合（unpublish 直後など）は throw（`failed summarize` を呼出側で表示）
  - [src/plugins/index.ts](../../src/plugins/index.ts) に登録（既存の amazon 〜 nijie の末尾に追加）
- [x] **Step 2 — フィクスチャベースのテスト**（spotify/youtube パターンに準拠して fastify モック不要、pure 関数 `extractPackageName / buildRegistryUrl / buildSummaryFromRegistry` を直接テスト）
  - [test/htmls/](../../test/htmls/) の隣（あるいは `test/jsons/` 新設）に Registry API レスポンスの JSON フィクスチャを配置
  - [test/index.test.ts](../../test/index.test.ts) に以下のケースを追加:
    - 通常パッケージ（`mfm-renderer` 風）の `/package/<name>`
    - scoped パッケージ（`@misskey-dev/summaly` 風）の `/package/@scope/name`
    - サブパス付き（`/package/<name>/v/0.0.1`）が同じ Summary を返す
    - description が `versions[latest]` にしか無い場合のフォールバック
    - 不正な `/package/` パス（パッケージ名抽出失敗）→ `null` を返すか throw
  - テストハーネスのモックサーバ（fastify）に `registry.npmjs.org` 相当のルートを足す（既存の oEmbed テストパターンに合わせる）
- [x] **Step 3 — 動作確認 (dev サーバ)**
  - [dev/sample-urls.ts](../../dev/sample-urls.ts) に「npm パッケージ（registry API plugin）」グループを追加
    - `https://www.npmjs.com/package/mfm-renderer`
    - `https://www.npmjs.com/package/@misskey-dev/summaly`
    - `https://www.npmjs.com/package/react/v/19.0.0`（version パスでも latest が返ること）
- [x] **Step 4 — ドキュメント更新（4.5 のドキュメント突き合わせ）**: README プラグイン一覧 + Plugins.md 詳細セクション + CLAUDE.repo.md プラグイン表 + CHANGELOG feat エントリ
  - [CLAUDE.repo.md](../../CLAUDE.repo.md) の「対応形式（組み込みプラグイン）」表に `npmjs` 行を追加
    - マッチ条件: `(www.)?npmjs.com/package/...`
    - 挙動: Registry API (`https://registry.npmjs.org/<pkg>`) を直叩き。Cloudflare 保護を回避、HTML スクレイプを介さない
  - [CHANGELOG.md](../../CHANGELOG.md) unreleased セクションに追加
  - 必要なら [docs/Plugins.md](../../docs/Plugins.md) / [docs/Library.md](../../docs/Library.md) も
- [x] **Step 5 — knowhow 記録**: `plugin-infrastructure-patterns.md` に「Cloudflare 配下サイトの公式 JSON API 直叩きパターン」セクション追加 + INDEX キーワード更新
  - 「Cloudflare Bot Management 配下のサイトでも公式 JSON API は素通しなことが多い → Registry API 直叩きパターン」を `docs/knowhow/` に
  - 既存 [docs/knowhow/plugin-pattern.md](../../docs/knowhow/plugin-pattern.md) 等があれば追記、無ければ新規
- [x] **Step 6 — 品質ゲート**
  - Stage 1: `pnpm build && pnpm eslint && pnpm typecheck && pnpm test` (277 passed) + `bash .claude/tests/run-all.sh` 通過
  - Stage 2: `addf-code-review-agent` 通過 (Critical/High なし、Suggestion W-1/S-1/W-2 はコメント追記とテスト追加で対応済み)
  - `addf-contribution-agent` はスキップ条件「`.claude/` `docs/knowhow/ADDF/` `templates/` を含まない」に合致のためスキップ

## 完了条件 (Definition of Done)

- `https://www.npmjs.com/package/<pkg>` および scoped `/package/@scope/name` で Registry API 経由の Summary が返る
- バージョン指定パス (`/v/<ver>`) でも latest の Summary を返す
- `name` 定数が付与されている
- フィクスチャベースのテストが付いている
- dev サーバの sample-urls からワンクリックで動作確認できる
- `pnpm build && pnpm eslint && pnpm typecheck && pnpm test` が通る

## リスク・注意点

1. **icon URL の陳腐化**: npm 自社 CDN の固定ハッシュ PNG はいつか入れ替わる。リンク切れ検知は別途モニタリング（外部監視プランがあれば連携）。陳腐化したら GitHub の npm org アバター（`https://avatars.githubusercontent.com/u/6078720?s=200&v=4`）にスイッチ
2. **Registry API のレート制限**: 公開 Registry は寛容だが、Misskey 大規模インスタンスから集中アクセスがあると 429 を返す可能性。`getJson` の `StatusError` がそのまま伝播する設計で OK（既存の YouTube oEmbed と同様）
3. **`dist-tags.latest` 不在ケース**: 全バージョン unpublish 直後など。throw して general fallback には流さない（HTML 取得しても 403 で意味がないため）
4. **scope 付き URL の `@` エンコード**: `encodeURIComponent('@scope/name')` は `%40scope%2Fname` を返す。registry は両方受けるが、`@scope%2Fname` の形で組み立てる方が慣例に近い。テストでどちらも 200 を確認しつつ、実装側は `@` を残して `/` だけ `%2F` に置換する形を採用
5. **将来の HTML 化**: もし npm 側が Cloudflare 保護を緩めて bot にも HTML を返すようになっても、Registry API の方が高速・確実なので本プラグインは維持価値あり（plugin 順序で先勝ち）
