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
	 * embed HTML が **外部 media** (`<video>` / `<audio>`) を読み込む場合に、その配信元を CSP の
	 * `media-src` に追加するための origin 一覧 (例: `['https://drive.usercontent.google.com']`)。
	 *
	 * 既定の embed CSP は `default-src 'none'` で `<video src=外部URL>` をブロックするため、
	 * 自前の HTML5 video プレイヤーを返すプラグイン (google-drive) はここで読み込み元を宣言する。
	 *
	 * **契約**: 各要素は **origin (scheme + host[:port]) のみ**の `https:` URL であること
	 * (path / query / hash を含めると CSP ヘッダインジェクションの恐れ。embed 側で origin-only に再検証する)。
	 * 未設定なら `media-src` ディレクティブは追加されない (= 従来通り外部 media 不可)。
	 */
	mediaSrc?: string[];
}
