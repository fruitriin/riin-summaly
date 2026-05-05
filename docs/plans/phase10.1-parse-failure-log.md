# Phase 10.1 — パース失敗ドメインのログ蓄積（プラグイン候補発見器）

> 状態: **完了 (2026-05-05)**
> 種別: 観測性 / 運用支援
> サイズ: **M**
> 関連: [phase4.1](phase4.1-fastify-in-memory-cache.md)（インメモリ singleton パターン）、[phase7.1](phase7.1-dev-server.md)（dev UI で表示する案）

## 目的・背景

Misskey インスタンスを運用していると「このドメインのプラグインがあれば preview が綺麗になる」という気付きがログから散発的に得られるが、現状は systemd ジャーナルに散らばっていて活用しづらい。

本フェーズでは Fastify モードに **「パース失敗 / 内容スカスカ」のドメインを、ディレクトリ単位で集約してプロセス内に蓄積する仕組み** を入れる。

集約方針:
- key = `${url.hostname}/${1〜2 セグメント目のパス}`（例: `qiita.com/<user>`）
- value = 直近 N 件（デフォルト 5）の URL サンプル + 失敗理由
- 既出の key は新着サンプルで先頭に押し出し、上限に達したら末尾を捨てる ring buffer
- 全体の key 数も上限を設けてメモリ爆発を防ぐ

「どんな key で何件くらい刺さっているか」を覗ける読み取り API（または dev UI 連携）を用意し、運用者がプラグイン候補を可視化できるようにする。

---

## 現状分析

### 「失敗」の定義

候補:

1. **summaly() が throw**: `failed summarize` / network error / 4xx-5xx / type filter reject
2. **summary が "thin"**: `title == null && description == null && thumbnail == null`（OG/Twitter Card/`<title>` のいずれも取れなかった）
3. **summary が "ほぼ thin"**: `title` のみあり（hostname or page title） + `description == null && thumbnail == null` — 汎用パスで OG が無く `<title>` だけ拾えたケース。プラグイン化すれば改善余地が大きい

→ **(1) + (3) を「失敗」とみなして記録する**。(2) はその extreme case として (3) に含まれる。HEAD 失敗で 404 になっただけのリンク切れは記録しない方針（プラグインで救えないため）— 4xx/5xx は除外。

### ログ集約の粒度

ホスト名のみだと粗すぎ（`qiita.com` 全体で 1 グループ）、フルパスだと細かすぎ（同記事が別 URL で何度も）。

→ key は **`${hostname}/${pathSegments.slice(0, 2).join('/')}`** を採用:

- `qiita.com/UserA/items/abc` → `qiita.com/UserA/items`
- `qiita.com/UserA` → `qiita.com/UserA`
- `note.com/foo/n/abc` → `note.com/foo/n`
- `example.com/` → `example.com/`

「ユーザー＋投稿カテゴリ」の粒度になり、サイト全体の構造が見えやすい。

### メモリ消費の見積もり

- 1 サンプル = `{ url: ~200B, ts: 8B, reason: ~50B }` = ~300B
- グループ上限 1000 × サンプル 5 = **5000 サンプル × 300B ≒ 1.5MB**
- 上限内に収まる範囲なら現実的

---

## 設計方針

### 機能フラグ

- `inMemoryCache` と同じく **`inFlightDedup` / `inMemoryCache` と独立** したオプトイン機能
- TOML キー: `[diagnostics] parseFailureLog`、`[diagnostics] parseFailureLogMaxGroups`、`[diagnostics] parseFailureLogSamplesPerGroup`
- `SummalyOptions.parseFailureLog?: boolean`（デフォルト `false`）

```toml
[diagnostics]
parseFailureLog = true                 # オプトイン
parseFailureLogMaxGroups = 1000        # 全体のグループ数上限
parseFailureLogSamplesPerGroup = 5     # 1 グループあたりサンプル数
```

### データ構造

```ts
type ParseFailureSample = {
  url: string;         // sanitize 済み: query / fragment 除去
  ts: number;          // Date.now()
  reason: 'thin' | 'throw';
  errorMessage?: string; // throw の場合のみ
};

type ParseFailureLog = Map<string, ParseFailureSample[]>;
```

シンプルな `Map<groupKey, samples[]>` を Fastify プラグインスコープ singleton で保持。

### 記録タイミング

Fastify ハンドラの結果を見て記録する:

- `summaly()` が **throw** → `reason: 'throw'` で記録（HEAD/GET fallback 経由のリダイレクト 4xx は除外）
- `summaly()` が成功し、結果が **`description == null && thumbnail == null` で title が hostname / `<title>` 由来のスカスカ** → `reason: 'thin'` で記録
  - `summary.title === url.hostname` の単純比較に加え、プラグイン経由（`title === '<user> on X'` 等）で取れたものは thin と見なさない判定が必要

実装上はプラグインがマッチして summarize したかを Fastify ハンドラに伝える必要がある（現状の `summaly()` は match を内部だけで使っている）。**`SummalyResult` に `_resolvedBy?: string` のような診断フィールドを生やすか**、`summaly()` が `{ summary, matchedPlugin }` の構造で返す形へ拡張するか。後者は破壊的変更なので前者を採用する候補。

→ **採用: 記録は in-flight dedup の `respondWithEntry` 直前で判定する**。`summary.url` のホストと `summary.title` の関係から「汎用パス由来の thin」を推定する形にして、内部 API を変えない。判定ロジックは:

```ts
function isThinSummary(summary: SummalyResult): boolean {
  if (summary.description != null) return false;
  if (summary.thumbnail != null) return false;
  if (summary.player.url != null) return false;
  // title が hostname と同じ or null → 汎用パスで何も取れなかった可能性が高い
  if (summary.title == null) return true;
  try {
    const host = new URL(summary.url).hostname;
    return summary.title === host || summary.title === '';
  } catch {
    return true;
  }
}
```

精度は完璧ではないが「プラグイン化候補を見逃すよりノイズが少し増える方を許容」する。

### 集約ロジック

```ts
function groupKeyOf(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean).slice(0, 2);
    return `${u.hostname}/${segs.join('/')}`;
  } catch {
    return '_invalid';
  }
}

function record(log: ParseFailureLog, sample: ParseFailureSample, maxGroups: number, perGroup: number): void {
  const key = groupKeyOf(sample.url);
  const samples = log.get(key) ?? [];
  // 同 URL の重複追加を抑制（同じ URL を連打されても 1 件しか残らないように）
  const filtered = samples.filter(s => s.url !== sample.url);
  filtered.unshift(sample);
  if (filtered.length > perGroup) filtered.length = perGroup;
  log.set(key, filtered);

  // グループ数上限超過時は最も古いキーから捨てる（Map は挿入順）
  while (log.size > maxGroups) {
    const oldest = log.keys().next().value;
    if (oldest === undefined) break;
    log.delete(oldest);
  }
}
```

`Map` の挿入順 LRU 風に「グループとして最後に活動したキー」を保持する。同 URL の重複追加抑制で「同じリンクを 100 人が貼って 5 サンプル全部同じ URL」になる事故を防ぐ。

### 読み取り API

Fastify のハンドラで集約結果を返す:

```ts
fastify.get('/__diagnostics/parse-failures', async () => {
  // [{ key, count, samples: [{url, ts, reason, errorMessage}] }]
  return Array.from(parseFailureLog.entries()).map(([key, samples]) => ({
    key,
    count: samples.length,
    samples,
  }));
});
```

注意点:
- **公開エンドポイントになるとプライバシー漏洩**（過去の preview 試行 URL が誰でも見える）になるため、デフォルト無効、または `[diagnostics]` セクションで `endpointEnabled = true` を別途要求
- nginx 側で `location /__diagnostics/ { allow 127.0.0.1; deny all; }` 等のアクセス制限を運用者が設定する想定
- README/SETUP.md でこの注意を強調

### dev サーバ連携（任意）

`pnpm dev` の左ペイン or 別タブで `parse-failures` を一覧表示する小機能を追加すれば、ローカル検証時にも確認しやすい。**本フェーズではスコープ外**、phase10.2 等で別途検討。

### TOML スキーマ

```toml
[diagnostics]
parseFailureLog = false              # オプトイン
parseFailureLogMaxGroups = 1000      # 上限グループ数
parseFailureLogSamplesPerGroup = 5   # 1 グループあたりサンプル数
parseFailureLogEndpoint = false      # /__diagnostics/parse-failures の公開（要 nginx ガード）
```

`bin/config-loader.ts` に対応マッピングを追加。

---

## 実装ステップ（チェックリスト）

各ステップで `pnpm eslint && pnpm typecheck && pnpm test` を通す。

### 実装結果メモ

- **「絶対失敗類型」の除外を Plan 中に追加**: 元プランは throw/thin の 2 系統で記録する想定だったが、実装中にユーザー指摘で `isFilteredFailure` を追加。Akamai bot block の 403、timeout、SSRF block、ENOTFOUND 等を除外し、純度の高いプラグイン候補だけがログに残る形に
- **`endpoint: true` + `log: false` を fail-fast** (レビュー W-3): register 時に `done(error)` で reject。誤設定検出
- **`data:` / `file:` の placeholder 処理** (レビュー W-1): `URL.origin` が `"null"` を返すスキームでガベージ文字列がログに混入するのを `sanitizeUrlForLog` 冒頭の protocol チェックで防ぐ
- **`medias[]` を thin 判定に追加** (レビュー S-3): プラグインが multi-photo を返したケースを thin とみなさない
- **`record()` 同期性をコメントで担保** (レビュー S-1): 将来 await を入れるときの注意喚起

- [x] **Step 1 — `SummalyOptions` 拡張** — `parseFailureLog?` / `parseFailureLogMaxGroups?` / `parseFailureLogSamplesPerGroup?` / `parseFailureLogEndpoint?`
- [x] **Step 2 — 集約ロジック** — `src/utils/parse-failure-log.ts`、単体テスト 32 件 (`groupKeyOf` / `sanitizeUrlForLog` / `isThinSummary` / `isFilteredFailure` / `ParseFailureLog` ring buffer + LRU)
- [x] **Step 3 — Fastify ハンドラに統合** — MISS 経路で `entry.kind === 'error'` を `isFilteredFailure` でフィルタ、`isThinSummary(entry.value)` を thin 判定。LRU/dedup HIT は重複記録しない設計を統合テスト 6 件で担保
- [x] **Step 4 — 読み取りエンドポイント** — `GET /__diagnostics/parse-failures`、`{ groups, size, enabled }` を ts 降順で返す。`endpoint: true` + `log: false` の誤設定は register 時 fail-fast
- [x] **Step 5 — TOML 設定マッピング** — `bin/config-loader.ts` の `[diagnostics]` セクション、`expectPositiveInteger` ヘルパ、5 件のテスト追加
- [x] **Step 6 — config.example.toml / docs/SETUP.md / CHANGELOG 更新** — nginx ガード必須を明記、絶対失敗類型の自動除外を解説

---

## 完了条件 (Definition of Done)

- `parseFailureLog: true` で起動した Fastify が、汎用パスでスカスカ summary を返した URL を集約する
- `parseFailureLogEndpoint: true` で `GET /__diagnostics/parse-failures` が JSON を返し、グループ key と直近 5 サンプルが見える
- 同 URL の重複追加が抑制される（5 サンプルが同じ URL で埋まらない）
- グループ数上限 / サンプル数上限が効く（メモリ爆発しない）
- 既存テストすべて通過 + 新規テスト
- README に「プラグイン候補発見器として運用、エンドポイントは nginx でガードすること」を明記

---

## リスク・注意点

1. **プライバシー**: 失敗 URL に query string で session ID / API token が乗っているケース。`groupKeyOf` で query を捨てるが、サンプル `url` には残ってしまうと事故。**サンプルに保存する `url` も query / fragment を捨てた `${origin}${pathname}` にする** ことで一定保護。完全にユーザー入力 URL を保存しない方針も検討に値する
2. **エンドポイント公開**: デフォルト無効 + 公開時は nginx 側で `allow 127.0.0.1; deny all;` を必須化、を README で強調
3. **メモリ**: 上限 (1000 group × 5 sample) 内に収まる設計だが、極端な YT shorts 流入等で `youtube.com/shorts` グループが flood される可能性。`isThinSummary` の判定で youtube プラグイン経由は除外されるはずなので問題ないはず（要確認）
4. **「thin」判定の精度**: hostname と一致する title を thin とみなすが、本当に「サイト名 = 記事タイトル」のサイトでは false positive。許容範囲の運用指標として割り切る
5. **テスト**: vitest の同プロセス内 singleton の影響で、テスト間で log が漏れる可能性。各テストの beforeEach で log をクリアする

---

## オープンクエスチョン

- **A. ライブラリ用途 (`summaly()` 直叩き) でも記録するか**: NO。Fastify モード専用にする方が意図が明確。`summaly()` を library として使う側が独自に集計するのが自然
- **B. 永続化（Redis / file）するか**: 本フェーズではスコープ外。プロセス再起動で消える前提で、運用者が定期的にスクレイプする
- **C. dev UI に統合するか**: 別 phase（10.2 等）で検討。本フェーズはサーバ機能のみ
- **D. 「thin」だけでなく汎用パス到達率も統計に**: e.g. `{ totalRequests, throws, thins, plugin-matched }` の counter を別途持つと「全体のうちプラグイン化したいドメインの割合」が見える。本フェーズでは簡易ログのみ、本格的な metrics は phase 別途
