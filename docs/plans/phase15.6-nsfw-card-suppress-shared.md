# phase15.6 — NSFW プラグイン共通: card 抑制 + embed フル表示の二層構造を横展開

## 背景

phase15.5 で DMM (FANZA) プラグインに「card 抑制 + embed フル表示」の二層構造を導入した。オーナー要望 (2026-05-11): 他の成人系プラグイン (`dlsite` / `iwara` / `komiflo` / `nijie`) も **同じアプローチに揃える**。

各プラグインの sensitive 判定ロジック:

| プラグイン | sensitive=true の条件 | 抑制対象 |
|---|---|---|
| `dlsite` | `pathname` が `/^\/(home\|comic\|soft\|app\|ai)\//` に **マッチしない** (例: `/work/`, `/maniax/`) | 一部 (sensitive=true のみ) |
| `iwara` | `landingUrl.hostname === 'ecchi.iwara.tv'` | 一部 (sensitive=true のみ) |
| `komiflo` | API 取得成功時に常に true | 常時 |
| `nijie` | `pathname === '/view.php'` に着地時 常に true | 常時 |
| `dmm` (phase15.5) | プラグイン側で常に true | 常時 |

`sensitive=true` ケースのみ抑制を適用すれば、dlsite の `/comic/` (商業向け一般作品) や `iwara` 通常版は影響を受けず現状維持。

## ゴール

`dlsite` / `iwara` / `komiflo` / `nijie` の 4 プラグインに DMM phase15.5 同様の「card 抑制 + embed フル表示」を適用。同時に共通ロジックを `src/utils/` の helper 2 ファイルに抽出して DMM も同 helper を使うようにリファクタリング。

### Card preview (`summarize` の sensitive=true ケース)

| フィールド | 値 |
|---|---|
| `title` | `【<sitename>】<og:title>` の prefix 形式 (例: 「【DLsite】xxx」「【iwara】xxx」「【komiflo】xxx」「【nijie】xxx」「【FANZA】xxx」) |
| `description` | 固定 `【R-18】 内容を伏せています` |
| `thumbnail` | `null` 強制 |
| `icon` | parseGeneral 由来サイト favicon 維持 |
| `sensitive` | `true` 維持 |
| `player.url` | `<embedBaseUrl>/embed?url=<encoded>` (`renderEmbed` 連動) |

### Embed (`renderEmbed`)

制限なし: og:title / og:description / og:image / 各プラグイン固有 DOM 補強で得た情報を フル表示。CSP `default-src 'none'; img-src https:; style-src 'unsafe-inline'`。XSS 防御 (escapeHtml + `pickHttpsImage`)。

## 設計詳細

### 共通 helper の切り出し

```typescript
// src/utils/nsfw-card-suppress.ts (新規)
export function applyNsfwCardSuppression(
  summary: Summary,
  url: URL,
  embedBaseUrl: string | undefined,
): Summary {
  if (summary.sensitive !== true) return summary;  // sensitive=false は素通し
  const sitename = summary.sitename ?? 'site';
  const ogTitle = summary.title ?? '';
  const safeTitle = ogTitle !== '' ? `【${sitename}】${ogTitle}` : `【${sitename}】`;
  const playerUrl = composePlayerUrl(url, embedBaseUrl);
  return {
    ...summary,
    title: safeTitle,
    description: '【R-18】 内容を伏せています',
    thumbnail: null,
    player: playerUrl != null
      ? { url: playerUrl, width: 3, height: 2, allow: [] }
      : { url: null, width: null, height: null, allow: [] },
  };
}
```

```typescript
// src/utils/nsfw-embed-html.ts (新規、dmm.ts から移動 + 一般化)
export function composeNsfwEmbedHtml(input: {
  title: string;
  description: string;
  thumbnail: string | null;
  sitename: string;
}): string {
  // dmm.ts の composeEmbedHtml をそのまま移動
}
```

### 各プラグインの構造変更

`summarize` を 2 段に分ける:
- `summarizeRaw(url, opts)`: 既存ロジック (parseGeneral + 各プラグイン固有の DOM 補強 + sensitive 判定) を pure に保持
- `summarize(url, opts)`: `summarizeRaw` → `applyNsfwCardSuppression` を通す形に
- `renderEmbed(url, opts)`: `summarizeRaw` を呼び `composeNsfwEmbedHtml` で HTML 化

冗長な再 scpaping は `inFlightDedup` (phase4.2) が同 URL 同 UA でデデュプし、cache が効くケースでも cache hit fast path で軽量。

## 実装ステップ

### Step 1: 共通 helper の実装

- [x] `src/utils/nsfw-card-suppress.ts` 新規 (applyNsfwCardSuppression + composePlayerUrl)
- [x] `src/utils/nsfw-embed-html.ts` 新規 (composeNsfwEmbedHtml + pickHttpsImage、dmm.ts から移動)

### Step 2: dmm.ts のリファクタリング

- [x] composeEmbedHtml / composePlayerUrl / pickHttpsImage を utils に移動して dmm.ts から import
- [x] summarize の card 抑制ロジックを `applyNsfwCardSuppression` 呼び出しに置き換え (DMM は常に sensitive=true なので影響なし)

### Step 3: 4 プラグインへの適用

- [x] `dlsite.ts`: summarize を 2 段化、renderEmbed export 追加
- [x] `iwara.ts`: summarize を 2 段化、renderEmbed export 追加
- [x] `komiflo.ts`: summarize を 2 段化、renderEmbed export 追加
- [x] `nijie.ts`: summarize を 2 段化、renderEmbed export 追加

### Step 4: テスト

- [x] `applyNsfwCardSuppression` の pure 関数テスト (sensitive=true → 抑制、false → 素通し、embedBaseUrl 有/無 で player.url 切替、player の oEmbed fallthrough 防止)
- [x] `composeNsfwEmbedHtml` の pure 関数テスト (XSS 防御、non-https thumbnail 排除)
  - dmm の既存テストを共通 helper のテストに移行する形でも OK
- [x] 各プラグインの統合テストで sensitive=true ケースで card が抑制されることを確認 (dlsite の `/work/` で抑制 / `/comic/` で素通し、iwara の `ecchi.` で抑制 / `www.` で素通し、komiflo / nijie で抑制、dmm はそのまま)
- [x] dmm の既存テストが破壊されないこと

### Step 5: ドキュメント

- [x] `CLAUDE.repo.md` の dlsite / iwara / komiflo / nijie 行を更新
- [x] `README.md` プラグイン表の各行を更新 (備考に「sensitive 時 card 抑制 + embed フル表示」)
- [x] `docs/Plugins.md` の各セクションを更新
- [x] `CHANGELOG.md` unreleased に `enhance (plugin: dlsite/iwara/komiflo/nijie)` で追記
- [x] `dev/sample-urls.ts` の NSFW セクション note を更新
- [x] `docs/knowhow/age-gate-bypass-pattern.md` の二層構造セクションを「DMM 限定」から「NSFW 系プラグイン汎用パターン」に格上げ
- [x] `docs/knowhow/INDEX.md` 該当 entry にキーワード追加

### Step 6: 動作確認

- [x] `pnpm test` 全件パス
- [x] ビルド・lint・typecheck パス
- [x] `built/index.js` で sample URL を叩いて期待挙動を確認

## リスクと判断

- **dlsite 一部商業作品の挙動**: SAFE_PATH (`/comic/` 等) は sensitive=false のまま → applyNsfwCardSuppression が素通し → 既存挙動と同じ。dlsite の本テストで「セーフパスで sensitive にならない」確認は既存 (`test/index.test.ts:3012`) で担保
- **iwara www. の挙動**: 同じく sensitive=false → 素通し → 既存挙動と同じ
- **共通 helper の影響範囲**: 他に sensitive=true を立てるプラグイン (dmm) が含まれる。dmm は phase15.5 から既に applyNsfwCardSuppression と同じ挙動を独自実装していたため、helper への移行で機能変化なし
- **XSS / CSP 多層防御**: phase15.5 で確立した escapeHtml + `<img src>` を https 限定 + CSP `default-src 'none'` の三層を維持
- **テスト粒度**: 各プラグインで「sensitive=true / false 両方の経路」を確認、共通 helper は pure 関数として独立にテスト

## レビュー対応

- **W-1 (`addf-code-review-agent`)**: `src/index.ts` L293 の `embedBaseUrl` JSDoc が「`(現在は syosetu のみ)`」と stale だった (実際は syosetu / kakuyomu / dlsite / iwara / komiflo / nijie / dmm 等 7+ プラグインが `renderEmbed` 実装)。レビュー agent 側で直接修正済み、採用
- **S-1 (`nijie.renderEmbed` の `/view.php` 以外経路)**: `/view.php` 以外でも embed が呼ばれうる挙動についてコメント追加で意図を明記 (= NSFW サイト全体で embed 許可、非 view.php は通常 OGP のフル表示)
- **S-2 (`komiflo.renderEmbed` の API 失敗時挙動)**: API 失敗時に sensitive=undefined の summary がフル表示される挙動についてコメント追加 (= 機能縮退、実害なし)
- **S-3 (`composeNsfwEmbedHtml` の XSS テスト拡張)**: 属性 URL 系 XSS (`<a href="javascript:">` 等) のテスト追加は将来余地。現状 `escapeHtml` で `"` がエンコードされるため実害なし、スキップ

## サイズ

M〜L (実装規模 ~400 行差分、helper 2 ファイル新設 + 5 プラグイン修正 + テスト 10+ 件)
