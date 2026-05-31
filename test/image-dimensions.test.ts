/**
 * 画像ヘッダ寸法パーサ (`src/utils/image-dimensions.ts`) の単体テスト (phase19.1 followup)。
 *
 * google-drive プラグインが thumbnail の縦横比から player のアスペクト比を決めるために使う。
 * JPEG / PNG / GIF の最小ヘッダを手で組んで寸法抽出を検証する (横長 / 縦長 / 不正の各ケース)。
 */

import { describe, expect, test } from 'vitest';
import { getImageDimensions } from '@/utils/image-dimensions.js';

/** 最小 PNG (IHDR まで) を組み立てる。 */
function png(width: number, height: number): Buffer {
	const buf = Buffer.alloc(24);
	// signature
	buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	// IHDR length(4) + 'IHDR'(4) は offset 8..16、width/height は offset 16/20
	buf.write('IHDR', 12, 'ascii');
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	return buf;
}

/** 最小 GIF (logical screen descriptor まで) を組み立てる。 */
function gif(width: number, height: number): Buffer {
	const buf = Buffer.alloc(24);
	buf.write('GIF89a', 0, 'ascii');
	buf.writeUInt16LE(width, 6);
	buf.writeUInt16LE(height, 8);
	return buf;
}

/** 最小 JPEG (SOI + SOF0 セグメント) を組み立てる。 */
function jpeg(width: number, height: number): Buffer {
	// SOI(2) + SOF0 marker(2) + length(2) + precision(1) + height(2) + width(2) + components(1)
	const buf = Buffer.alloc(24);
	buf.set([0xff, 0xd8], 0);          // SOI
	buf.set([0xff, 0xc0], 2);          // SOF0
	buf.writeUInt16BE(17, 4);          // segment length
	buf[6] = 8;                        // precision
	buf.writeUInt16BE(height, 7);
	buf.writeUInt16BE(width, 9);
	return buf;
}

/** WebP VP8X (extended) を組み立てる。width/height は (値-1) を 24bit LE で格納。 */
function webpVp8x(width: number, height: number): Buffer {
	const buf = Buffer.alloc(30);
	buf.write('RIFF', 0, 'ascii');
	buf.write('WEBP', 8, 'ascii');
	buf.write('VP8X', 12, 'ascii');
	const w = width - 1, h = height - 1;
	buf[24] = w & 0xff; buf[25] = (w >> 8) & 0xff; buf[26] = (w >> 16) & 0xff;
	buf[27] = h & 0xff; buf[28] = (h >> 8) & 0xff; buf[29] = (h >> 16) & 0xff;
	return buf;
}

/** WebP VP8L (lossless) を組み立てる。offset 21 から 14bit width / 14bit height (1 origin)。 */
function webpVp8l(width: number, height: number): Buffer {
	const buf = Buffer.alloc(25);
	buf.write('RIFF', 0, 'ascii');
	buf.write('WEBP', 8, 'ascii');
	buf.write('VP8L', 12, 'ascii');
	buf[20] = 0x2f;  // signature byte
	const w = width - 1, h = height - 1;
	// b0 = width 下位 8bit、b1 下位 6bit = width 上位 6bit、b1 上位 2bit = height 下位 2bit ...
	buf[21] = w & 0xff;
	buf[22] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
	buf[23] = (h >> 2) & 0xff;
	buf[24] = (h >> 10) & 0x0f;
	return buf;
}

/** WebP VP8 (lossy) を組み立てる。offset 26/28 に 14bit width/height (LE)。 */
function webpVp8(width: number, height: number): Buffer {
	const buf = Buffer.alloc(30);
	buf.write('RIFF', 0, 'ascii');
	buf.write('WEBP', 8, 'ascii');
	buf.write('VP8 ', 12, 'ascii');
	buf.writeUInt16LE(width & 0x3fff, 26);
	buf.writeUInt16LE(height & 0x3fff, 28);
	return buf;
}

describe('getImageDimensions', () => {
	test('PNG の横長 / 縦長を読み取る', () => {
		expect(getImageDimensions(png(1000, 562))).toEqual({ width: 1000, height: 562 });
		expect(getImageDimensions(png(1000, 1778))).toEqual({ width: 1000, height: 1778 });
	});

	test('JPEG の横長 / 縦長を読み取る (Drive thumbnail は JPEG)', () => {
		const landscape = getImageDimensions(jpeg(1000, 562));
		expect(landscape).toEqual({ width: 1000, height: 562 });
		expect(landscape!.height < landscape!.width).toBe(true);  // 横長

		const portrait = getImageDimensions(jpeg(1000, 1778));
		expect(portrait).toEqual({ width: 1000, height: 1778 });
		expect(portrait!.height > portrait!.width).toBe(true);    // 縦長
	});

	test('GIF の寸法 (little-endian) を読み取る', () => {
		expect(getImageDimensions(gif(640, 480))).toEqual({ width: 640, height: 480 });
	});

	test('WebP VP8X (extended) の横長 / 縦長を読み取る', () => {
		expect(getImageDimensions(webpVp8x(1000, 562))).toEqual({ width: 1000, height: 562 });
		expect(getImageDimensions(webpVp8x(1000, 1778))).toEqual({ width: 1000, height: 1778 });
	});

	test('WebP VP8L (lossless) の bit-interleaved 寸法を読み取る', () => {
		expect(getImageDimensions(webpVp8l(1000, 562))).toEqual({ width: 1000, height: 562 });
		expect(getImageDimensions(webpVp8l(1000, 1778))).toEqual({ width: 1000, height: 1778 });
		expect(getImageDimensions(webpVp8l(1, 1))).toEqual({ width: 1, height: 1 });  // 1 origin 境界
	});

	test('WebP VP8 (lossy) の寸法を読み取る', () => {
		expect(getImageDimensions(webpVp8(640, 480))).toEqual({ width: 640, height: 480 });
	});

	test('Uint8Array (Buffer でない) を渡しても読める (got の rawBody 形式)', () => {
		const b = png(800, 600);
		const u8 = new Uint8Array(b);  // Buffer メソッドを持たない素の Uint8Array
		expect(getImageDimensions(u8)).toEqual({ width: 800, height: 600 });
	});

	test('短すぎる / 未対応フォーマット / 破損ヘッダは null', () => {
		expect(getImageDimensions(Buffer.alloc(8))).toBeNull();                 // 24 byte 未満
		expect(getImageDimensions(Buffer.alloc(24))).toBeNull();               // 全 0 (シグネチャ無し)
		expect(getImageDimensions(Buffer.from('not an image header........'))).toBeNull();
	});
});
