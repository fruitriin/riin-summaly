/**
 * 画像バイナリの先頭バイトから pixel 幅・高さを読み取る最小パーサ。
 *
 * 外部依存 (`image-size` 等) を増やさずに JPEG / PNG / GIF / WebP のヘッダだけから
 * 寸法を取得する。**完全な画像をデコードしない** (ヘッダのみ参照) ため、数十 KB の先頭
 * チャンクがあれば足りる。google-drive プラグインが thumbnail の orientation (縦 / 横) を
 * 判定して player のアスペクト比を決めるために使う (phase19.1)。
 *
 * 対応外フォーマットや破損ヘッダでは `null` を返す (呼び元は fallback アスペクト比を使う)。
 *
 * **防御 (PR #2 review)**: (1) width/height は `MAX_DIM` (32767) を超えたら null (異常寸法の伝搬防止)。
 * (2) GIF magic は 6 byte 厳密検証 (`GIF87a`/`GIF89a` のみ、偽 magic を弾く)。(3) 各フォーマットで
 * width/height=0 は null。(4) JPEG segment 走査は offset 単調増加 + `segLen < 2` reject + `offset+9<len`
 * 境界で **無限ループ / OOB read しない** (truncated / 異常 segLen でも graceful に null)。
 */

export interface ImageDimensions {
	width: number;
	height: number;
}

/**
 * 受け入れる pixel 寸法の上限 (これを超える width / height は無効値として null を返す)。
 *
 * **背景 (PR #2 review, must)**: 各フォーマットのヘッダは巨大寸法を表現できる
 * (PNG/JPEG は 16/32bit、GIF は 16bit で最大 65535、WebP VP8X は 24bit で最大 16,777,216)。
 * 攻撃者が手書きヘッダで `width=4294967295` 等を仕込むと、`applyMeta` 経由で `player.width/height`
 * にそのまま伝搬し、Misskey の `padding-bottom = (height/width)*100%` が異常値になって
 * **タイムラインの iframe レイアウトが破綻**する (UX 劣化)。本パーサは **寸法をサーブせず
 * アスペクト比 (orientation) 判定にのみ使う**ため、上限を超えたら「判定不能」として null を返し、
 * 呼び元 (google-drive) を安全な 16:9 fallback に落とすのが正しい防御 (ffmpeg 等での縮小は不要 —
 * 画像本体は summaly が中継しないため)。
 *
 * **32767 (signed short max)**: 実在する画像・動画サムネはこれを超えない (8K 動画でも 7680px)。
 * Misskey の表示でもビューポートを超える寸法は意味を成さないため、実用上十分な常識的上限。
 */
const MAX_DIM = 32767;

/** width / height が両方 1〜MAX_DIM の常識的範囲なら寸法を返す。範囲外は null (= 判定不能扱い)。 */
function dims(width: number, height: number): ImageDimensions | null {
	if (width > 0 && height > 0 && width <= MAX_DIM && height <= MAX_DIM) return { width, height };
	return null;
}

/**
 * 画像バイナリ (Buffer / Uint8Array) からピクセル寸法を抽出する。判定不能なら null。
 *
 * `got` の `rawBody` は `Uint8Array` で返るため `Buffer.from` で wrap して Buffer のヘルパ
 * (`readUInt16BE` 等) を使えるようにする。`Buffer.from(uint8array)` はコピーせず view を共有する。
 *
 * **寸法上限**: width / height が `MAX_DIM` (32767) を超える場合は null を返す (PR #2 review, must)。
 */
export function getImageDimensions(input: Uint8Array): ImageDimensions | null {
	const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
	if (buf.length < 24) return null;

	// PNG: 8 byte signature + IHDR chunk (width/height は offset 16/20 の big-endian uint32)
	if (
		buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
		buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
	) {
		const width = buf.readUInt32BE(16);
		const height = buf.readUInt32BE(20);
		return dims(width, height);
	}

	// GIF: magic は **6 byte 厳密検証** ("GIF87a" / "GIF89a" のみ。"GIFXYZ" 等の偽 magic を弾く、
	// PR #2 review H-5)。width/height は offset 6/8 の little-endian uint16
	if (
		buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && // "GIF"
		buf[3] === 0x38 && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61 // "8" + ("7"|"9") + "a"
	) {
		const width = buf.readUInt16LE(6);
		const height = buf.readUInt16LE(8);
		return dims(width, height);
	}

	// WebP: "RIFF"...."WEBP" — VP8 / VP8L / VP8X の 3 バリアントで寸法位置が異なる
	if (
		buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
		buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
	) {
		return readWebpDimensions(buf);
	}

	// JPEG: SOI (0xFFD8) で始まり、SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15 マーカーに寸法
	if (buf[0] === 0xff && buf[1] === 0xd8) {
		return readJpegDimensions(buf);
	}

	return null;
}

function readWebpDimensions(buf: Buffer): ImageDimensions | null {
	// 'VP8 ' (lossy), 'VP8L' (lossless), 'VP8X' (extended) の format chunk が offset 12 から
	const format = buf.toString('ascii', 12, 16);
	if (format === 'VP8 ') {
		// lossy: frame tag の後 offset 26/28 に 14bit width/height (little-endian) + 1
		if (buf.length < 30) return null;
		const width = (buf.readUInt16LE(26) & 0x3fff);
		const height = (buf.readUInt16LE(28) & 0x3fff);
		return dims(width, height);
	}
	if (format === 'VP8L') {
		// lossless: offset 21 から 14bit width / 14bit height (1 origin)
		if (buf.length < 25) return null;
		const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
		const width = 1 + (((b1 & 0x3f) << 8) | b0);
		const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
		return dims(width, height);
	}
	if (format === 'VP8X') {
		// extended: offset 24 から 24bit width-1 / 24bit height-1 (little-endian)
		if (buf.length < 30) return null;
		const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
		const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
		return dims(width, height);
	}
	return null;
}

function readJpegDimensions(buf: Buffer): ImageDimensions | null {
	// SOI の後、segment を辿って SOFn マーカーの寸法フィールドを読む。
	let offset = 2;
	const len = buf.length;
	// SOFn の width は readUInt16BE(offset+7) で offset+8 まで触る。in-bounds 条件は offset+8 <= len-1
	// = offset+9 <= len。`offset+9 < len` だと width が buffer 末尾ぴったりに収まる JPEG を 1 周早く
	// 取りこぼす off-by-one になるため `<=` にする (PR #2 review)。
	while (offset + 9 <= len) {
		// マーカーは 0xFF で始まる。
		if (buf[offset] !== 0xff) {
			offset++;
			continue;
		}
		const marker = buf[offset + 1];
		// **0xFF padding スキップ (ISO/IEC 10918-1 B.1.1.2)**: マーカー直前に 0xFF を複数置ける。
		// `0xFF 0xFF ...` の場合、2 byte 目も 0xFF なら padding なので 1 byte だけ進めて
		// 「次の 0xFF + 真のマーカー」を読み直す。これが無いと padding を segLen 誤読して SOFn を見落とす。
		if (marker === 0xff) {
			offset++;
			continue;
		}
		// SOFn: 0xC0-0xC3, 0xC5-0xC7, 0xC9-0xCB, 0xCD-0xCF (DHT/JPG/DAC を除く)
		const isSof =
			(marker >= 0xc0 && marker <= 0xc3) ||
			(marker >= 0xc5 && marker <= 0xc7) ||
			(marker >= 0xc9 && marker <= 0xcb) ||
			(marker >= 0xcd && marker <= 0xcf);
		if (isSof) {
			// SOF segment: marker(2) + length(2) + precision(1) + height(2) + width(2)
			const height = buf.readUInt16BE(offset + 5);
			const width = buf.readUInt16BE(offset + 7);
			return dims(width, height);
		}
		// EOI (画像終端) に到達したら SOFn はもう現れない。早期打ち切り。
		if (marker === 0xd9) return null;
		// スタンドアロンマーカー (RSTn / SOI / TEM) は length を持たない
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
			offset += 2;
			continue;
		}
		// 通常 segment: 2 byte length (マーカー自身を含まない) で次へジャンプ
		const segLen = buf.readUInt16BE(offset + 2);
		if (segLen < 2) return null;
		offset += 2 + segLen;
	}
	return null;
}
