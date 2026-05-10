/**
 * summaly outbound proxy worker (phase12.1)。
 *
 * 役割:
 * 1. summaly から HMAC 認証付きで `?url=<encoded>` を受ける
 * 2. HMAC + タイムスタンプ + URL allowlist + HTTPS のみを検証
 * 3. 検証通過したら `fetch(target)` で取得して透過プロキシ
 *
 * **オープンプロキシ化を防ぐため、認証なしでは何も応答しない**。HMAC 検証失敗 / 期限切れ /
 * allowlist 外は全部 403 で返す（attacker に情報を与えない）。
 *
 * Free プラン上限: 100,000 req/day。超過時は 429 で停止する（金額課金は発生しない）。
 */

interface Env {
	SHARED_SECRET: string;
	MAX_BODY_BYTES: string;
	TIMESTAMP_WINDOW_MS: string;
	// **phase18.1 で `ALLOWED_DOMAINS` 撤廃**: HMAC + 5 分窓で十分な防御 (HMAC 認証通った時点で
	// secret を知る信頼できる呼出元と判定)。secret 漏洩時は rotation で対処、運用負担削減。
}

const FORBIDDEN_HEADERS = new Set([
	'host', 'connection', 'content-length', 'transfer-encoding',
]);

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// 1. メソッド: GET のみ
		if (request.method !== 'GET') {
			return forbidden('method not allowed');
		}

		// 2. クエリ抽出
		const reqUrl = new URL(request.url);
		const targetParam = reqUrl.searchParams.get('url');
		const sigHeader = request.headers.get('x-summaly-sig');
		const tsHeader = request.headers.get('x-summaly-ts');
		if (targetParam == null || sigHeader == null || tsHeader == null) {
			return forbidden('missing required parameters');
		}

		// 3. タイムスタンプ検証 (replay 対策)
		const ts = Number(tsHeader);
		if (!Number.isFinite(ts)) return forbidden('invalid timestamp');
		const windowMs = parseInt(env.TIMESTAMP_WINDOW_MS || '300000', 10);
		const now = Date.now();
		if (Math.abs(now - ts) > windowMs) {
			return forbidden('timestamp out of window');
		}

		// 4. HMAC 検証 (定数時間比較)
		const expected = await hmacSha256Hex(env.SHARED_SECRET, `${targetParam}\n${ts}`);
		if (!constantTimeEqual(expected, sigHeader)) {
			return forbidden('signature mismatch');
		}

		// 5. target URL 検証
		let target: URL;
		try {
			target = new URL(targetParam);
		} catch {
			return forbidden('invalid target url');
		}
		if (target.protocol !== 'https:') {
			return forbidden('https only');
		}
		// phase18.1: ALLOWED_DOMAINS 撤廃。HMAC + timestamp 窓で十分な防御 (secret を知る呼出元のみ通す)。

		// 6. forwarded UA を抽出（summaly 側が指定する）
		const forwardedUA = request.headers.get('x-summaly-forward-ua') ?? 'Mozilla/5.0 (compatible; SummalyProxy/1.0)';

		// 7. fetch して透過プロキシ
		// `accept-language` は固定値（呼び元の Node サーバの環境を Amazon 等に伝播させない）。
		// Amazon は Accept-Language で言語を切り替えるため、ここでは ja を優先してフォールバック英語。
		let upstream: Response;
		try {
			upstream = await fetch(target.href, {
				method: 'GET',
				headers: {
					'user-agent': forwardedUA,
					'accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
					'accept-language': 'ja,ja-JP;q=0.9,en-US;q=0.8,en;q=0.7',
				},
				redirect: 'follow',
				cf: {
					// Cloudflare 内部キャッシュは無効（summaly 側で LRU を持つため）
					cacheEverything: false,
					cacheTtl: 0,
				},
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'upstream fetch failed';
			return new Response(JSON.stringify({ error: 'upstream_fetch_error', message: msg }), {
				status: 502,
				headers: { 'content-type': 'application/json', 'x-summaly-proxy': '1' },
			});
		}

		// 7.5. リダイレクト後の最終 URL の protocol 再検証 (https 限定維持、phase18.1 で domain
		// allowlist は撤廃したが http への downgrade 防御は残す)。
		try {
			const finalUrl = new URL(upstream.url);
			if (finalUrl.protocol !== 'https:') {
				return forbidden('redirect to non-https');
			}
		} catch {
			return forbidden('invalid final url after redirect');
		}

		// 8. 受信ボディサイズ上限
		const maxBytes = parseInt(env.MAX_BODY_BYTES || '5242880', 10);
		const contentLength = upstream.headers.get('content-length');
		if (contentLength != null && Number(contentLength) > maxBytes) {
			return new Response(JSON.stringify({ error: 'body_too_large' }), {
				status: 502,
				headers: { 'content-type': 'application/json', 'x-summaly-proxy': '1' },
			});
		}

		// 9. body をバイト配列で取得（cap 内に収まるまで読む）
		const body = await readWithLimit(upstream, maxBytes);
		if (body == null) {
			return new Response(JSON.stringify({ error: 'body_too_large_during_stream' }), {
				status: 502,
				headers: { 'content-type': 'application/json', 'x-summaly-proxy': '1' },
			});
		}

		// 10. レスポンスヘッダを最小限フィルタして透過
		const respHeaders = new Headers();
		for (const [k, v] of upstream.headers) {
			if (FORBIDDEN_HEADERS.has(k.toLowerCase())) continue;
			respHeaders.set(k, v);
		}
		// summaly 側がリダイレクト解決後 URL を知るためのヘッダ
		respHeaders.set('x-summaly-final-url', upstream.url);
		respHeaders.set('x-summaly-proxy', '1');

		return new Response(body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: respHeaders,
		});
	},
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// helpers

function forbidden(reason: string): Response {
	// 理由は wrangler tail で運用者が見れるよう console.log に出す（W-2 対策）。
	// レスポンスボディには書かない（attacker に情報を与えない）。
	console.log('[forbidden]', reason);
	return new Response('forbidden', {
		status: 403,
		headers: { 'content-type': 'text/plain', 'x-summaly-proxy': '1' },
	});
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
	return [...new Uint8Array(sig)]
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * タイミング攻撃を防ぐ定数時間比較。
 * 長さの差を `diff` に織り込み、`max(a.length, b.length)` 回ループしてタイミングを均一化する。
 * 長さが違うときに early-return すると「64 文字を送ったときだけレイテンシが上がる」観測が可能になるため、
 * HMAC hex (常に 64 文字) であっても全ループ回す (C-2 対策)。
 */
function constantTimeEqual(a: string, b: string): boolean {
	const len = Math.max(a.length, b.length);
	let diff = a.length ^ b.length;
	for (let i = 0; i < len; i++) {
		const ca = i < a.length ? a.charCodeAt(i) : 0;
		const cb = i < b.length ? b.charCodeAt(i) : 0;
		diff |= ca ^ cb;
	}
	return diff === 0;
}

/**
 * upstream のボディを `maxBytes` までストリーミング読み取り。超えたら null を返す。
 * `Response.arrayBuffer()` は全部読むので事前 cap 不可、`getReader()` でチャンク累積する。
 */
async function readWithLimit(res: Response, maxBytes: number): Promise<Uint8Array | null> {
	if (res.body == null) return new Uint8Array(0);
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
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
