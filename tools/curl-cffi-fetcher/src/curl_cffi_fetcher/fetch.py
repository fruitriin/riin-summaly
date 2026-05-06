"""
curl_cffi 経由で URL を取得して JSON で stdout に出力する CLI (phase12.5)。

summaly の Node.js 側からは `child_process.spawn` で本ツールを呼び出し、stdout の JSON を
パースして利用する想定。`curl_cffi` は libcurl-impersonate (https://github.com/lwthiker/curl-impersonate)
を使って Chrome / Firefox / Safari の TLS フィンガープリント (JA3) を完全再現するため、
yodobashi 級の TLS layer bot block (HTTP/2 INTERNAL_ERROR / 即時切断) を回避できる可能性がある。

## 使い方 (実験段階)

    uv run fetch <URL> [--impersonate chrome120] [--timeout 20]

出力 (stdout に JSON):

    {
        "status": 200,
        "final_url": "https://...",
        "content_type": "text/html; charset=UTF-8",
        "headers": {...},
        "body": "<html>..."  # UTF-8 string
    }

エラー時:

    {"error": "...", "category": "timeout|network|other"}

## なぜ Python / uv を選んだか

- `curl_cffi` は Python から libcurl-impersonate を呼ぶ最もメンテされているバインディング
- `uv` でプロジェクト隔離 (summaly 本体の pnpm 環境に Python 依存を持ち込まない)
- Node.js 側との通信は **stdio JSON で疎結合** (HTTP / Unix socket より単純)
- GO/NO-GO 判定後、本格運用するなら長期駐留型 (stdin で URL 連続受信) に拡張可能

実験フェーズでは spawn-per-request (起動コストあり) で動作確認 → GO なら最適化。
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

try:
    from curl_cffi import requests  # type: ignore[import-not-found]
except ImportError as e:
    json.dump({"error": f"curl_cffi import failed: {e}", "category": "setup"}, sys.stdout)
    sys.exit(1)


DEFAULT_IMPERSONATE = "chrome120"
DEFAULT_TIMEOUT_SEC = 20.0
# OGP 取得目的なので 5 MiB で十分。これ以上は商品ページとしても異常
DEFAULT_MAX_BYTES = 5 * 1024 * 1024


def fetch(url: str, impersonate: str, timeout: float, max_bytes: int) -> dict[str, Any]:
    """curl_cffi で URL を取得して dict を返す。例外は呼び出し側でハンドル。"""
    response = requests.get(
        url,
        impersonate=impersonate,  # type: ignore[arg-type]
        timeout=timeout,
        allow_redirects=True,
        max_redirects=5,
    )
    body_bytes: bytes = response.content or b""
    if len(body_bytes) > max_bytes:
        return {
            "error": f"body too large ({len(body_bytes)} > {max_bytes})",
            "category": "content_too_large",
        }
    # encoding は curl_cffi が Content-Type / chardet で自動判定。それでも decode 失敗なら latin-1 で
    try:
        body = response.text
    except UnicodeDecodeError:
        body = body_bytes.decode("latin-1", errors="replace")
    return {
        "status": response.status_code,
        "final_url": str(response.url),
        "content_type": response.headers.get("content-type") or response.headers.get("Content-Type") or "",
        "headers": dict(response.headers),
        "body": body,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="curl_cffi で URL を取得して JSON 出力")
    parser.add_argument("url", help="取得する URL (https のみ想定)")
    parser.add_argument(
        "--impersonate",
        default=DEFAULT_IMPERSONATE,
        help=f"impersonate target (default: {DEFAULT_IMPERSONATE})。chrome120 / firefox120 / safari17_0 等",
    )
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SEC)
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    args = parser.parse_args()

    if not args.url.startswith("https://"):
        json.dump({"error": "https only", "category": "invalid_url"}, sys.stdout)
        sys.exit(2)

    try:
        result = fetch(args.url, args.impersonate, args.timeout, args.max_bytes)
    except requests.errors.RequestsError as e:  # type: ignore[attr-defined]
        msg = str(e)
        category = "network"
        if "timeout" in msg.lower() or "timed out" in msg.lower():
            category = "timeout"
        elif "ssl" in msg.lower() or "tls" in msg.lower():
            category = "tls"
        json.dump({"error": msg, "category": category}, sys.stdout)
        sys.exit(3)
    except Exception as e:  # noqa: BLE001 — CLI として全例外を JSON 化したい
        json.dump({"error": f"{type(e).__name__}: {e}", "category": "other"}, sys.stdout)
        sys.exit(4)

    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
