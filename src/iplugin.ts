import type Summary from '@/summary.js';
import type { GeneralScrapingOptions } from '@/general.js';

export interface SummalyPlugin {
	/**
	 * プラグイン名。allowedPlugins 等のキーやキャッシュキー用に利用する。
	 * 組み込みプラグインではファイル名（拡張子なし）と一致させる。
	 * 既存外部プラグインの破壊的変更を避けるため optional。
	 */
	name?: string;
	test: (url: URL) => boolean;
	summarize: (url: URL, opts?: GeneralScrapingOptions) => Promise<Summary | null>;
	/**
	 * **`summaly()` の初期 `resolveRedirect` (HEAD/GET probe) をスキップさせる宣言**。
	 *
	 * `true` を宣言すると、URL が初期段階で本プラグインの `test()` にマッチした場合に限り、
	 * `summaly()` 冒頭の HEAD/GET によるリダイレクト解決を **完全にスキップ**する。
	 *
	 * **用途**: yodobashi のように **TLS layer で bot を切断するサイト** + **URL が終端確定**
	 * (短縮 URL でない / リダイレクト不要) のケースで、HEAD/GET probe が timeout
	 * (デフォルト 20 秒) で空回りする純損失を回避する。
	 *
	 * **注意**: 短縮 URL を扱うプラグイン (`branchio-deeplinks` 等) や、`amzn.asia` のような
	 * 短縮形を含む URL を受けるプラグイン (amazon) では絶対に有効化しないこと。
	 * 終端 URL でないとプラグインが正しく動かない。
	 */
	skipRedirectResolution?: boolean;

	/**
	 * **`/embed` エンドポイント用 HTML 生成**。
	 *
	 * 実装すると summaly Fastify モードが `GET /embed?url=<URL>` にマッチした URL に対して、
	 * 本関数の HTML をレスポンスとして返すようになる。プラグインが `test(url) === true`
	 * かつ `renderEmbed` を実装し、かつ `[embed].allowedPlugins` に含まれている場合のみ有効。
	 *
	 * **XSS / CSP 設計の契約**:
	 * - 戻り値の `body` は **完全な HTML5 ドキュメント** (`<!DOCTYPE html>...</html>`)
	 * - **すべてのユーザー入力は `escapeHtml` / `escapeAttr` でエスケープ済みである**こと
	 *   (Fastify 側はエスケープしない、プラグイン側が責任を持つ契約)
	 * - **`<script>` を含めてはならない** (CSP `default-src 'none'` で実行されないが、混入を許す設計にしない)
	 * - 外部リソース (画像/フォント/外部 CSS) は CSP で制限される — `default-src 'none'`、
	 *   `img-src https:`、`style-src 'unsafe-inline'`、`font-src 'none'`
	 *
	 * **width / height の意味**: Misskey は `padding-bottom: height/width * 100%` で
	 * iframe のアスペクト比を計算する。絶対値ではなく **比率** として効く (例: `width: 3, height: 2`
	 * で 3:2 アスペクト)。コンテナ幅にレスポンシブで伸縮する。
	 */
	renderEmbed?: (url: URL, opts?: GeneralScrapingOptions) => Promise<EmbedRenderResult>;
}

/**
 * `SummalyPlugin.renderEmbed` の戻り値。
 */
export interface EmbedRenderResult {
	/**
	 * 完全な HTML5 ドキュメント (`<!DOCTYPE html>...`)。
	 * **すべてのユーザー入力はエスケープ済みであること** (プラグイン側責任)。
	 */
	body: string;

	/** プレイヤーの推奨幅 (アスペクト比計算用、絶対値は無視される) */
	width: number;

	/** プレイヤーの推奨高さ (アスペクト比計算用、絶対値は無視される) */
	height: number;

	/**
	 * embed HTML が **外部リソース (iframe / media 等) を埋め込む** 場合に、許可する配信元を
	 * **CSP ディレクティブ名 → origin 配列** のマップで宣言する。
	 *
	 * 既定の embed CSP は `default-src 'none'` で外部リソースをブロックするため、外部プレイヤーを
	 * ラップするプラグインはここで「どのディレクティブにどの origin を足すか」を宣言する。
	 * embed エンドポイントが各 origin を **origin-only に再検証** して CSP に反映する。
	 *
	 * 例: `{ 'frame-src': ['https://drive.google.com'] }` (Drive `/preview` を iframe ラップ)。
	 * 将来 `<video>` 等を埋めるプラグインは `{ 'media-src': [...] }` を足すだけで、embed 側のコード変更不要。
	 *
	 * **契約**: 各 origin 値は **origin (scheme + host[:port]) のみ**の `https:` URL であること
	 * (path / query / hash / `;` を含めると CSP ヘッダインジェクションの恐れ。embed 側で再検証する)。
	 * ディレクティブ名は許可リスト (`frame-src` / `media-src` 等) で制限される。未設定なら追加なし。
	 */
	cspDirectives?: Record<string, string[]>;
}
