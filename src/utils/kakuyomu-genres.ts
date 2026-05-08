/**
 * カクヨム ジャンル enum (`Work.genre`) → 日本語ラベルのマッピング。
 *
 * カクヨムの `Work` エンティティには `genre: 'LOVE_STORY'` のような大文字スネーク enum が入っている。
 * 本マッピングは **公式ジャンルページ** (`https://kakuyomu.jp/genres/<slug>/recent_works` の
 * `itemprop="genre">` 内テキスト) から実取得した正確な対応関係。
 *
 * 検証ソース: `https://kakuyomu.jp/contests` ページに各ジャンル別の作品が載っており、
 * `/genres/<slug>` URL と日本語ラベルがセットで取れる。enum 値は URL slug を大文字化したものという
 * 仮説に基づく (実 `__NEXT_DATA__` で `genre: 'LOVE_STORY'` を観測済、URL slug `love_story` と一致)。
 *
 * 未知 enum は `'その他'` にフォールバックする (なろうの `getGenreName` と同パターン)。
 * 不足が見つかったら本ファイルにエントリを追加する。
 */

const GENRE_NAMES: Record<string, string> = {
	// /genres/love_story → 恋愛 (カクヨムは「異世界恋愛」「現代恋愛」を区別せず単一カテゴリ)
	LOVE_STORY: '恋愛',
	// /genres/romance → ラブコメ (恋愛と別枠で存在する)
	ROMANCE: 'ラブコメ',
	// /genres/fantasy → 異世界ファンタジー
	FANTASY: '異世界ファンタジー',
	// /genres/action → 現代ファンタジー (注意: enum 名は ACTION だが日本語は「現代ファンタジー」)
	ACTION: '現代ファンタジー',
	// /genres/sf → SF
	SF: 'SF',
	// /genres/horror → ホラー
	HORROR: 'ホラー',
	// /genres/mystery → ミステリー
	MYSTERY: 'ミステリー',
	// /genres/drama → 現代ドラマ
	DRAMA: '現代ドラマ',
	// /genres/history → 歴史・時代・伝奇
	HISTORY: '歴史・時代・伝奇',
	// /genres/criticism → 創作論・評論
	CRITICISM: '創作論・評論',
	// /genres/nonfiction → エッセイ・ノンフィクション
	NONFICTION: 'エッセイ・ノンフィクション',
	// /genres/others → 詩・童話・その他
	OTHERS: '詩・童話・その他',
};

/**
 * カクヨム ジャンル enum を日本語ラベルに変換する。
 * 未知の enum は `'その他'` を返す (= `composeDescription` で「ジャンル: その他」と表示される)。
 */
export function getKakuyomuGenreName(genre: string): string {
	return GENRE_NAMES[genre] ?? 'その他';
}
