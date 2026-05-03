import * as iconv from 'iconv-lite';
import jschardet from 'jschardet';
import Encoding from 'encoding-japanese';

const regCharset = new RegExp(/charset\s*=\s*["']?([\w-]+)/, 'i');

/**
 * HTML のエンコーディングを検出する。
 * 優先順位: jschardet（confidence >= 0.99）→ <meta charset> → utf-8
 *
 * 参考: misskey-dev/summaly#39 — chardet では ISO-2022-JP 等の検出精度が低かったため
 * jschardet と併用、ISO-2022-JP 専用に encoding-japanese を使う。
 */
export function detectEncoding(body: Uint8Array): string {
	const buf = body instanceof Buffer ? body : Buffer.from(body);

	// jschardet による検出（誤検出を抑制するため confidence >= 0.99 のみ採用）
	const detected = jschardet.detect(buf, { minimumThreshold: 0.99 });
	if (detected.encoding) {
		const encoding = toEncoding(detected.encoding);
		if (encoding != null) return encoding;
	}

	// <meta charset="..."> パース
	const matchMeta = buf.toString('latin1').match(regCharset);
	if (matchMeta) {
		const encoding = toEncoding(matchMeta[1]);
		if (encoding != null) return encoding;
	}

	return 'utf-8';
}

/**
 * 検出済みエンコーディングで body を UTF-8 文字列に変換する。
 * ISO-2022-JP のみ encoding-japanese を経由（iconv-lite が ISO-2022-JP を未サポートのため）。
 */
export function toUtf8(body: Uint8Array, encoding: string): string {
	if (encoding.toLowerCase() === 'iso-2022-jp') {
		const buf = body instanceof Buffer ? body : Buffer.from(body);
		const arr = Encoding.convert(Array.from(buf), {
			from: 'JIS',
			to: 'UNICODE',
			type: 'array',
		});
		return Encoding.codeToString(arr);
	}
	return iconv.decode(body, encoding);
}

function toEncoding(candidate: string): string | null {
	const lower = candidate.toLowerCase();
	// Shift-JIS 系の正規化
	if (['shift_jis', 'shift-jis', 'sjis', 'windows-31j', 'x-sjis'].includes(lower)) return 'cp932';
	// ISO-2022-JP は iconv-lite が未対応なので、toUtf8 側で encoding-japanese に分岐するためそのまま返す
	if (lower === 'iso-2022-jp') return 'iso-2022-jp';
	if (iconv.encodingExists(candidate)) return candidate;
	return null;
}
