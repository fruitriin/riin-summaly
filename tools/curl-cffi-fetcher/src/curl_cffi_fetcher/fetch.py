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
import ipaddress
import json
import os
import socket
import sys
from typing import Any
from urllib.parse import urlparse

try:
    from curl_cffi import requests  # type: ignore[import-not-found]
except ImportError as e:
    json.dump({"error": f"curl_cffi import failed: {e}", "category": "setup"}, sys.stdout)
    sys.exit(1)


DEFAULT_IMPERSONATE = "chrome120"
DEFAULT_TIMEOUT_SEC = 20.0
# OGP 取得目的なので 5 MiB で十分。これ以上は商品ページとしても異常
DEFAULT_MAX_BYTES = 5 * 1024 * 1024


def _is_public_ip(ip_str: str) -> bool:
    """IP が public unicast かを判定 (private / loopback / link-local / multicast / reserved を拒否)。

    Node 側 got.ts の `ipaddr.js` `range() === 'unicast'` 判定と意味的に一致させる。
    `is_global` は IPv4-mapped IPv6 等の corner case で `False` になる可能性があるため、
    個別の `is_*` フラグを or で繋いで「public でない条件」を網羅する。
    """
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    if ip.is_private:
        return False
    if ip.is_loopback:
        return False
    if ip.is_link_local:
        return False
    if ip.is_multicast:
        return False
    if ip.is_reserved:
        return False
    if ip.is_unspecified:
        return False
    # IPv6 の IPv4-mapped (::ffff:127.0.0.1 等) は IPv4 に展開して再評価
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return _is_public_ip(str(ip.ipv4_mapped))
    return True


def assert_public_ip(url: str) -> None:
    """URL のホストを名前解決し、すべての結果が public unicast でなければ PermissionError を送出。

    SSRF 防御。phase18 で `[scraping.curl_cffi].domains` allowlist 効力低下に伴い、
    Node 側 got.ts の SSRF ガード (private IP rejection) と同等の防御を curl_cffi 経路でも提供する。

    `SUMMALY_ALLOW_PRIVATE_IP=true` の環境変数でバイパス可能 (Node 側既存仕様と一致、テスト用)。

    NOTE (セキュリティ・TOCTOU 構造的限界):
    `getaddrinfo` → `requests.get` の間に DNS TTL 経過で IP が変わる DNS rebinding 攻撃が
    原理上成立する。redirect 後の最終 URL は本関数で再検証しているが、redirect 中の per-hop 検証は
    curl_cffi の API 制約 (Python レイヤに per-redirect callback 公開なし) で実装困難。
    完全な per-connection 検証には curl の `CURLOPT_OPENSOCKETFUNCTION` 相当のフックが必要。
    許容リスク: 個人運用 Misskey 相当の脅威モデルでは攻撃者が DNS を制御している前提が
    現実的でないため、現状の防御で十分と判断。
    """
    if os.environ.get("SUMMALY_ALLOW_PRIVATE_IP", "").lower() == "true":
        return
    host = urlparse(url).hostname
    if host is None or host == "":
        raise PermissionError("invalid URL: no hostname")
    # 既に IP 表記なら getaddrinfo を経由せず直接判定 (DNS rebinding の回避にも有用)
    try:
        ipaddress.ip_address(host)
        if not _is_public_ip(host):
            raise PermissionError(f"private IP rejected: {host}")
        return
    except ValueError:
        pass
    # 名前解決して全 result を判定。1 つでも private/loopback 等があれば拒否 (DNS rebinding 防御)
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise PermissionError(f"DNS resolution failed for {host}: {e}") from e
    if not infos:
        raise PermissionError(f"DNS resolution returned no results for {host}")
    for af, _socktype, _proto, _canon, sockaddr in infos:
        ip_str = sockaddr[0]
        if not _is_public_ip(ip_str):
            raise PermissionError(f"private IP rejected: {host} resolved to {ip_str}")


def fetch(
    url: str,
    impersonate: str,
    timeout: float,
    max_bytes: int,
    extra_headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    """curl_cffi で URL を取得して dict を返す。例外は呼び出し側でハンドル。

    `extra_headers` は impersonate が生成するブラウザ風ヘッダを **個別に上書き** する用途。
    特に `Accept: application/json` 等の API 取得時のコンテンツネゴシエーション制御に必須
    (impersonate デフォルトの `Accept: text/html,...` だとサーバが HTML / XHTML を返してしまう)。

    SSRF 防御: 取得前に名前解決して private IP 等を拒否 (`assert_public_ip`)。
    redirect 後の最終 URL についても再検証 (DNS rebinding / open redirect → SSRF 防御)。
    """
    assert_public_ip(url)
    response = requests.get(
        url,
        impersonate=impersonate,  # type: ignore[arg-type]
        timeout=timeout,
        allow_redirects=True,
        max_redirects=5,
        headers=extra_headers or None,
    )
    # redirect 後の最終 URL を再検証 (open redirect → private IP への迂回攻撃を防ぐ)
    final_url = str(response.url)
    if final_url != url:
        assert_public_ip(final_url)
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
    parser.add_argument(
        "--header",
        action="append",
        default=[],
        metavar="NAME:VALUE",
        help="追加 / 上書きヘッダを `Name:Value` 形式で指定 (反復可)。"
        "impersonate が生成するブラウザ風ヘッダを上書きする用途。"
        "例: --header 'Accept:application/json' --header 'X-Custom:foo'",
    )
    args = parser.parse_args()

    if not args.url.startswith("https://"):
        json.dump({"error": "https only", "category": "invalid_url"}, sys.stdout)
        sys.exit(2)

    extra_headers: dict[str, str] = {}
    for raw in args.header:
        if ":" not in raw:
            json.dump(
                {"error": f"invalid --header format (expected NAME:VALUE): {raw!r}", "category": "invalid_url"},
                sys.stdout,
            )
            sys.exit(2)
        name, _, value = raw.partition(":")
        # 空 name は意味が無く curl_cffi 側で例外になる可能性。早期にここで弾く
        if name.strip() == "":
            json.dump({"error": f"empty header name in --header: {raw!r}", "category": "invalid_url"}, sys.stdout)
            sys.exit(2)
        extra_headers[name.strip()] = value.strip()

    try:
        result = fetch(args.url, args.impersonate, args.timeout, args.max_bytes, extra_headers)
    except PermissionError as e:
        # SSRF ガードによる拒否。Node 側 `categorizeError` で `ssrf_blocked` に分類されるよう
        # category を `ssrf_blocked` で返す
        json.dump({"error": str(e), "category": "ssrf_blocked"}, sys.stdout)
        sys.exit(5)
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
