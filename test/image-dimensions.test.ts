/**
 * 画像ヘッダ寸法パーサ (`src/utils/image-dimensions.ts`) の単体テスト (phase19.1 followup)。
 *
 * google-drive プラグインが thumbnail の縦横比から player のアスペクト比を決めるために使う。
 * JPEG / PNG / GIF の最小ヘッダを手で組んで寸法抽出を検証する (横長 / 縦長 / 不正の各ケース)。
 *
 * ファイル末尾に **敵対的カバレッジ** (PR #2 review fruitriin): 寸法上限 (MAX_DIM) / GIF magic 6 byte /
 * width=0 退行防止 / truncated・異常 segLen の無限ループ・OOB 防止 / JPEG 0xFF padding / VP8 lossy 縦長。
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

// =============================================================================
// 敵対的カバレッジ (PR #2 review, fruitriin の test.fails アウトラインを実装)
// =============================================================================

describe('getImageDimensions: 寸法上限 (MAX_DIM=32767, PR #2 review must)', () => {
	test('PNG width=0xFFFFFFFF / height=0xFFFFFFFF は null', () => {
		// 攻撃者が手書き PNG で 4G px を仕込む → 上限超過で null → 呼び元 16:9 fallback。
		expect(getImageDimensions(png(0xffffffff, 100))).toBeNull();
		expect(getImageDimensions(png(100, 0xffffffff))).toBeNull();
	});

	test('PNG width > MAX_DIM (例: 100001) は null、MAX_DIM ちょうどは通る', () => {
		expect(getImageDimensions(png(100001, 100))).toBeNull();
		expect(getImageDimensions(png(32767, 32767))).toEqual({ width: 32767, height: 32767 });
		expect(getImageDimensions(png(32768, 100))).toBeNull();  // 上限 +1
	});

	test('GIF width=0xFFFF / height=0xFFFF は null (16bit 最大も上限超過)', () => {
		expect(getImageDimensions(gif(0xffff, 0xffff))).toBeNull();
	});

	test('WebP VP8X の 24bit 大値は上限で null', () => {
		expect(getImageDimensions(webpVp8x(100000, 100))).toBeNull();
	});

	test('JPEG width/height が MAX_DIM 超は null', () => {
		// jpeg() は 16bit までしか書けないので 40000 で上限超過を再現 (40000 > 32767)。
		expect(getImageDimensions(jpeg(40000, 100))).toBeNull();
	});
});

describe('getImageDimensions: GIF magic 6 byte 厳密検証 (PR #2 review H-5)', () => {
	test('"GIFXYZ" のような偽 magic は null (3 byte "GIF" だけでは通さない)', () => {
		const fake = Buffer.alloc(24);
		fake.write('GIFXYZ', 0, 'ascii');
		fake.writeUInt16LE(640, 6);
		fake.writeUInt16LE(480, 8);
		expect(getImageDimensions(fake)).toBeNull();
	});

	test('GIF87a / GIF89a は受け入れる (互換性確認)', () => {
		const g87 = Buffer.alloc(24);
		g87.write('GIF87a', 0, 'ascii');
		g87.writeUInt16LE(640, 6); g87.writeUInt16LE(480, 8);
		expect(getImageDimensions(g87)).toEqual({ width: 640, height: 480 });
		// GIF89a は既存 gif() ヘルパが 89a
		expect(getImageDimensions(gif(320, 240))).toEqual({ width: 320, height: 240 });
	});
});

describe('getImageDimensions: width=0 / height=0 退行防止 (PR #2 review H-5)', () => {
	test('width=0 / height=0 を持つ PNG / JPEG / WebP は null (divide-by-zero 防止)', () => {
		expect(getImageDimensions(png(0, 100))).toBeNull();
		expect(getImageDimensions(png(100, 0))).toBeNull();
		expect(getImageDimensions(jpeg(0, 100))).toBeNull();
		// WebP VP8X は (値-1) 格納なので width=0 を表現するには内部 0xFFFFFF が必要 = 上限超過で別経路 null。
		// VP8 lossy で width=0 を再現 (14bit 値 0)。
		const vp8 = webpVp8(0, 100);
		expect(getImageDimensions(vp8)).toBeNull();
	});
});

describe('getImageDimensions: truncated / 異常 segment は無限ループ・OOB せず null (PR #2 review H-5 DoS)', () => {
	test('SOFn の前で切れた truncated JPEG (SOI + APP0 のみ) は null', () => {
		// SOI(FFD8) + APP0(FFE0) + segLen=16 だが body が無く途中で切れる
		const buf = Buffer.alloc(24);
		buf.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 0);  // 残りは 0 (SOFn 不在)
		expect(getImageDimensions(buf)).toBeNull();
	});

	test('JPEG segLen=0 / segLen=1 (異常 length) は null (前進せず無限ループしない)', () => {
		for (const segLen of [0, 1]) {
			const buf = Buffer.alloc(30);
			buf.set([0xff, 0xd8, 0xff, 0xe0], 0);  // SOI + APP0
			buf.writeUInt16BE(segLen, 4);          // 異常 segLen
			expect(getImageDimensions(buf)).toBeNull();
		}
	});

	test('100 個の APP0 連続 + SOFn なしでも有限ステップで null (offset 単調増加保証)', () => {
		// APP0 (FFE0) + segLen=4 (= マーカー後 2byte length のみ、body 2byte) を多数並べる
		const parts: number[] = [0xff, 0xd8];  // SOI
		for (let i = 0; i < 100; i++) parts.push(0xff, 0xe0, 0x00, 0x04, 0x00, 0x00);
		const buf = Buffer.from(parts);
		// 無限ループせず null が返れば OK (タイムアウトしない = offset 前進保証の退行防止)
		expect(getImageDimensions(buf)).toBeNull();
	});

	test('truncated PNG (24 byte 未満) / truncated WebP (RIFF のみ) は null', () => {
		expect(getImageDimensions(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull();
		const riff = Buffer.alloc(16);
		riff.write('RIFF', 0, 'ascii'); riff.write('WEBP', 8, 'ascii');  // VP8 chunk 無し
		expect(getImageDimensions(riff)).toBeNull();
	});
});

describe('getImageDimensions: JPEG 0xFF padding (PR #2 review M-5)', () => {
	test('SOFn 直前に 0xFF padding が複数ある正規 JPEG を正しく読む (ISO/IEC 10918-1 B.1.1.2)', () => {
		// SOI(FFD8) + 0xFF×3 padding + SOF0(FFC0) + segLen17 + precision8 + height + width + components1
		const w = 1000, h = 562;
		const buf = Buffer.alloc(30);
		let o = 0;
		buf.set([0xff, 0xd8], o); o += 2;        // SOI
		buf.set([0xff, 0xff, 0xff], o); o += 3;  // padding 0xFF×3
		buf.set([0xff, 0xc0], o); o += 2;        // SOF0
		buf.writeUInt16BE(17, o); o += 2;        // segLen
		buf[o] = 8; o += 1;                       // precision
		buf.writeUInt16BE(h, o); o += 2;
		buf.writeUInt16BE(w, o); o += 2;
		expect(getImageDimensions(buf)).toEqual({ width: w, height: h });
	});
});

describe('getImageDimensions: WebP VP8 lossy 縦長 (PR #2 review カバレッジ拡充)', () => {
	test('VP8 lossy の縦長 (562x1000) を読み取る', () => {
		const portrait = getImageDimensions(webpVp8(562, 1000));
		expect(portrait).toEqual({ width: 562, height: 1000 });
		expect(portrait!.height > portrait!.width).toBe(true);
	});
});
