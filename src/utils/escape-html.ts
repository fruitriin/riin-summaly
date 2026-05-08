/**
 * HTML エスケープ utility。
 *
 * `/embed` エンドポイントでプラグインが HTML を組み立てる際、ユーザー入力 (API 由来の
 * title / writer / story 等) を **必ずエスケープしてから** 文字列連結する。Fastify 側は
 * エスケープしない契約 (プラグイン責任) のため、本関数を使うこと。
 *
 * **設計**: テンプレートライブラリを使わず文字列連結で組み立てる方針 (依存追加を避けるため)。
 * その代わり XSS 防衛は本関数のみに集約 — `escapeHtml` (text content 用) と `escapeAttr`
 * (属性値用) を分離して、呼出側が「どこに入れるか」を意識せざるを得ない設計にする。
 *
 * **CSP との二重防御**: `/embed` レスポンスは `default-src 'none'` で script を構造的に
 * ブロックしているが、本エスケープも独立して効かせる (defense-in-depth)。CSP が将来緩めば
 * エスケープが最後の防壁になる。
 */

/**
 * テキストコンテント (`<span>{x}</span>` の `{x}` 等) に挿入する文字列をエスケープする。
 * `&` `<` `>` `"` `'` の 5 文字を HTML entity に変換する (過剰でも害はない)。
 *
 * 用途:
 * - `<p>{escapeHtml(title)}</p>` の `{...}` 部分
 * - `<title>{escapeHtml(...)}</title>` の中身
 *
 * **注意**: 属性値 (`<a href="{...}">`) には `escapeAttr` を使うこと。
 * 本関数は **属性値クォート破壊攻撃** (`"` を `&quot;` にしない場合の HTML 構造破壊) を
 * 防ぐため `"` `'` も entity 化しているので属性値にも使えるが、用途を明確にして混乱を避ける。
 */
export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * 属性値 (`<a href="{...}">`) に挿入する文字列をエスケープする。
 *
 * `escapeHtml` と同じ実装を別名で提供する設計 (呼出側が「ここは属性値」と意識する)。
 * 属性値は **必ずダブルクォートで囲む** こと (`<a href="...">`)。シングルクォートは
 * テンプレートで `'` を使う場合に `&#39;` 化されないと破壊するためサポートしない。
 *
 * **注意**: URL 属性 (`href` / `src`) には `escapeAttr` だけでは不足。**スキーム検証**
 * (`https:` / `http:` 限定) を別途行うこと。`javascript:` / `data:` 等の悪性スキームを
 * `escapeAttr` で防ぐことはできない。
 */
export function escapeAttr(s: string): string {
	return escapeHtml(s);
}
