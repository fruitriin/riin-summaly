# 結果 sanitize と HTTP agent 設計

phase2.2 で導入した「結果 URL の sanitize」「keep-alive デフォルト agent」「`useRange` / `allowedPlugins`」の設計判断を残す。

## 結果 URL の sanitize（最終リターン直前で適用）

[src/utils/sanitize-url.ts](../../src/utils/sanitize-url.ts) で `https:` / `http:` / `data:`（10KB 以下）のみ通す。

**設計の決め手**:

1. **適用ポイントは最終リターン直前の 1 箇所のみ**: プラグイン側で sanitize を呼ばず、汎用パスとプラグインパスを問わず `summaly()` 出口で集約フィルタする。プラグインの実装ミスで `javascript:` URL が漏れても安全
2. **`data:` は許可するが長さ上限を厳守**: 将来の PDF アイコン用途を見据えて完全 reject はしない。**バイト長 (`Buffer.byteLength`) で判定**（文字長だと URL エンコードされた非 ASCII でブレる）
3. **`player.url` が null になったら player 全体をリセット**: `url=null` なのに `allow=['fullscreen', ...]` が残ると利用側が誤って permission を付与する可能性がある。セキュリティを最大化する原則として「URL が信頼できないなら **そのコンテキスト全体を信頼しない**」
4. **`medias[]` は filter で空要素を除去**: `null` を配列に残さず、利用側が `medias.length === 0` で判定できるようにする

## keep-alive デフォルト agent

[src/utils/agent.ts](../../src/utils/agent.ts) で `http.Agent` / `https.Agent` を `keepAlive: true` で生成し、[src/utils/got.ts](../../src/utils/got.ts) の `getEffectiveAgent()` で fallback として使う。

**設計の決め手**:

1. **`setAgent` で外部 agent が来ていたらそちらを優先**: 既存の API 互換性を保ち、プロキシ用途にも対応
2. **SSRF ガードと agent fallback で同じ判定（`isExternalAgentSet()`）を共有**: `Object.keys(agent).length > 0` のロジックを 2 箇所に書かないことでドリフト防止
3. **テスト後の cleanup（`destroyDefaultAgents()`）が必須**: keep-alive ソケットを閉じないと vitest プロセスがハングする。`afterAll` で必ず呼ぶ
4. **`SUMMALY_FAMILY=4`/`=6` で IP family を強制**: mei23 互換、IPv6 only 環境での運用に対応

## `useRange` オプション

`Range: bytes=0-N-1` で先頭 N バイトのみ取得。サーバが Range 未対応なら 200 OK でフルボディが返るため、既存の `contentLengthLimit` ガードで保護される。

**設計の決め手**:

1. **Range の end と `contentLengthLimit` を一致させる**: 「どこまで読むか」の数字を 1 箇所（`DEFAULT_MAX_RESPONSE_SIZE` または `opts.contentLengthLimit`）に集約
2. **GenericScrapingOptions まで透過**: `summaly` → `general` → `scpaping` → `getGotOptions` のチェーンで `useRange` を全て受け渡す。1 箇所でも漏れると Range が送られない（実装中に発覚し追加修正した）

## `allowedPlugins` オプション

`undefined` = 全有効、`string[]` = オプトイン許可リスト、`[]` = 組み込み全 disable。

**設計の決め手**:

1. **組み込みプラグインのみフィルタ対象**: `opts.plugins`（外部プラグイン）はカスタム性を尊重してフィルタしない（導入者責任）
2. **`name` を持たない外部プラグインは自動的に除外**: `p.name != null && allowedPlugins.includes(p.name)` 条件で安全に弾ける
3. **空配列 `[]` の意味を明確化**: 「組み込み全 disable」が意図的に呼べる選択肢として保持。汎用パスのみで運用したいケース用

## 関連

- [object-assign-mutable-target.md](object-assign-mutable-target.md) — オプション扱いの落とし穴
- [plugin-infrastructure-patterns.md](plugin-infrastructure-patterns.md) — getJson / name / BROWSER_UA / KNOWN_SHORT_HOSTS（phase2.1）
