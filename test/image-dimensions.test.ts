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

// =============================================================================
// 敵対的カバレッジテスト アウトライン (phase19.1 followup, H-3 / H-5 / M-5)
//
// 各テストの構成: 「想定シナリオ (誰がどう引き起こすか) / メジャーケース / 実害カテゴリ」
// 実害カテゴリ凡例:
//   [DoS]            … fastify worker の CPU 100% 張り付き or OOM、サービス停止
//   [UX 劣化]        … クラッシュしないが Misskey 側の表示が破綻 (寸法異常 / iframe 崩壊)
//   [機能劣化]       … サイレント degrade で本来取れる情報が取れない (運用者気付かず)
//   [フィッシング]   … 攻撃者が能動的に作る誘導、Misskey 受信者の credential 等を狙う
//   [将来の温床]     … 現状経路では発火しないが、関数再利用 / 仕様変更で踏む
//   [退行防止]       … 現実装は健全、リファクタ時の退行を catch する目的
// =============================================================================

describe('getImageDimensions: 敵対的カバレッジ (H-3 上限チェック)', () => {
	test.fails('PNG width=0xFFFFFFFF は null を返す (上限チェック)', () => {
		// 想定: Drive 正規 thumbnail エンドポイントは Google が生成するため 4G px は降ってこない。
		//       ただし getImageDimensions は phase19.1 で新規 export された汎用 utility で、将来
		//       phase11.7 favicon fallback / 別プラグインの og:image 寸法判定で再利用される可能性。
		// メジャーケース: 攻撃者が自前ホストの PNG (IHDR を手書きで width=4294967295) を og:image に
		//                 仕込み、Misskey 経由 summaly 汎用パスで preview させる。
		// 実害: [将来の温床] + [UX 劣化] — Misskey クライアントが iframe width 属性に整数文字列で埋める
		//       実装の場合、Chromium の最大 iframe サイズ (約 16M px) を超えてレンダリング破綻 or
		//       padding-bottom 計算で異常な縦比率の iframe を生成しタイムライン崩壊。直接の RCE/DoS
		//       にはならないが、構造的に「上限なしで信頼するな」の防衛が必須。
		expect.fail('未実装: getImageDimensions に MAX_DIM (例: 32767) 上限を追加');
	});

	test.fails('PNG height=0xFFFFFFFF は null を返す (上限チェック)', () => {
		// 同上 (height 側)。1×4G のような極端比は applyMeta 経由で player.height=4G に伝搬し、
		// Misskey の `padding-bottom = (height/width)*100%` が 4 億 % という値になる。
		// 実害: [将来の温床] + [UX 劣化]
		expect.fail('未実装: MAX_DIM 上限 (height 側)');
	});

	test.fails('PNG width > MAX_DIM (例: 100001) は null を返す', () => {
		// 境界値テスト。32767 (signed short max) or 100000 (実用上限) のどちらを採るかは実装判断。
		// 実害: [退行防止]
		expect.fail('未実装: MAX_DIM 上限の境界値');
	});

	test.fails('GIF width=0xFFFF / height=0xFFFF は null を返す (上限チェック)', () => {
		// GIF は 16bit 寸法なので最大 65535×65535 = 約 43 億 pixel。論理 GIF として正規仕様内だが
		// Misskey iframe に渡すと実用上破綻する寸法。
		// メジャーケース: 攻撃者が "65535×65535" の logical screen を持つ偽 GIF を返す。実画像データ
		//                 は不要 (ヘッダ 24 byte で寸法判定が終わるので 24 byte body で発火可能)。
		// 実害: [UX 劣化] + [将来の温床]
		expect.fail('未実装: GIF にも MAX_DIM 上限を適用');
	});

	test.fails('WebP VP8X 24bit 最大値 (0xFFFFFF + 1 ≈ 16.7M) は null を返す (上限チェック)', () => {
		// VP8X は 24bit 寸法 (値-1 格納) で最大 16,777,216。同様に Misskey 側で破綻する寸法。
		// 実害: [UX 劣化] + [将来の温床]
		expect.fail('未実装: WebP VP8X にも MAX_DIM 上限');
	});
});

describe('getImageDimensions: 敵対的カバレッジ (H-5 magic 検証)', () => {
	test.fails('GIF magic は 6 byte 検証する (GIF87a / GIF89a 以外は null)', () => {
		// 現状実装は 3 byte ("GIF") のみ検証で "GIFXYZ" / "GIFABC" の偽 magic が通る。
		// 想定シナリオ:
		//   1. 攻撃者制御サーバが Content-Type: image/png + 先頭 "GIFXYZ" + 偽 16bit 寸法を返す。
		//   2. typeFilter は image/* で通過 (M-2 の修正後でも image/png は通る)。
		//   3. パーサがコード順 (PNG → GIF → WebP → JPEG) で GIF 判定にヒットし偽寸法を返す。
		// メジャーケース: 自然発生はほぼゼロ (実画像は必ず GIF87a/89a で始まる)。攻撃 PoC 専用。
		// 実害: [UX 劣化] + [将来の温床] — 仕様逸脱パーサは将来別フォーマット追加時に
		//       「シグネチャ judgment の順序依存バグ」を生む土壌になる。
		expect.fail('未実装: GIF magic を 6 byte 厳密検証 (GIF87a / GIF89a のみ許可)');
	});

	test.fails('GIF87a は受け入れる (互換性確認)', () => {
		// GIF magic 6 byte 化したときに既存の正規 GIF87a を間違って reject しないことを確認。
		// 実害: [退行防止]
		expect.fail('GIF magic 6 byte 検証 修正後に有効化');
	});

	test.fails('GIF89a は受け入れる (互換性確認)', () => {
		// 同上。一般的な GIF はほぼ 89a。
		// 実害: [退行防止]
		expect.fail('GIF magic 6 byte 検証 修正後に有効化');
	});

	test.fails('"GIFXYZ" のような偽 magic は null を返す', () => {
		// H-5 magic 検証のネガティブ確認。
		// 実害: [退行防止]
		expect.fail('未実装: GIF magic 6 byte 検証');
	});
});

describe('getImageDimensions: 敵対的カバレッジ (H-5 width=0 / height=0)', () => {
	test.fails('width=0 を持つ PNG は null', () => {
		// 想定: 自然発生はゼロ (実 PNG エンコーダは width=0 を出さない)。攻撃者が PoC で送る。
		// 現実装は `width > 0 && height > 0` ガード済なので null を返す。これはテスト未確認。
		// 退行で width=0 を素通しさせると:
		//   - applyMeta が player.width=0 を書き込む
		//   - Misskey 側 `height / width` 計算が Infinity (divide by zero) になる
		//   - iframe 幅 0px でユーザ体感は「プレビュー欄が空白」
		// 実害: [退行防止] + [UX 劣化リスク]
		expect.fail('退行防止テスト未追加 — width=0 が null 返却される回帰テスト');
	});

	test.fails('height=0 を持つ PNG は null', () => {
		// 同上 (divide by zero の被害者側)。
		// 実害: [退行防止]
		expect.fail('退行防止テスト未追加');
	});

	test.fails('width=0 を持つ JPEG は null', () => {
		// JPEG は SOFn の width=0 を仕様上禁止していないが実装上は無効値。
		// 実害: [退行防止]
		expect.fail('退行防止テスト未追加');
	});

	test.fails('height=0 を持つ WebP VP8X は null', () => {
		// 実害: [退行防止]
		expect.fail('退行防止テスト未追加');
	});
});

describe('getImageDimensions: 敵対的カバレッジ (H-5 truncated buffer)', () => {
	test.fails('SOFn の前で切れた truncated JPEG (SOI + APP0 のみ) は null', () => {
		// 想定シナリオ: 自然発生する。CDN 切断 / ネットワーク途中切断 / Drive thumbnail が
		//                生成途中の応答 / contentLengthLimit (2MiB) で打ち切られた場合。
		// メジャーケース: Drive 正規経路でも CDN 不調時に発生する可能性あり。
		// 現実装は while ループ条件 `offset + 9 < len` で SOFn 到達前に脱出 → null 返却 → 健全。
		// 退行で OOB read を許せば Buffer.read*BE が RangeError throw → 一段上の catch で null。
		// 実害: [退行防止]。退行しても catch があるので最終的に graceful degrade。
		expect.fail('退行防止テスト未追加');
	});

	test.fails('JPEG segLen=0 を持つセグメントは null (異常 length)', () => {
		// 想定シナリオ: 攻撃者が手書き JPEG で segLen=0 を仕込む。
		// 現実装は `segLen < 2` で reject → null 返却 → 健全。
		// 退行で segLen=0 を許せば offset += 2 + 0 = +2 (前進 2 byte) で次イテレーション。
		// 状況次第で **無限ループ or 異常に長い iteration** → fastify worker の CPU 100% 張り付き
		// → 同 worker のリクエスト全滞留 → **実質 DoS**。
		// 実害: [退行防止 / DoS リスク]
		expect.fail('退行防止テスト未追加 — segLen=0 を許すと DoS の可能性');
	});

	test.fails('JPEG segLen=1 を持つセグメントは null (異常 length)', () => {
		// segLen=1 は仕様外。実装は `< 2` で reject 健全。
		// 退行で許すと segLen=1 を含むセグメントで offset += 3 → 数 KB の iteration。
		// 実害: [退行防止 / DoS リスク (弱)]
		expect.fail('退行防止テスト未追加');
	});

	test.fails('JPEG segLen=0xFFFF で buf 末尾を超えるセグメントは null', () => {
		// 想定: 攻撃者が末端付近に segLen=0xFFFF を埋めて巨大 jump を要求。
		// 現実装は次イテレーションで `offset + 9 < len` が false になり脱出 → null。
		// 退行で OOB read → RangeError throw → 一段上 catch で null。
		// 実害: [退行防止]
		expect.fail('退行防止テスト未追加');
	});

	test.fails('100 個の APP0 segment 連続 + 末尾 EOI (SOFn なし) は null', () => {
		// 想定: 攻撃者が手書き JPEG で APP0 (FFE0) を 100 個並べる。各セグメントは min 4 byte。
		// 100 × 4 = 400 byte で 100 iteration → SOFn 見つからず脱出 → null。
		// 現実装は offset 単調増加保証で **無限ループしない**。これはテスト未確認。
		// 退行で offset 前進保証が壊れたら → **無限ループ / CPU 100% / fastify worker 死亡** → DoS。
		// メジャーケース: 攻撃 PoC 専用。自然発生はゼロ。
		// 実害: [退行防止 / DoS リスク (高)]
		expect.fail('退行防止テスト未追加 — offset 単調増加保証の退行で DoS');
	});

	test.fails('truncated PNG (IHDR の途中で切れる) は null', () => {
		// 想定: CDN 切断 / 部分 download。現実装は `buf.length < 24` ガード健全。
		// 退行で OOB read → RangeError throw → catch で null。
		// 実害: [退行防止]
		expect.fail('退行防止テスト未追加');
	});

	test.fails('truncated WebP (RIFF ヘッダのみ) は null', () => {
		// 同上。RIFF + WEBP + VP8/VP8L/VP8X chunk が無い不完全 WebP。
		// 現実装は length チェックで null 返却健全。退行で OOB read → catch で null。
		// 実害: [退行防止]
		expect.fail('退行防止テスト未追加');
	});
});

describe('getImageDimensions: 敵対的カバレッジ (M-5 JPEG 0xFF padding)', () => {
	test.fails('SOFn 直前に 0xFF padding が複数ある正規 JPEG (ISO/IEC 10918-1 B.1.1.2) を正しく読む', () => {
		// 想定シナリオ: JPEG 規格 B.1.1.2 で「マーカー直前に 0xFF padding を複数置ける」と
		//                明記されている。スキャナ・古い JPEG エンコーダ・Photoshop の特定設定で
		//                **正規仕様の JPEG が padding 付きで生成される**ことがある。
		// メジャーケース: 自然発生する。Drive にアップロードされた古い JPEG が thumbnail として
		//                 降ってきた瞬間、寸法判定が失敗。
		// 現実装は padding 0xFF をマーカーとして誤読 → segLen 解釈ミス → SOFn 見落とし → null。
		// 実害: [機能劣化] — 該当 JPEG の縦動画 / 縦長コンテンツが常に 16:9 横長表示にデグレ。
		//                  サイレントなのでユーザが「縦動画が横長になる」と気付いても summaly
		//                  運用者がログから原因特定できない (H-4 サイレント catch と複合)。
		expect.fail('未実装: padding 0xFF スキップロジックを readJpegDimensions に追加');
	});
});

describe('getImageDimensions: 敵対的カバレッジ (WebP lossy 縦長)', () => {
	test.fails('WebP VP8 lossy の縦長 (562x1000) を読み取る (一貫性テスト)', () => {
		// 想定: 既存テストで VP8L / VP8X は横長 / 縦長 / 境界 (1x1) すべてカバー、
		//        VP8 lossy だけ 640x480 横長の 1 ケースしかない。フォーマット間カバレッジの不一致。
		// メジャーケース: Drive thumbnail は基本 JPEG 出力なので VP8 lossy はまず降らないが、
		//                 Drive 仕様変更で WebP 出力に切替わる可能性ゼロではない。
		// 実害: [退行防止] — VP8 lossy の縦長パスを書いて他フォーマットと整合させる。
		expect.fail('カバレッジ拡充 — VP8 lossy 縦長のアサーション追加');
	});
});
