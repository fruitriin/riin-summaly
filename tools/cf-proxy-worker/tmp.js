var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var FORBIDDEN_HEADERS = /* @__PURE__ */ new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding"
]);
var index_default = {
  async fetch(request, env) {
    if (request.method !== "GET") {
      return forbidden("method not allowed");
    }
    const reqUrl = new URL(request.url);
    const targetParam = reqUrl.searchParams.get("url");
    const sigHeader = request.headers.get("x-summaly-sig");
    const tsHeader = request.headers.get("x-summaly-ts");
   // if (targetParam == null || sigHeader == null || tsHeader == null) {
      // return forbidden("missing required parameters");
    // }
    const ts = Number(tsHeader);
    if (!Number.isFinite(ts)) return forbidden("invalid timestamp");
    const windowMs = parseInt(env.TIMESTAMP_WINDOW_MS || "300000", 10);
    const now = Date.now();
    // if (Math.abs(now - ts) > windowMs) {
    //   return forbidden("timestamp out of window");
    // }
    const expected = await hmacSha256Hex(env.SHARED_SECRET, `${targetParam}
${ts}`);
    // if (!constantTimeEqual(expected, sigHeader)) {
    //   return forbidden("signature mismatch");
    // }
    let target;
    try {
      target = new URL(targetParam);
    } catch {
      return forbidden("invalid target url");
    }
    if (target.protocol !== "https:") {
      return forbidden("https only");
    }
    if (!isAllowedDomain(target.hostname, env.ALLOWED_DOMAINS)) {
      return forbidden("domain not in allowlist");
    }
    const forwardedUA = request.headers.get("x-summaly-forward-ua") ?? "Mozilla/5.0 (compatible; SummalyProxy/1.0)";
    let upstream;
    try {
      upstream = await fetch(target.href, {
        method: "GET",
        headers: {
          "user-agent": forwardedUA,
          "accept": "text/html,application/xhtml+xml,*/*;q=0.8",
          "accept-language": "ja,ja-JP;q=0.9,en-US;q=0.8,en;q=0.7"
        },
        redirect: "follow",
        cf: {
          // Cloudflare 内部キャッシュは無効（summaly 側で LRU を持つため）
          cacheEverything: false,
          cacheTtl: 0
        }
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "upstream fetch failed";
      return new Response(JSON.stringify({ error: "upstream_fetch_error", message: msg }), {
        status: 502,
        headers: { "content-type": "application/json", "x-summaly-proxy": "1" }
      });
    }
    try {
      const finalUrl = new URL(upstream.url);
      if (finalUrl.protocol !== "https:") {
        return forbidden("redirect to non-https");
      }
      if (!isAllowedDomain(finalUrl.hostname, env.ALLOWED_DOMAINS)) {
        return forbidden("redirect led to non-allowlisted domain");
      }
    } catch {
      return forbidden("invalid final url after redirect");
    }
    const maxBytes = parseInt(env.MAX_BODY_BYTES || "5242880", 10);
    const contentLength = upstream.headers.get("content-length");
    if (contentLength != null && Number(contentLength) > maxBytes) {
      return new Response(JSON.stringify({ error: "body_too_large" }), {
        status: 502,
        headers: { "content-type": "application/json", "x-summaly-proxy": "1" }
      });
    }
    const body = await readWithLimit(upstream, maxBytes);
    if (body == null) {
      return new Response(JSON.stringify({ error: "body_too_large_during_stream" }), {
        status: 502,
        headers: { "content-type": "application/json", "x-summaly-proxy": "1" }
      });
    }
    const respHeaders = new Headers();
    for (const [k, v] of upstream.headers) {
      if (FORBIDDEN_HEADERS.has(k.toLowerCase())) continue;
      respHeaders.set(k, v);
    }
    respHeaders.set("x-summaly-final-url", upstream.url);
    respHeaders.set("x-summaly-proxy", "1");
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders
    });
  }
};
function forbidden(reason) {
  console.log("[forbidden]", reason);
  return new Response("forbidden", {
    status: 403,
    headers: { "content-type": "text/plain", "x-summaly-proxy": "1" }
  });
}
__name(forbidden, "forbidden");
async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hmacSha256Hex, "hmacSha256Hex");
function constantTimeEqual(a, b) {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}
__name(constantTimeEqual, "constantTimeEqual");
function isAllowedDomain(hostname, allowedCsv) {
  const lower = hostname.toLowerCase();
  const allowed = allowedCsv.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const d of allowed) {
    if (lower === d) return true;
    if (lower.endsWith("." + d)) return true;
  }
  return false;
}
__name(isAllowedDomain, "isAllowedDomain");
async function readWithLimit(res, maxBytes) {
  if (res.body == null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
__name(readWithLimit, "readWithLimit");
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
