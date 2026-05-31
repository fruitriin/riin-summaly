/**
 * 画像バイナリの先頭バイトから pixel 幅・高さを読み取る最小パーサ。
 *
 * 外部依存 (`image-size` 等) を増やさずに JPEG / PNG / GIF / WebP のヘッダだけから
 * 寸法を取得する。**完全な画像をデコードしない** (ヘッダのみ参照) ため、数十 KB の先頭
 * チャンクがあれば足りる。google-drive プラグインが thumbnail の orientation (縦 / 横) を
 * 判定して player のアスペクト比を決めるために使う (phase19.1)。
 *
 * 対応外フォーマットや破損ヘッダでは `null` を返す (呼び元は fallback アスペクト比を使う)。
 */

export interface ImageDimensions {
	width: number;
	height: number;
}

/**
 * 画像バイナリ (Buffer / Uint8Array) からピクセル寸法を抽出する。判定不能なら null。
 *
 * `got` の `rawBody` は `Uint8Array` で返るため `Buffer.from` で wrap して Buffer のヘルパ
 * (`readUInt16BE` 等) を使えるようにする。`Buffer.from(uint8array)` はコピーせず view を共有する。
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
		if (width > 0 && height > 0) return { width, height };
		return null;
	}

	// GIF: "GIF87a" / "GIF89a" + width/height は offset 6/8 の little-endian uint16
	if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
		const width = buf.readUInt16LE(6);
		const height = buf.readUInt16LE(8);
		if (width > 0 && height > 0) return { width, height };
		return null;
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
		if (width > 0 && height > 0) return { width, height };
		return null;
	}
	if (format === 'VP8L') {
		// lossless: offset 21 から 14bit width / 14bit height (1 origin)
		if (buf.length < 25) return null;
		const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
		const width = 1 + (((b1 & 0x3f) << 8) | b0);
		const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
		if (width > 0 && height > 0) return { width, height };
		return null;
	}
	if (format === 'VP8X') {
		// extended: offset 24 から 24bit width-1 / 24bit height-1 (little-endian)
		if (buf.length < 30) return null;
		const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
		const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
		if (width > 0 && height > 0) return { width, height };
		return null;
	}
	return null;
}

function readJpegDimensions(buf: Buffer): ImageDimensions | null {
	// SOI の後、segment を辿って SOFn マーカーの寸法フィールドを読む。
	let offset = 2;
	const len = buf.length;
	while (offset + 9 < len) {
		// マーカーは 0xFF で始まる。padding (0xFF 連続) をスキップ。
		if (buf[offset] !== 0xff) {
			offset++;
			continue;
		}
		const marker = buf[offset + 1];
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
			if (width > 0 && height > 0) return { width, height };
			return null;
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
