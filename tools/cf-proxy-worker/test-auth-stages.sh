#!/usr/bin/env bash
# Worker の認証段階的復活デバッグ用 (phase12.1 followup)。
#
# tmp.js の各認証チェックを段階的にコメントイン → wrangler deploy → このスクリプトで検証、
# の繰り返しで「どこで壊れたか」を切り分ける。
#
# 使い方:
#   export SHARED_SECRET="<wrangler secret put SHARED_SECRET と同値>"
#   bash tools/cf-proxy-worker/test-auth-stages.sh [worker_url]
#
# デフォルトの worker_url は引数 or env WORKER_URL or 既知の URL。

set -u

WORKER_URL="${1:-${WORKER_URL:-https://summaly-proxy.riinsworkspace.workers.dev}}"
SECRET="${SHARED_SECRET:-}"

# テスト用 URL (Amazon の正規 dp/<asin> 形)
TARGET="https://www.amazon.co.jp/dp/B0C4LRBFX6"
TARGET_ENC=$(node -e "console.log(encodeURIComponent('$TARGET'))")

# 期待結果:
# - PASS = HTTP 200 + HTML body (透過プロキシ成功)
# - DENY = HTTP 403 + "forbidden" (認証拒否、期待される拒否動作)

echo "Worker URL: $WORKER_URL"
echo "Target URL: $TARGET"
echo ""

step() {
	local label="$1"
	local expected="$2"
	shift 2
	local status size body
	status=$(curl -sS -o /tmp/ws_body -w "%{http_code}" "$@") || status=ERR
	size=$(wc -c < /tmp/ws_body | tr -d ' ')
	body=$(head -c 80 /tmp/ws_body | tr '\n' ' ')
	local mark
	if [[ "$expected" == "PASS" && "$status" == "200" ]]; then mark="✅"
	elif [[ "$expected" == "DENY" && "$status" == "403" ]]; then mark="✅"
	else mark="❌ EXPECTED $expected"; fi
	printf '%-60s status=%s size=%s %s\n' "$label" "$status" "$size" "$mark"
	[[ "$mark" == ❌* ]] && printf '  body: %s\n' "$body"
}

echo "================================================================"
echo "Stage 1: 認証全部コメントアウト (現状の tmp.js の状態)"
echo "================================================================"
step "  ヘッダ無しで GET (透過プロキシのみ動作)" "PASS" \
	"$WORKER_URL/?url=$TARGET_ENC"
step "  POST は method check で 403" "DENY" \
	-X POST "$WORKER_URL/?url=$TARGET_ENC"
step "  url パラメータ無しは 透過 fetch failure" "DENY" \
	"$WORKER_URL/"
step "  http:// は HTTPS-only check で 403" "DENY" \
	"$WORKER_URL/?url=http%3A%2F%2Fexample.com"
step "  allowlist 外ドメインは 403" "DENY" \
	"$WORKER_URL/?url=https%3A%2F%2Fexample.com"

echo ""
echo "================================================================"
echo "Stage 2: param 存在チェック復活 (sigHeader/tsHeader を必須化)"
echo "  → tmp.js の L20-22 のコメントアウトを外す & wrangler deploy"
echo "================================================================"
step "  ヘッダ無し → 403 になるはず (param 必須)" "DENY" \
	"$WORKER_URL/?url=$TARGET_ENC"
step "  ダミー sig/ts ヘッダ → 200 (中身は見ないので通る)" "PASS" \
	-H "x-summaly-sig: deadbeef" -H "x-summaly-ts: 1700000000" \
	"$WORKER_URL/?url=$TARGET_ENC"

echo ""
echo "================================================================"
echo "Stage 3: timestamp window チェック復活"
echo "  → tmp.js の L27-29 のコメントアウトを外す & wrangler deploy"
echo "================================================================"
step "  古い ts (2023) → 403 (window 外)" "DENY" \
	-H "x-summaly-sig: deadbeef" -H "x-summaly-ts: 1700000000" \
	"$WORKER_URL/?url=$TARGET_ENC"
NOW_TS=$(($(date +%s) * 1000))
step "  現在時刻 ts → 200 (HMAC まだチェックしないので sig は dummy で OK)" "PASS" \
	-H "x-summaly-sig: deadbeef" -H "x-summaly-ts: $NOW_TS" \
	"$WORKER_URL/?url=$TARGET_ENC"

echo ""
echo "================================================================"
echo "Stage 4: HMAC 検証復活 (最終形)"
echo "  → tmp.js の L32-34 のコメントアウトを外す & wrangler deploy"
echo "================================================================"
if [[ -z "$SECRET" ]]; then
	echo "  ⚠️ SHARED_SECRET 未設定 — Stage 4 をスキップします"
	echo "  実行するには: export SHARED_SECRET='<wrangler secret put した値>'"
else
	NOW_TS=$(($(date +%s) * 1000))
	# sign.mjs と同じロジックで HMAC-SHA256 を Node 標準 crypto で生成
	GOOD_SIG=$(SHARED_SECRET="$SECRET" node -e "
		const c = require('node:crypto');
		const sig = c.createHmac('sha256', process.env.SHARED_SECRET)
			.update('$TARGET\n$NOW_TS').digest('hex');
		console.log(sig);
	")
	step "  正しい HMAC sig + 現在時刻 ts → 200" "PASS" \
		-H "x-summaly-sig: $GOOD_SIG" -H "x-summaly-ts: $NOW_TS" \
		"$WORKER_URL/?url=$TARGET_ENC"
	step "  不正な sig → 403 (mismatch)" "DENY" \
		-H "x-summaly-sig: deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" \
		-H "x-summaly-ts: $NOW_TS" \
		"$WORKER_URL/?url=$TARGET_ENC"
fi

echo ""
echo "================================================================"
echo "完了。本番 summaly (proxy-fallback.ts) は Stage 4 と同じ HMAC を送るので、"
echo "Stage 4 の '正しい sig → 200' が ✅ なら summaly 経由も通るはず。"
echo "================================================================"
