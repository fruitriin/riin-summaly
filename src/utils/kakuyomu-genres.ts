/**
 * カクヨム ジャンル enum (`Work.genre`) → 日本語ラベルのマッピング (phase15.2)。
 *
 * カクヨムの `Work` エンティティには `genre: 'LOVE_STORY'` のような大文字スネーク enum が入っている。
 * 公式の網羅リストは公開されていないため、実観測 + 公式ジャンル URL (`/genres/<slug>`) から推測した
 * 集合を初期マップとする。未知 enum は `'その他'` にフォールバックする (なろうの `getGenreName` と同パターン)。
 *
 * 不足が見つかったら本ファイルにエントリを追加する (本番 parse-failure-log で「未知 enum」を観測しやすい設計)。
 */

const GENRE_NAMES: Record<string, string> = {
	// 恋愛系
	LOVE_STORY: '異世界恋愛',
	ROMANCE: '現代恋愛',
	// ファンタジー系
	FANTASY: '異世界ファンタジー',
	HIGH_FANTASY: '異世界ファンタジー',
	LOW_FANTASY: '現代ファンタジー',
	// 主要ジャンル
	SF: 'SF',
	ACTION: 'アクション',
	HORROR: 'ホラー',
	MYSTERY: 'ミステリー',
	HISTORY: '歴史・時代・伝奇',
	HUMOR: 'ユーモア・コメディ',
	DRAMA: '現代ドラマ',
	// その他系
	ESSAY_NONFICTION: 'エッセイ・ノンフィクション',
	NONFICTION: 'ノンフィクション',
	CRITIQUE: '創作論・評論',
	POEM_FAIRY_OTHER: '詩・童話・その他',
	OTHERS: 'その他',
	OTHER: 'その他',
};

/**
 * カクヨム ジャンル enum を日本語ラベルに変換する。
 * 未知の enum は `'その他'` を返す (= `composeDescription` で「ジャンル: その他」と表示される)。
 */
export function getKakuyomuGenreName(genre: string): string {
	return GENRE_NAMES[genre] ?? 'その他';
}
