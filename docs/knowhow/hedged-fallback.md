# Hedged fallback (champion / challenger pool 並列発火)

phase18 で導入した経路選定全自動化機構。Google "The Tail at Scale" の hedged request パターンに champion / challenger 階層を組み合わせた設計。

## 設計判断のサマリ

| 項目 | 採用 | 理由 |
|---|---|---|
| 階層 | champion 1 つ + challenger pool (順位なし) | 状態空間最小化。phase14 既存の `pathKey → 1 strategy` 構造をそのまま流用 |
| 発火条件 | champion `thresholdMs` (5s) 経過 or 失敗 | 安定状態 (champion 即勝ち) では並列発火しない |
| 並列数 | challenger 全員 (= ALL_STRATEGIES - champion) | ランキング不要、機械的に「champion 以外全員」 |
| 昇格 | 1 回で確定 | 並列発火そのものが「champion 不適切」シグナルを内包する |
| 降格・除外 | なし | 一時失敗で永久除外は危険、無駄経路への投入はレアイベントなら許容 |
| valid 判定 | HTTP 層は `() => true`、thin 判定は summary 層 | 判定ロジックの分離、`isThinSummary` を summary 層で活用 |
| Final error skip | `not_found` / `ssrf_blocked` / `unsupported_type` / `content_too_large` / `parse_error` | 別経路で叩いても結果が変わらない確定エラーは並列発火 skip |
| AbortSignal 伝搬 | best-effort | 勝者確定後の残り inflight を cancel。完全保証ではない (subprocess kill 等) |

## なぜ揺らぎ防止 (N 連続要件) が不要か

並列発火のフローを再確認すると:

- 第一候補 A が 5 秒以内に valid を返す → 並列発火しない → A 維持
- A が 5 秒以内に返せず B が並列で勝つ → B 昇格
- 次回 B が 5 秒以内に valid → 維持

**安定状態は「champion が常時 5s 以内 valid」**。並列発火が起きるのは「champion 不調」のときだけ。揺らぐとしたら「どの経路も 5 秒近辺で大差ない」ケースだが、その場合はどちらに揺らいでも user impact ほぼゼロ。

唯一のエッジケース: 「ネットワーク瞬断で稀に第一候補が失敗」でも、退行しても自然に再選定が起きるので **自己修復する**。N 連続要件は過剰設計。

## なぜ降格・除外が不要か

並列発火が起きるのは champion 不調時の **レアイベント**。yodobashi で `champion = curl_cffi` が確立すれば 99.9% は curl_cffi 直行 → got への無駄投入は実質起きない。

「無駄経路 (got 経路が yodobashi で構造的に絶対失敗) も並列発火時に走る」が、これは数か月に 1 回レベルのコストとして許容できる (個人運用 instance、CF Workers Free 枠、curl_cffi subprocess)。

「champion が常時遅延する病的サイト」では並列発火が常態化するが、これは champion の選定ミスを示すシグナルなので challenger が勝って入れ替わる (= 自己修復)。

## isFinalError の必要性

`Promise.any` で「全 challenger gate_failed」の状態が起きうる:

- 例: 404 が返るサイトで champion = default → 即 404 → hedge fire → fallback_ua / proxy / curl_cffi が config 上 gate_failed → `HedgedRaceAllFailedError`

このとき champion error (404) を `causes` に補填しても、別経路で叩く意味はない (404 は別経路でも 404)。`isFinalError` で hedge fire 自体を skip し、champion error をそのまま throw する設計が正しい。

phase18 では以下を final 扱い:

| Category | 理由 |
|---|---|
| `not_found` (404) | サイトが意図的に返した 404 |
| `ssrf_blocked` | Private IP は別経路でも同じ |
| `unsupported_type` | content-type が違うのは別経路でも同じ |
| `content_too_large` | サイズ超過は別経路でも同じ |
| `parse_error` | response は取れている、HTML パース失敗は別経路でも同じ |

`bot_blocked` (4xx 全般、404 以外) は **retryable**。WAF の 403 で fallback_ua / proxy で救援できるケースがあるため。

## AbortSignal 伝搬の best-effort

各経路に signal を伝搬するが、内部の HTTP/HTTPS リクエストや subprocess が完全に止まるかは経路次第:

- `getResponse` (got 経路): `signal.aborted` で got 内部の AbortController を発火 → リクエスト abort
- `viaProxyWorker`: 同上 (proxy への got リクエストを abort)
- `viaCurlCffi`: subprocess を SIGKILL で強制終了 (Python プロセス終了)

`signal.addEventListener('abort', ..., { once: true })` で listener leak を防ぐ。subprocess の `removeEventListener` は settle ガードで二重防御。

## 旧 cascade 機構 (`getResponseWithFallback` 等) の扱い

phase14 までの段階的 cascade (`getResponseWithFallback` → `getResponseWithProxyFallback` → `getResponseWithCurlCffiFallback`) は **dead code 化** したが、API として export しているため互換性維持で温存 (内部から呼ばれない、外部利用者がいる可能性は薄い)。将来 phase で削除候補。

## phase14 既存機構との関係

| 機能 | phase14 | phase18 |
|---|---|---|
| pathKey → strategy 永続化 | ✓ | そのまま流用 (champion 永続化として) |
| bootstrap JSONL 同梱 | ✓ | そのまま (初期 champion ヒント役) |
| N 連続失敗で invalidate | ✓ | そのまま (champion 単位の再選定トリガ) |
| 段階的 cascade fallback | ✓ | **撤廃** → hedge race に置換 |
| `domains` allowlist (proxy/curl_cffi) | bootstrap 自動導出 | 機能上は無効化 (hedge race で全経路発火) |
| `categories` 発火制御 | コード固定 | 機能上は無効化 (hedge race で全 retryable で発火) |

## 関連 Plan / 実装

- [docs/plans/phase18-hedged-fallback.md](../plans/phase18-hedged-fallback.md) — 設計詳細・ステップ
- [src/utils/hedged-fetch.ts](../../src/utils/hedged-fetch.ts) — `hedgedRace` 本体
- [src/utils/got.ts](../../src/utils/got.ts) — `fetchResponse` で hedge race を呼び出す層
- [tools/curl-cffi-fetcher/src/curl_cffi_fetcher/fetch.py](../../tools/curl-cffi-fetcher/src/curl_cffi_fetcher/fetch.py) — Python 側 SSRF ガード
- [docs/knowhow/domain-strategy-cache.md](domain-strategy-cache.md) — phase14 経路学習キャッシュの基盤
- [docs/knowhow/cf-workers-outbound-proxy.md](cf-workers-outbound-proxy.md) — proxy 経路の知見
- [docs/knowhow/curl-cffi-tls-impersonation.md](curl-cffi-tls-impersonation.md) — curl_cffi 経路の知見
- [docs/knowhow/bot-block-ua-retry.md](bot-block-ua-retry.md) — fallback_ua 経路の知見

## 知られたエッジケース・落とし穴

### 1. `Promise.any` の AggregateError と unhandled rejection

`Promise.any` が AggregateError で reject すると、内部の wrapper promise の rejection が unhandled として観測される (vi.useFakeTimers + `expect.rejects.toThrow` の micro-task ordering で特に顕在化)。対処:

```typescript
const wrappers = inFlight.map((p) => p.then(...));
// 各 wrapper に .catch を chained して unhandled rejection 抑制
wrappers.forEach((w) => { w.catch(() => { /* noop */ }); });
try {
  const validResult = await Promise.any(wrappers);
} catch { /* AggregateError は外側 try/catch で受ける */ }
```

vitest 側でも `racePromise.catch((e) => e)` を先に呼んで unhandled を抑制してから `expect` する。

### 2. 勝者の AbortController を `finally` の二重防御で abort しない

勝者は既に resolve 済みだが、signal の abort listener が後追いで発火すると副作用 (subprocess kill 試行等) が起きる。対処: `winnerStrategy` を outer scope に持って finally で skip。

```typescript
let winnerStrategy: DomainStrategy | undefined;
// ... 勝者確定時に winnerStrategy = ... をセット
} finally {
  for (const [s, ac] of aborters) {
    if (s === winnerStrategy) continue;
    try { ac.abort(); } catch { /* defense-in-depth */ }
  }
}
```

### 3. champion error を集約 cause に補填

`first` が threshold 前に失敗 → champion promise は `inFlight` (= challengers) に含まれない → 全 reject 時の `causes` 集計で champion error が漏れる。

対処: champion error を outer scope 変数 (`championError`) に保持し、catch ブロックで補填:

```typescript
if (championError != null && !causes.some((c) => c.strategy === config.champion)) {
  causes.unshift({ strategy: config.champion, error: championError });
}
```

これがないと `category: unknown` で error 分類が壊れる。

### 4. 元 error をそのまま throw する (wrapper で `new Error` に置き換えない)

`Promise.any` 用の wrapper で `if (settled.error != null) throw new Error('error')` のように generic error に置き換えると、`StatusError` 等の statusCode 情報が失われ、`categorizeError` で `unknown` 分類される。`throw settled.error` で元 error をそのまま伝搬するのが正しい。
