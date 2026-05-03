/**
 * 既定の Chrome 系ブラウザ UA。
 * 一部サイト（産経新聞、AbemaTV 等）はボット UA だとレスポンスが変化するため、
 * プラグイン側で `scpaping(url, { userAgent: BROWSER_UA, ... })` のように上書きする。
 *
 * バージョン番号はサイト側がより新しいバージョンを要求し始めたら更新する反応的方針。
 * 最終更新: 2026-05-03（Chrome 130 stable）
 */
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
