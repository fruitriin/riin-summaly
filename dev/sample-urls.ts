/**
 * Dev サーバの「ワンクリック URL リスト」用サンプル URL 集。
 * 各組み込みプラグイン + 汎用パスの動作確認用。
 *
 * URL は陳腐化することがあるので、気付いたタイミングで更新する。
 */

export type SampleUrl = {
	label: string;
	url: string;
	note?: string;
	/**
	 * クリック時にフォームへ自動適用する presets。
	 * チェックボックスや `allowedPlugins` を設定する必要があるサンプル用。
	 */
	presets?: {
		enablePdf?: boolean;
		useRange?: boolean;
		allowedPlugins?: string[];
		/** phase12.1 — proxy fallback を有効化したいサンプル (Amazon class IP block) */
		proxy?: boolean;
	};
};

export type SampleGroup = {
	name: string;
	description: string;
	urls: SampleUrl[];
};

export const sampleGroups: SampleGroup[] = [
	{
		name: 'youtube',
		description: 'oEmbed 直叩き高速パス（player iframe を含む）',
		urls: [
			{ label: 'YouTube watch', url: 'https://www.youtube.com/watch?v=NMIEAhH_fTU' },
			{ label: 'YouTube shorts', url: 'https://www.youtube.com/shorts/aqz-KE-bpKQ' },
			{ label: 'YouTube live', url: 'https://www.youtube.com/live/YVjfasn756M', note: 'phase12.2 で `/live/<id>` も oEmbed 経路に乗るようになった' },
			{ label: 'youtu.be 短縮', url: 'https://youtu.be/NMIEAhH_fTU', note: 'KNOWN_SHORT_HOSTS の dispatcher 検証' },
		],
	},
	{
		name: 'spotify',
		description: 'oEmbed 経由（player iframe を含む）',
		urls: [
			{ label: 'Spotify track', url: 'https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh' },
			{ label: 'Spotify album', url: 'https://open.spotify.com/album/4yP0hdKOZPNshxUOjY0cZj' },
		],
	},
	{
		name: 'google-drive',
		description: '共有ファイルの /preview を player iframe に組み立て（動画 / PDF / 画像 / Docs）',
		urls: [
			{ label: 'Drive 横動画', url: 'https://drive.google.com/file/d/11osMpfxFZOwWH6m0MKevA5S8x4q4Bkt3/view?usp=sharing', note: 'オーナー提供 (2026-06-01)' },
			{ label: 'Drive 縦動画', url: 'https://drive.google.com/file/d/109c4LMg9MaCkbzNtz_JkSHKeZuYBxHvC/view?usp=sharing', note: 'オーナー提供 (2026-06-01)' },
		],
	},
	{
		name: 'wikipedia',
		description: 'MediaWiki API から intro 抽出',
		urls: [
			{ label: 'Wikipedia (ja)', url: 'https://ja.wikipedia.org/wiki/Misskey' },
			{ label: 'Wikipedia (en)', url: 'https://en.wikipedia.org/wiki/KISS_principle' },
		],
	},
	{
		name: 'amazon',
		description: 'DOM 直接読み（OG/Twitter Card に頼らない）',
		urls: [
			{ label: 'Amazon JP', url: 'https://www.amazon.co.jp/dp/4297127830' },
			{ label: 'amzn.asia 短縮', url: 'https://amzn.asia/d/00K7piwG', note: 'HEAD 失敗時 GET fallback (phase9.1) で展開される' },
		],
	},
	{
		name: 'amazon (proxy fallback / phase12.1)',
		description: 'Vultr Tokyo IP からは 500 が返るため CF Workers proxy 経由で救援する。proxy fallback checkbox は env (SUMMALY_PROXY_URL + SUMMALY_PROXY_SECRET) が両方セットされていれば自動表示',
		urls: [
			{
				label: 'Amazon JP (proxy 経由 — IP block 救援)',
				url: 'https://www.amazon.co.jp/dp/B0C4LRBFX6',
				note: 'クリックで proxy fallback を自動 ON。env が無いと checkbox は非表示',
				presets: { proxy: true },
			},
		],
	},
	{
		name: 'bluesky',
		description: 'GET 強制（HEAD で 404 になる対策）',
		urls: [
			{ label: 'Bluesky post', url: 'https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l' },
		],
	},
	{
		name: 'twitter (X)',
		description: 'cdn.syndication.twimg.com から JSON 取得（仕様変更で壊れうる）。player は null（Misskey 側「ポストを展開」と重複しないように）',
		urls: [
			{ label: '@jack 最初のツイート', url: 'https://twitter.com/jack/status/20' },
			{ label: 'X ホスト名でも OK', url: 'https://x.com/jack/status/20' },
		],
	},
	{
		name: 'branchio-deeplinks',
		description: '$web_only=true で実 Web ページに飛ばす',
		urls: [
			{ label: 'spotify.link', url: 'https://spotify.link/example', note: '存在する短縮 URL を都度差し替え' },
		],
	},
	{
		name: 'yodobashi (phase12.4 — proxy 経由必須)',
		description: 'TLS / HTTP/2 レイヤで bot 切断するため UA レイヤでは救えない。proxy fallback で CF Workers の egress IP / TLS フィンガープリント経由で救援を試みる。env で proxy 設定 + checkbox ON が必要',
		urls: [
			{ label: 'ヨドバシ商品ページ', url: 'https://www.yodobashi.com/product/100000001003176109/', presets: { proxy: true }, note: '本番運用では Worker と summaly 両側 allowlist に yodobashi.com 必須' },
		],
	},
	{
		name: 'nitori (phase15.4 — JSON API + curl_cffi 直行)',
		description: 'TLS layer + UA layer の二重 bot block + JS 動的 OGP 注入の三重壁。HTML scraping 不能 (fail mode I) だが公式 SAP Commerce OCC API を curl_cffi (Chrome JA3 偽装) 経由で直叩きすると完璧な構造化データが返る',
		urls: [
			{ label: 'ニトリ商品 (Nクール ぬいぐるみ)', url: 'https://www.nitori-net.jp/ec/product/2116100013272s/', note: '本番運用では [scraping.curl_cffi].enabled = true + bootstrap.jsonl の nitori-net.jp → curl_cffi エントリが必須' },
		],
	},
	{
		name: 'sqex (phase12.6 — SQEX e-STORE / proxy 直行)',
		description: 'データセンター IP 全般を CDN 段で広く弾くため、Vultr 本番から直叩きすると HTTP 200 + 正規 404 ページボディが返る。エラーシグナル無しの IP block なので forceProxyFallback で最初から proxy 経由に行く',
		urls: [
			{ label: 'SQEX 商品ページ', url: 'https://store.jp.square-enix.com/item/MWFF140773_2.html', presets: { proxy: true }, note: '本番では Worker と summaly 両側 allowlist に store.jp.square-enix.com 必須' },
			{ label: 'SQEX 短縮 URL (sqex.to)', url: 'https://sqex.to/ZjZdX', presets: { proxy: true }, note: 'HEAD で store.jp.square-enix.com に解決された後 sqex プラグインがマッチ' },
		],
	},
	{
		name: 'nintendo-store (phase12.3)',
		description: 'Akamai Bot Manager 配下だが facebookexternalhit UA は allowlist されているので、UA 切り替えで OGP 取得',
		urls: [
			{ label: 'My Nintendo Store JP', url: 'https://store-jp.nintendo.com/item/software/D70010000096249' },
		],
	},
	{
		name: 'npmjs (Registry API)',
		description: 'Cloudflare 配下の HTML を諦めて Registry API (registry.npmjs.org) を直叩き（phase11.4）',
		urls: [
			{ label: 'npm パッケージ', url: 'https://www.npmjs.com/package/mfm-renderer' },
			{ label: 'scoped パッケージ', url: 'https://www.npmjs.com/package/@misskey-dev/summaly' },
			{ label: '/v/<ver> サブパス', url: 'https://www.npmjs.com/package/react/v/19.0.0', note: 'バージョン指定でも latest が返る' },
		],
	},
	{
		name: 'dlsite / iwara / komiflo / nijie / dmm',
		description: 'NSFW 対応プラグイン（sensitive 判定 + card 抑制 + embed フル表示の二層構造、phase15.6 で 5 プラグイン共通化）',
		urls: [
			{ label: 'DLsite work (sensitive 経路)', url: 'https://www.dlsite.com/app/work/=/product_id/RJ01355633.html', note: 'phase15.6 — /app/ は sensitive=true → card 抑制 + embed フル表示。/comic/ は素通し' },
			{ label: 'iwara video', url: 'https://www.iwara.tv/video/example', note: '差し替え用テンプレ。phase15.6 followup — www. / ecchi. 問わず全件 sensitive=true 強制で抑制発火' },
			{ label: 'komiflo comic', url: 'https://komiflo.com/comics/123456', note: '差し替え用テンプレ。phase15.6 — API 取得成功で card 抑制 + embed フル表示' },
			{ label: 'nijie view', url: 'https://nijie.info/view.php?id=123456', note: '差し替え用テンプレ。phase15.6 — /view.php 着地で card 抑制 + embed フル表示' },
			{ label: 'FANZA video (dmm)', url: 'https://video.dmm.co.jp/av/content/?id=ailb00009', note: 'phase15.3 → 15.5 → 15.6 — card は title 「【FANZA】...」 / description 「【R-18】 内容を伏せています」 / thumbnail null。embed iframe で作品サムネ + あらすじフル表示' },
			{ label: 'FANZA 同人 (dmm)', url: 'https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_738103/', note: 'phase15.5 → 15.6 — 同人作品の card 抑制 + embed フル表示の確認用' },
		],
	},
	{
		name: '汎用パス',
		description: 'プラグインがマッチしない普通のサイト（OG / Twitter Card / fallback）',
		urls: [
			{ label: 'Misskey docs', url: 'https://misskey-hub.net/' },
			{ label: 'GIGAZINE 風 OG ページ', url: 'https://gigazine.net/news/20240101-test/', note: '実在 URL に差し替えて検証' },
		],
	},
	{
		name: 'PDF (enablePdf)',
		description: 'クリックで `enablePdf: true` を自動 ON。クリック前のチェックボックス操作不要',
		urls: [
			{
				label: 'Sample PDF',
				url: 'https://www.adobe.com/support/products/enterprise/knowledgecenter/media/c4611_sample_explain.pdf',
				presets: { enablePdf: true },
			},
		],
	},
];

// 組み込みプラグイン名は `src/plugins/index.ts` から動的に取得する（手動同期漏れ回避）。
// dev/server.ts で `builtinPlugins.map(p => p.name).filter(...)` として読み出す。
