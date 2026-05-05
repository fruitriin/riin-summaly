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
			{ label: 'amzn.asia 短縮', url: 'https://amzn.asia/d/00K7piwG', note: '⚠ HEAD リダイレクトが解決されず短縮 URL のまま汎用パスに落ちる既知の挙動。要調査' },
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
		name: 'branchio-deeplinks',
		description: '$web_only=true で実 Web ページに飛ばす',
		urls: [
			{ label: 'spotify.link', url: 'https://spotify.link/example', note: '存在する短縮 URL を都度差し替え' },
		],
	},
	{
		name: 'dlsite / iwara / komiflo / nijie',
		description: 'NSFW 対応プラグイン（sensitive 判定の動作確認）',
		urls: [
			{ label: 'DLsite work', url: 'https://www.dlsite.com/app/work/=/product_id/RJ01355633.html' },
			{ label: 'iwara video', url: 'https://www.iwara.tv/video/example', note: '差し替え用テンプレ' },
			{ label: 'komiflo comic', url: 'https://komiflo.com/comics/123456', note: '差し替え用テンプレ' },
			{ label: 'nijie view', url: 'https://nijie.info/view.php?id=123456', note: '差し替え用テンプレ' },
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
