/**
 * 小説家になろう API のジャンル ID マッピング。
 *
 * 出典: https://dev.syosetu.com/man/api/#param-bigjanru / https://dev.syosetu.com/man/api/#param-janru
 *
 * **保守ガイド**: なろう API のジャンル ID は基本的に変わらないが、新ジャンルが追加されたら手動で追記する。
 * 未知 ID で `getGenreName` / `getBigGenreName` が呼ばれた場合は `'その他'` フォールバックされる
 * (表示が壊れない設計、運用者がフォールバックの存在に気付いて追記すれば良い)。
 */

/** 大ジャンル (`biggenre` フィールド) の ID → 表示名 */
export const BIG_GENRE_NAMES: Readonly<Record<number, string>> = Object.freeze({
	1: '恋愛',
	2: 'ファンタジー',
	3: '文芸',
	4: 'SF',
	98: 'ノンジャンル',
	99: 'その他',
});

/** ジャンル (`genre` フィールド) の ID → 表示名 */
export const GENRE_NAMES: Readonly<Record<number, string>> = Object.freeze({
	// 恋愛
	101: '異世界〔恋愛〕',
	102: '現実世界〔恋愛〕',
	// ファンタジー
	201: 'ハイファンタジー〔ファンタジー〕',
	202: 'ローファンタジー〔ファンタジー〕',
	// 文芸
	301: '純文学〔文芸〕',
	302: 'ヒューマンドラマ〔文芸〕',
	303: '歴史〔文芸〕',
	304: '推理〔文芸〕',
	305: 'ホラー〔文芸〕',
	306: 'アクション〔文芸〕',
	307: 'コメディー〔文芸〕',
	// SF
	401: 'VRゲーム〔SF〕',
	402: '宇宙〔SF〕',
	403: '空想科学〔SF〕',
	404: 'パニック〔SF〕',
	// その他
	9901: '童話〔その他〕',
	9902: '詩〔その他〕',
	9903: 'エッセイ〔その他〕',
	9904: 'リプレイ〔その他〕',
	9999: 'その他〔その他〕',
	// ノンジャンル
	9801: 'ノンジャンル〔ノンジャンル〕',
});

/** 大ジャンル ID から表示名を取得 (未知 ID はフォールバック) */
export function getBigGenreName(id: number): string {
	return BIG_GENRE_NAMES[id] ?? 'その他';
}

/** ジャンル ID から表示名を取得 (未知 ID はフォールバック) */
export function getGenreName(id: number): string {
	return GENRE_NAMES[id] ?? 'その他';
}
